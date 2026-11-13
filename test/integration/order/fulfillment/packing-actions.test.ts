import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import type { MarketplacePackages } from '#src/modules/order/fulfillment/service/packages.ts';
import { currentCompanyId } from '#src/shared/db/client.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, outboxOf, packageRow, packingApp, seedPackage, stockOfVariant, transitionsOf } from './helpers.ts';

let companyId: string;
let warehouse: string;
let sale: string;
let variantId: string;
let shopId: string;
beforeAll(async () => {
  ({ companyId } = await createCompany());
  warehouse = (await addMember(companyId, 'warehouse')).token;
  sale = (await addMember(companyId, 'sale')).token;
  variantId = (await createVariant(companyId)).variantId;
  await receive(companyId, variantId, 100, 100_000);
  shopId = await channelShop(companyId, false);
});

type Options = Partial<Parameters<typeof seedPackage>[1]>;
const seed = (status: Options['status'] & string, opts: Options = {}) =>
  seedPackage(companyId, { status, shopId, lines: [{ variantId, quantity: 2, reserved: status === 'reserved' }], ...opts });

const post = (id: string, action: 'pack' | 'ready' | 'open', body: object, fake: Partial<MarketplacePackages> = {}, token = warehouse) =>
  packingApp(fake).post(`/api/v1/fulfillment/packages/${id}/${action}`).set('Authorization', `Bearer ${token}`).send(body);
const expectProblem = (res: Awaited<ReturnType<typeof post>>, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
};
const packBody = () => ({ version: 1, lines: [{ variantId, quantity: 2 }] });
const packed = { packageCode: 'FP1', trackingCode: 'LZ1', carrier: null };
const ready = () => vi.fn(async () => { expect(currentCompanyId()).toBeNull(); });

