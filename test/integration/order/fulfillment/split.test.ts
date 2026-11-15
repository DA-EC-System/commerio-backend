// Tách kiện trong app (spec 205 §5.4, Documents/21 §19.2, US-DH-19). Mã ca `D2-Snn` theo Documents/26 §3.2, `ACn` theo spec 205 §9.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import type { MarketplacePackages } from '#src/modules/order/fulfillment/service/packages.ts';
import { Order } from '#src/modules/order/sales/api/schemas.ts';
import { currentCompanyId } from '#src/shared/db/client.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, outboxOf, packageRow, packingApp, seedPackage, stockOfVariant, transitionsOf } from './helpers.ts';

let companyId: string;
let warehouse: string;
let admin: string;
let sale: string;
let white: string;
let jeans: string;
let blue: string;
let red: string;
let shopId: string;
beforeAll(async () => {
  ({ companyId } = await createCompany());
  warehouse = (await addMember(companyId, 'warehouse')).token;
  admin = (await addMember(companyId, 'admin')).token;
  sale = (await addMember(companyId, 'sale')).token;
  [white, jeans, blue, red] = await Promise.all([1, 2, 3, 4].map(async () => (await createVariant(companyId)).variantId)) as [string, string, string, string];
  for (const v of [white, jeans, blue]) await receive(companyId, v, 50, 100_000);
  shopId = await channelShop(companyId, false);
});

const unit = () => ({
  splitLevel: vi.fn(async () => {
    expect(currentCompanyId()).toBeNull();
    return 'unit' as const;
  }),
});
const split = (id: string, body: object, fake: Partial<MarketplacePackages> = unit(), token = warehouse) =>
  packingApp(fake).post(`/api/v1/fulfillment/packages/${id}/split`).set('Authorization', `Bearer ${token}`).send(body);
const expectProblem = (res: Awaited<ReturnType<typeof split>>, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
};
const one = (variantId: string | null, opts: { quantity?: number; reserved?: boolean } = {}) =>
  ({ variantId, quantity: opts.quantity ?? 1, reserved: opts.reserved ?? false });
const versionOf = async (id: string) => (await packageRow(id)).version;

async function otherPackages(orderId: string, packageId: string) {
  const { rows } = await testPool().query<{ id: string; code: string; status: string; platform_package_code: string | null; reserved_at: Date | null }>(
    `select id, code, status, platform_package_code, reserved_at from "order".packages where order_id = $1 and id <> $2 order by code`,
    [orderId, packageId],
  );
  return rows;
}

async function linesOf(packageId: string) {
  const { rows } = await testPool().query<{ variant_id: string | null; quantity: number; reserved_qty: number }>(
    'select variant_id, quantity, reserved_qty from "order".package_lines where package_id = $1 order by created_at, id',
    [packageId],
  );
  return rows;
}

async function packageCount(orderId: string) {
  const { rows } = await testPool().query<{ n: number }>('select count(*)::int as n from "order".packages where order_id = $1', [orderId]);
  return rows[0]!.n;
}

async function reasonOf(packageId: string, action: string) {
  const { rows } = await testPool().query<{ reason: string | null; actor_id: string | null }>(
    `select reason, actor_id from core.state_transitions where entity_type = 'packages' and entity_id = $1 and action = $2 order by id`,
    [packageId, action],
  );
  return rows;
}