describe('đóng gói kiện', () => {
  it('D2-03 US-DH-06 AC2: đóng gói qua sàn ngoài giao dịch, lưu vận đơn, dòng kiện, lịch sử và sự kiện', async () => {
    const { packageId, orderId } = await seed('reserved');
    const pack = vi.fn(async () => {
      expect(currentCompanyId()).toBeNull();
      return { ...packed, carrier: { code: 'LEX', name: 'LEX VN' } };
    });
    const res = await post(packageId, 'pack', { ...packBody(), carrierCode: 'LEX' }, { pack });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Package.parse(res.body)).toMatchObject({
      status: 'packed', platformPackageCode: 'FP1', trackingCode: 'LZ1', carrier: { code: 'LEX', name: 'LEX VN' },
    });
    expect(pack).toHaveBeenCalledWith(companyId, shopId, expect.objectContaining({ carrierCode: 'LEX', externalLineIds: [expect.any(String)] }));
    const { rows } = await testPool().query(`select packed_qty from "order".package_lines where package_id = $1`, [packageId]);
    expect(rows).toEqual([{ packed_qty: 2 }]);
    expect(await transitionsOf(packageId)).toEqual([expect.objectContaining({ action: 'pack', source: 'user' })]);
    expect(await outboxOf(orderId, 'fulfillment.package_status_changed')).toContainEqual({ packageId, orderId, from: 'reserved', to: 'packed' });
  });

  it('kiện đơn tay đóng gói mà không gọi sàn', async () => {
    const { packageId } = await seedPackage(companyId, { status: 'reserved', manual: true, lines: [{ variantId, quantity: 2, reserved: true }] });
    const res = await post(packageId, 'pack', packBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'packed', carrier: null });
  });

  it('D2-03g: đơn chưa xử lý bị chặn trước khi gọi sàn', async () => {
    const { packageId } = await seed('reserved', { orderStatus: 'unpaid' });
    expectProblem(await post(packageId, 'pack', packBody()), 409, 'order_not_processing');
  });

  it('US-DH-06 AC3: lệch số quét báo lỗi theo biến thể', async () => {
    const { packageId } = await seed('reserved');
    const res = await post(packageId, 'pack', { version: 1, lines: [] });
    expectProblem(res, 422, 'scan_mismatch');
    expect(res.body.errors[`lines.${variantId}`]).toBeDefined();
  });

  it.each([[422, 'validation_failed'], [409, 'item_not_packable'], [409, 'shop_not_connected']] as const)('sàn từ chối %s %s, giữ nguyên kiện', async (status, code) => {
    const { packageId } = await seed('reserved');
    const pack = async () => { throw new AppError(status, code, 'Sàn từ chối', { errors: { carrierCode: 'Chọn nhà vận chuyển' } }); };
    const res = await post(packageId, 'pack', packBody(), { pack });
    expectProblem(res, status, code);
    if (status === 422) expect(res.body.errors.carrierCode).toBeDefined();
    expect(await packageRow(packageId)).toMatchObject({ status: 'reserved', version: 1 });
  });

  it('sai phiên bản trả bản kiện hiện tại', async () => {
    const { packageId } = await seed('reserved');
    const res = await post(packageId, 'pack', { ...packBody(), version: 5 });
    expectProblem(res, 409, 'version_conflict');
    expect(Package.parse(res.body.current)).toMatchObject({ id: packageId, version: 1 });
  });

  it('hai lần bấm đồng thời chỉ gọi sàn một lần', async () => {
    const { packageId } = await seed('reserved');
    const pack = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return packed;
    });
    const responses = await Promise.all([post(packageId, 'pack', packBody(), { pack }), post(packageId, 'pack', packBody(), { pack })]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(pack).toHaveBeenCalledTimes(1);
    expectProblem(responses.find((res) => res.status === 409)!, 409, 'version_conflict');
  });

  it('lượt kéo đơn đã áp packed cùng mã: trả kiện và giữ một dòng lịch sử', async () => {
    const { packageId } = await seed('reserved');
    const pack = async () => {
      await testPool().query(`update "order".packages set status = 'packed', platform_package_code = 'FP1', version = version + 1 where id = $1`, [packageId]);
      await testPool().query(`insert into core.state_transitions (company_id, entity_type, entity_id, from_state, to_state, action, source)
        values ($1, 'packages', $2, 'reserved', 'packed', 'pack', 'marketplace')`, [companyId, packageId]);
      return packed;
    };
    const res = await post(packageId, 'pack', packBody(), { pack });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('packed');
    expect(await transitionsOf(packageId)).toHaveLength(1);
  });

  it('kiện chỉ có dòng chưa ghép vẫn đóng gói với số quét rỗng', async () => {
    const { packageId } = await seed('reserved', { lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: variantId });
    const pack = vi.fn(async () => packed);
    const res = await post(packageId, 'pack', { version: 1, lines: [] }, { pack });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(pack).toHaveBeenCalledWith(companyId, shopId, expect.objectContaining({ externalLineIds: [expect.any(String)] }));
  });

  it('đóng gói nhóm bị chặn bởi đơn chưa trả, đi tiếp khi kiện kia đã đóng', async () => {
    const { packageId } = await seed('reserved', { platformPackageCode: 'GROUP-PACK' });
    const other = await seed('reserved', { platformPackageCode: 'GROUP-PACK', orderStatus: 'unpaid' });
    const blocked = await post(packageId, 'pack', packBody());
    expectProblem(blocked, 409, 'package_group_not_ready');
    expect(blocked.body.detail).toContain(other.packageCode);
    await testPool().query(`update "order".orders set status = 'processing' where id = $1`, [other.orderId]);
    await testPool().query(`update "order".packages set status = 'packed' where id = $1`, [other.packageId]);
    expect((await post(packageId, 'pack', packBody(), { pack: async () => ({ ...packed, packageCode: 'GROUP-PACK' }) })).status).toBe(200);
  });
});

describe('báo sẵn sàng giao', () => {
  it('D2-04 US-DH-07 AC1: gửi đúng mã kiện và ghi lịch sử', async () => {
    const { packageId } = await seed('packed', { platformPackageCode: 'FP-RTS' });
    const readyToShip = ready();
    const res = await post(packageId, 'ready', { version: 1 }, { readyToShip });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Package.parse(res.body).status).toBe('awaiting_pickup');
    expect(readyToShip).toHaveBeenCalledWith(companyId, shopId, 'FP-RTS');
    expect(await transitionsOf(packageId)).toEqual([expect.objectContaining({ action: 'mark_ready' })]);
  });

  it('D2-04g: kiện tự giao bị chặn trước khi gọi sàn', async () => {
    const { packageId } = await seed('packed', { selfDelivery: true, platformPackageCode: 'FP-SELF' });
    expectProblem(await post(packageId, 'ready', { version: 1 }), 409, 'self_delivery');
  });

  it('D2-04q: Sale không được báo sẵn sàng giao', async () => {
    const { packageId } = await seed('packed');
    expectProblem(await post(packageId, 'ready', { version: 1 }, {}, sale), 403, 'forbidden');
  });

  it.each([[503, 'marketplace_unavailable'], [409, 'marketplace_unauthorized'], [409, 'shop_not_connected']] as const)('sàn trả %s %s, bật cờ tới khi lần sau thành công', async (status, code) => {
    const { packageId } = await seed('packed', { platformPackageCode: `RTS-${code}` });
    const readyToShip = async () => { throw new AppError(status, code, 'Lỗi báo sẵn sàng'); };
    expectProblem(await post(packageId, 'ready', { version: 1 }, { readyToShip }), status, code);
    const { rows } = await testPool().query(`select status, label_error, version from "order".packages where id = $1`, [packageId]);
    expect(rows[0]).toEqual({ status: 'packed', label_error: true, version: 2 });
    const res = await post(packageId, 'ready', { version: 2 }, { readyToShip: ready() });
    expect(res.status).toBe(200);
    expect(res.body.flags).not.toContain('label_error');
  });

  it('kiện thiếu mã sàn báo lỗi, kiện đơn tay đi tiếp', async () => {
    const { packageId } = await seed('packed');
    expectProblem(await post(packageId, 'ready', { version: 1 }), 409, 'rts_package_not_found');
    const manual = await seedPackage(companyId, { status: 'packed', manual: true, lines: [{ variantId, quantity: 1 }] });
    const res = await post(manual.packageId, 'ready', { version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_pickup');
  });

  it('lượt kéo đơn đã áp awaiting_pickup trong lúc gọi sàn', async () => {
    const { packageId } = await seed('packed', { platformPackageCode: 'RTS-PULL' });
    const readyToShip = async () => {
      await testPool().query(`update "order".packages set status = 'awaiting_pickup', version = version + 1 where id = $1`, [packageId]);
    };
    const res = await post(packageId, 'ready', { version: 1 }, { readyToShip });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_pickup');
    expect(await transitionsOf(packageId)).toEqual([]);
  });

  it('nhóm phải đóng đủ, gọi sàn một lần rồi chuyển cả nhóm', async () => {
    const first = await seed('packed', { platformPackageCode: 'GROUP-READY' });
    const second = await seed('reserved', { platformPackageCode: 'GROUP-READY' });
    expectProblem(await post(first.packageId, 'ready', { version: 1 }), 409, 'package_group_not_ready');
    await testPool().query(`update "order".packages set status = 'packed' where id = $1`, [second.packageId]);
    const readyToShip = ready();
    const res = await post(first.packageId, 'ready', { version: 1 }, { readyToShip });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readyToShip).toHaveBeenCalledTimes(1);
    for (const pkg of [first, second]) {
      expect((await packageRow(pkg.packageId)).status).toBe('awaiting_pickup');
      expect(await transitionsOf(pkg.packageId)).toEqual([expect.objectContaining({ action: 'mark_ready' })]);
    }
  });

  it('hai kiện cùng nhóm được báo sẵn sàng đồng thời chỉ gửi một lệnh lên sàn', async () => {
    const first = await seed('packed', { platformPackageCode: 'GROUP-RACE' });
    const second = await seed('packed', { platformPackageCode: 'GROUP-RACE' });
    const readyToShip = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    const result = await Promise.all([first, second].map((pkg) => post(pkg.packageId, 'ready', { version: 1 }, { readyToShip })));
    expect(result.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(readyToShip).toHaveBeenCalledTimes(1);
  });
});

describe('mở lại kiện', () => {
  it('repack Lazada, xoá mã vận đơn và nhà vận chuyển, vẫn giữ đủ hàng', async () => {
    const { packageId } = await seed('packed', { platformPackageCode: 'REPACK', trackingCode: 'AWB', lines: [{ variantId, quantity: 2, reserved: true }] });
    await testPool().query(`update "order".packages set carrier_code = 'LEX', carrier_name = 'LEX VN', label_error = true where id = $1`, [packageId]);
    await testPool().query(`update "order".package_lines set packed_qty = quantity where package_id = $1`, [packageId]);
    const stock = await stockOfVariant(companyId, variantId);
    const repack = vi.fn(async () => 'repacked' as const);
    const res = await post(packageId, 'open', { version: 1 }, { repack });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'reserved', carrier: null, platformPackageCode: null, trackingCode: null });
    expect(res.body.flags).not.toContain('label_error');
    expect(repack).toHaveBeenCalledWith(companyId, shopId, 'REPACK');
    const { rows } = await testPool().query(`select packed_qty, reserved_qty from "order".package_lines where package_id = $1`, [packageId]);
    expect(rows).toEqual([{ packed_qty: 0, reserved_qty: 2 }]);
    expect(await stockOfVariant(companyId, variantId)).toEqual(stock);
  });

  it('TikTok giữ mã kiện khi cổng trả not_supported', async () => {
    const { packageId } = await seed('packed', { platformPackageCode: 'KEEP', lines: [{ variantId, quantity: 2, reserved: true }] });
    const res = await post(packageId, 'open', { version: 1 }, { repack: async () => 'not_supported' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'reserved', platformPackageCode: 'KEEP' });
  });

  it('mở kiện chưa giữ hàng thì giữ đủ và phát allocation_done', async () => {
    const { packageId } = await seed('packed');
    const res = await post(packageId, 'open', { version: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('reserved');
    expect(await outboxOf(companyId, 'fulfillment.allocation_done')).toContainEqual({ variantIds: [variantId] });
  });

  it('thiếu hàng và chờ kiểm kê đều bị chặn trước khi repack', async () => {
    const absent = (await createVariant(companyId)).variantId;
    const insufficient = await seed('packed', { platformPackageCode: 'NO-STOCK', lines: [{ variantId: absent, quantity: 1 }] });
    expectProblem(await post(insufficient.packageId, 'open', { version: 1 }), 422, 'insufficient_stock');
    expect(await packageRow(insufficient.packageId)).toMatchObject({ status: 'packed', version: 1 });
    const waiting = await seed('packed', { shopId: await channelShop(companyId, true), platformPackageCode: 'WAIT-STOCK' });
    expectProblem(await post(waiting.packageId, 'open', { version: 1 }), 409, 'shop_awaiting_stocktake');
  });

  it('kiện đã báo giao, sai phiên bản và lỗi repack giữ nguyên trạng thái', async () => {
    const pickup = await seed('awaiting_pickup', { platformPackageCode: 'OPEN-RTS' });
    expectProblem(await post(pickup.packageId, 'open', { version: 1 }), 409, 'invalid_transition');
    const { packageId } = await seed('packed', { platformPackageCode: 'REPACK-FAIL', lines: [{ variantId, quantity: 2, reserved: true }] });
    expectProblem(await post(packageId, 'open', { version: 5 }), 409, 'version_conflict');
    const repack = async () => { throw new AppError(409, 'package_status_not_allowed', 'Sàn từ chối'); };
    expectProblem(await post(packageId, 'open', { version: 1 }, { repack }), 409, 'package_status_not_allowed');
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', version: 1, platform_package_code: 'REPACK-FAIL' });
  });
});