describe('tách kiện, nhánh unit (spec 205 §5.4)', () => {
  it('D2-S01 AC1: kiện backordered tách món hết hàng ra, kiện cũ giữ được hàng, kiện mới chờ hàng', async () => {
    const { packageId, orderId, packageCode } = await seedPackage(companyId, {
      status: 'backordered', shopId, lines: [one(white), one(jeans), one(red)],
    });
    const before = (await outboxOf(companyId, 'fulfillment.allocation_done')).length;

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: red, quantity: 1 }]] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(() => Order.parse(res.body)).not.toThrow();
    expect((await packageRow(packageId)).status).toBe('reserved');
    const [created] = await otherPackages(orderId, packageId);
    expect(created).toMatchObject({ status: 'backordered' });
    expect(created!.code).toMatch(/^KH-\d{6}$/);
    expect(created!.code).not.toBe(packageCode);
    expect(await linesOf(created!.id)).toEqual([{ variant_id: red, quantity: 1, reserved_qty: 0 }]);
    expect((await outboxOf(companyId, 'fulfillment.allocation_done')).length).toBe(before + 1);
  });

  it('D2-S02 AC2: kiện reserved tách ra hai kiện reserved, phần giữ đi theo món, tổng đang giữ không đổi', async () => {
    const { packageId, orderId } = await seedPackage(companyId, {
      status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true }), one(blue, { reserved: true })],
    });
    const heldBefore = (await stockOfVariant(companyId, blue)).reserved;
    const allocations = (await outboxOf(companyId, 'fulfillment.allocation_done')).length;
    const old = await packageRow(packageId);

    const res = await split(packageId, { version: old.version, parts: [[{ variantId: blue, quantity: 1 }]] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [created] = await otherPackages(orderId, packageId);
    expect((await packageRow(packageId)).status).toBe('reserved');
    expect(created!.status).toBe('reserved');
    expect(created!.reserved_at).toEqual(old.reserved_at);
    for (const line of [...(await linesOf(packageId)), ...(await linesOf(created!.id))]) expect(line.reserved_qty).toBe(line.quantity);
    expect(await linesOf(created!.id)).toEqual([{ variant_id: blue, quantity: 1, reserved_qty: 1 }]);
    expect((await stockOfVariant(companyId, blue)).reserved).toBe(heldBefore);
    expect((await outboxOf(companyId, 'fulfillment.allocation_done')).length).toBe(allocations);
  });

  it('D2-S03 AC3: gian hàng unit hỏi mức tách ngoài giao dịch, không gọi sàn tách, kiện mới không có mã kiện sàn', async () => {
    const { packageId, orderId } = await seedPackage(companyId, {
      status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })],
    });
    const fake = { ...unit(), split: vi.fn(async () => ['FP-X']) };

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: jeans, quantity: 1 }]] }, fake);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fake.splitLevel).toHaveBeenCalledWith(companyId, shopId);
    expect(fake.split).not.toHaveBeenCalled();
    expect((await otherPackages(orderId, packageId))[0]!.platform_package_code).toBeNull();
  });

  it('D2-S03: đơn tay coi như unit, không hỏi cổng sàn', async () => {
    const { packageId, orderId } = await seedPackage(companyId, {
      status: 'reserved', manual: true, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })],
    });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: white, quantity: 1 }]] }, {});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageCount(orderId)).toBe(2);
  });

  it('D12 đơn tay: dòng 3 món chuyển 1, phần giữ chia theo dòng, tổng đang giữ không đổi', async () => {
    const { packageId, orderId } = await seedPackage(companyId, {
      status: 'reserved', manual: true, lines: [one(white, { quantity: 3, reserved: true })],
    });
    const heldBefore = (await stockOfVariant(companyId, white)).reserved;

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: white, quantity: 1 }]] }, {});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [created] = await otherPackages(orderId, packageId);
    expect(await linesOf(packageId)).toEqual([{ variant_id: white, quantity: 2, reserved_qty: 2 }]);
    expect(await linesOf(created!.id)).toEqual([{ variant_id: white, quantity: 1, reserved_qty: 1 }]);
    expect((await stockOfVariant(companyId, white)).reserved).toBe(heldBefore);
  });

  it('D2-S12 AC7: sàn không cho tách thì 422 split_not_supported, đơn vẫn một kiện', async () => {
    const { packageId, orderId } = await seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: jeans, quantity: 1 }]] }, {
      splitLevel: vi.fn(async () => 'none' as const),
    });

    expectProblem(res, 422, 'split_not_supported');
    expect(await packageCount(orderId)).toBe(1);
  });

  it.each(['packed', 'awaiting_pickup'] as const)('D2-S09 AC8: kiện %s thì 409 package_sealed', async (status) => {
    const { packageId } = await seedPackage(companyId, { status, shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: jeans, quantity: 1 }]] });

    expectProblem(res, 409, 'package_sealed');
  });

  it('D2-S10: kiện đã rời kho thì 409 invalid_transition', async () => {
    const { packageId } = await seedPackage(companyId, { status: 'in_transit', shopId, lines: [one(white), one(jeans)] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: jeans, quantity: 1 }]] });

    expectProblem(res, 409, 'invalid_transition');
  });

  it('sai phiên bản thì 409 version_conflict kèm kiện hiện tại', async () => {
    const { packageId, orderId } = await seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })] });

    const res = await split(packageId, { version: (await versionOf(packageId)) + 1, parts: [[{ variantId: jeans, quantity: 1 }]] });

    expectProblem(res, 409, 'version_conflict');
    expect(() => Package.parse(res.body.current)).not.toThrow();
    expect(await packageCount(orderId)).toBe(1);
  });

  it('D2-S11 AC9: chia hết món sang kiện mới thì 422, báo kiện cũ phải còn món', async () => {
    const { packageId } = await seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true })] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: white, quantity: 1 }]] });

    expectProblem(res, 422, 'validation_failed');
    expect(res.body.errors.parts).toBeTruthy();
  });

  it('SKU không có trong kiện thì 422 tại đúng dòng', async () => {
    const { packageId } = await seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] });

    expectProblem(res, 422, 'validation_failed');
    expect(res.body.errors['parts.0.0.variantId']).toBeTruthy();
  });

  it('biến thể lặp trong một phần thì 422 tại dòng lặp', async () => {
    const { packageId } = await seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })] });

    const res = await split(packageId, {
      version: await versionOf(packageId), parts: [[{ variantId: white, quantity: 1 }, { variantId: white, quantity: 1 }]],
    });

    expectProblem(res, 422, 'validation_failed');
    expect(res.body.errors['parts.0.1.variantId']).toBeTruthy();
  });

  it('D2-S06 AC10: sau khi tách, mỗi dòng đơn có tổng số lượng trên các kiện chưa huỷ bằng số lượng dòng', async () => {
    const { packageId, orderId } = await seedPackage(companyId, { status: 'backordered', shopId, lines: [one(white), one(jeans), one(red)] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: red, quantity: 1 }]] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await testPool().query<{ quantity: number; placed: number }>(
      `select ol.quantity, sum(pl.quantity)::int as placed from "order".order_lines ol
       join "order".package_lines pl on pl.order_line_id = ol.id
       join "order".packages p on p.id = pl.package_id and p.status <> 'cancelled'
       where ol.order_id = $1 group by ol.id, ol.quantity`,
      [orderId],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.placed).toBe(row.quantity);
  });

  it.each(['admin', 'sale'] as const)('D2-S01q AC11: %s thì 403, không hỏi cổng sàn', async (role) => {
    const { packageId } = await seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true })] });
    const fake = unit();

    const res = await split(packageId, { version: 1, parts: [[{ variantId: jeans, quantity: 1 }]] }, fake, role === 'admin' ? admin : sale);

    expectProblem(res, 403, 'forbidden');
    expect(fake.splitLevel).not.toHaveBeenCalled();
  });

  it('D2-S07 AC14: kiện mới ghi create kèm người tách, kiện cũ ghi split, lý do nối hai mã', async () => {
    const { packageId, orderId, packageCode } = await seedPackage(companyId, { status: 'backordered', shopId, lines: [one(white), one(jeans), one(red)] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: red, quantity: 1 }]] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [created] = await otherPackages(orderId, packageId);
    expect(await transitionsOf(created!.id)).toContainEqual({ action: 'create', from_state: null, to_state: 'backordered', source: 'user' });
    expect(await transitionsOf(packageId)).toContainEqual(expect.objectContaining({ action: 'split', from_state: 'backordered', to_state: 'backordered' }));
    const [createReason] = await reasonOf(created!.id, 'create');
    expect(createReason).toMatchObject({ reason: `Tách từ ${packageCode}`, actor_id: expect.any(String) });
    expect((await reasonOf(packageId, 'split'))[0]!.reason).toBe(`Tách ra ${created!.code}`);
    expect(await outboxOf(orderId, 'fulfillment.package_status_changed')).toContainEqual({ packageId: created!.id, orderId, from: null, to: 'backordered' });
  });

  it('Review Focus 1: bấm tách hai lần cùng phiên bản thì chỉ tách một lần, lần sau 409', async () => {
    const { packageId, orderId } = await seedPackage(companyId, {
      status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(jeans, { reserved: true }), one(blue, { reserved: true })],
    });
    const body = { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] };

    const results = await Promise.all([split(packageId, body), split(packageId, body)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.type).toBe('/problems/version_conflict');
    expect(await packageCount(orderId)).toBe(2);
  });

  it('Review Focus 2: gian hàng chờ kiểm kê vẫn tách được, các kiện con không giữ hàng', async () => {
    const other = await createCompany();
    const keeper = (await addMember(other.companyId, 'warehouse')).token;
    const [stocked, empty] = [(await createVariant(other.companyId)).variantId, (await createVariant(other.companyId)).variantId];
    await receive(other.companyId, stocked, 10, 100_000);
    const waiting = await channelShop(other.companyId, true);
    const { packageId, orderId } = await seedPackage(other.companyId, { status: 'backordered', shopId: waiting, lines: [one(stocked), one(empty)] });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: empty, quantity: 1 }]] }, unit(), keeper);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await packageRow(packageId)).status).toBe('backordered');
    expect((await otherPackages(orderId, packageId))[0]!.status).toBe('backordered');
  });

  it('D2-S08 Review Focus 3: kiện còn dòng chưa ghép SKU, chuyển hết dòng đã ghép, dòng chưa ghép ở lại kiện cũ', async () => {
    const { packageId, orderId } = await seedPackage(companyId, {
      status: 'reserved', shopId, fallbackVariantId: white, lines: [one(white, { reserved: true }), one(null)],
    });

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: white, quantity: 1 }]] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await linesOf(packageId)).toEqual([{ variant_id: null, quantity: 1, reserved_qty: 0 }]);
    expect(await linesOf((await otherPackages(orderId, packageId))[0]!.id)).toEqual([{ variant_id: white, quantity: 1, reserved_qty: 1 }]);
  });
});

describe('nhánh sku (spec 205 D7, D8, D13, D14)', () => {
  const sku = (codes = ['FP-OLD', 'FP-NEW'], before?: () => Promise<unknown>) => ({
    splitLevel: vi.fn(async () => 'sku' as const),
    split: vi.fn(async (..._args: Parameters<MarketplacePackages['split']>) => {
      expect(currentCompanyId()).toBeNull();
      await before?.();
      return codes;
    }),
  });
  const externalLineOf = async (packageLineId: string) => (await testPool().query<{ external_line_id: string }>(
    `select ol.external_line_id from "order".package_lines pl join "order".order_lines ol on ol.id = pl.order_line_id where pl.id = $1`,
    [packageLineId],
  )).rows[0]!.external_line_id;
  const externalOrderOf = async (orderId: string) => (await testPool().query<{ external_order_id: string }>(
    'select external_order_id from "order".orders where id = $1',
    [orderId],
  )).rows[0]!.external_order_id;
  const codeOf = async (id: string) => (await testPool().query<{ platform_package_code: string | null }>(
    'select platform_package_code from "order".packages where id = $1',
    [id],
  )).rows[0]!.platform_package_code;
  const seedTwo = () => seedPackage(companyId, { status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(blue, { reserved: true })] });

  it('D2-S05 AC4: gọi sàn tách một lần ngoài giao dịch, mỗi kiện mang mã kiện sàn của nhóm mình', async () => {
    const { packageId, orderId, lineIds } = await seedTwo();
    const fake = sku();

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] }, fake);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fake.split).toHaveBeenCalledTimes(1);
    expect(fake.split).toHaveBeenCalledWith(
      companyId, shopId, await externalOrderOf(orderId), [[await externalLineOf(lineIds[0]!)], [await externalLineOf(lineIds[1]!)]],
    );
    expect(await codeOf(packageId)).toBe('FP-OLD');
    expect((await otherPackages(orderId, packageId))[0]!.platform_package_code).toBe('FP-NEW');
  });

  it('D2-S13 AC5: chuyển một phần của một SKU thì 422 split_not_supported, không gọi sàn', async () => {
    const { packageId } = await seedPackage(companyId, {
      status: 'reserved', shopId, lines: [one(white, { reserved: true }), one(white, { reserved: true }), one(blue, { reserved: true })],
    });
    const fake = sku();

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: white, quantity: 1 }]] }, fake);

    expectProblem(res, 422, 'split_not_supported');
    expect(fake.split).not.toHaveBeenCalled();
  });

  it('D2-S14 AC6: sàn từ chối tách thì 422 kèm câu của sàn, không có kiện mới, không bật cờ', async () => {
    const { packageId, orderId } = await seedTwo();
    const fake = { ...sku(), split: vi.fn(async () => { throw new AppError(422, 'split_not_supported', 'Đơn ON_HOLD', { platformCode: '21001008' }); }) };

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] }, fake);

    expectProblem(res, 422, 'split_not_supported');
    expect(res.body.detail).toBe('Đơn ON_HOLD');
    expect(await packageCount(orderId)).toBe(1);
    expect((await packageRow(packageId)).needs_attention).toBe(false);
  });

  it('D2-S15 AC7a: đơn đã có hai kiện chưa huỷ thì 422 split_not_supported, không gọi sàn', async () => {
    const { packageId, orderId } = await seedTwo();
    await testPool().query(
      `insert into "order".packages (company_id, code, order_id, shop_id, status) values ($1, $2, $3, $4, 'reserved')`,
      [companyId, `KH-T-${packageId.slice(0, 8)}`, orderId, shopId],
    );
    const fake = sku();

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] }, fake);

    expectProblem(res, 422, 'split_not_supported');
    expect(fake.split).not.toHaveBeenCalled();
  });

  it('D2-S16 AC7b: sàn đã tách mà bước ghi lỗi thì kiện cũ bật Cần xử lý, lỗi gốc trả về', async () => {
    const { packageId, orderId } = await seedTwo();
    const fake = sku(undefined, () => testPool().query(`update "order".packages set status = 'packed' where id = $1`, [packageId]));

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] }, fake);

    expectProblem(res, 409, 'version_conflict');
    const row = await packageRow(packageId);
    expect(row.needs_attention).toBe(true);
    expect(row.flag_note).toBe('Sàn đã tách kiện, app chưa ghi được: kiểm lại kiện trên sàn');
    expect(await packageCount(orderId)).toBe(1);
  });

  it('kiện cũ đã bị lượt kéo gắn mã của nhóm khác trước bước ghi thì vẫn ghi được', async () => {
    const { packageId, orderId } = await seedTwo();
    const fake = sku(undefined, () => testPool().query(`update "order".packages set platform_package_code = 'FP-NEW' where id = $1`, [packageId]));

    const res = await split(packageId, { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] }, fake);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await codeOf(packageId)).toBe('FP-OLD');
    expect((await otherPackages(orderId, packageId))[0]!.platform_package_code).toBe('FP-NEW');
  });

  it('Review Focus 1: bấm tách hai lần cùng phiên bản thì sàn chỉ được gọi một lần', async () => {
    const { packageId, orderId } = await seedTwo();
    const fake = sku();
    const body = { version: await versionOf(packageId), parts: [[{ variantId: blue, quantity: 1 }]] };

    const results = await Promise.all([split(packageId, body, fake), split(packageId, body, fake)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(fake.split).toHaveBeenCalledTimes(1);
    expect(await packageCount(orderId)).toBe(2);
  });
});
