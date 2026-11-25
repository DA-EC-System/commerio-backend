// Mở kiện đơn sàn áp lại ghép SKU hiện hành (spec 237 §5.6 "Mở kiện áp lại ghép", D20, D21; ca 19a, 20, 20a, 20d, 20e,
// Review Focus 1, 2, 5). Ghép hiện hành là `skuMappingOf` giả đọc một `Map` đổi được giữa các bước.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LineSku, MappedSku } from '#src/modules/order/fulfillment/domain/remap.ts';
import { remapPackageLines } from '#src/modules/order/fulfillment/index.ts';
import type { MarketplacePackages } from '#src/modules/order/fulfillment/service/packages.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, packageRow, packingApp, seedPackage, stockOfVariant, transitionsOf } from './helpers.ts';

let companyId: string;
let kho: Awaited<ReturnType<typeof addMember>>;
let shopId: string;
const actorId = randomUUID();
/** Ghép hiện hành theo SKU người bán của gian hàng thử; SKU vắng là chưa ghép (listing gỡ, chỉ chờ duyệt). */
const mapping = new Map<string, LineSku>();
const ctx = {
  skuMappingOf: async (_shopId: string, skus: readonly string[]) =>
    new Map(skus.flatMap((s) => (mapping.has(s) ? [[s, mapping.get(s)!] as const] : []))),
};

beforeAll(async () => {
  ({ companyId } = await createCompany());
  kho = await addMember(companyId, 'warehouse');
  shopId = await channelShop(companyId, false);
});
afterEach(() => setStockPort());

const variant = (variantId: string): MappedSku => ({ kind: 'variant', variantId });
const newSku = () => `LZ-${randomUUID().slice(0, 8)}`;

async function sku(stock: number) {
  const { variantId } = await createVariant(companyId);
  if (stock > 0) await receive(companyId, variantId, stock, 100000);
  return variantId;
}

const repacked: Partial<MarketplacePackages> = { repack: async () => 'repacked' };

async function open(id: string, fake: Partial<MarketplacePackages> = repacked) {
  return packingApp(fake, ctx)
    .post(`/api/v1/fulfillment/packages/${id}/open`)
    .set('Authorization', `Bearer ${kho.token}`)
    .send({ version: (await packageRow(id)).version });
}

const orderLineOf = async (packageLineId: string) =>
  (await testPool().query<{ order_line_id: string }>('select order_line_id from "order".package_lines where id = $1', [packageLineId])).rows[0]!
    .order_line_id;

/** Đổi ghép như channel gọi sales (ở đây gọi thẳng fulfillment): dòng kiện của `packageLineId` sang `to`. */
async function remap(packageLineId: string, sellerSku: string, to: MappedSku) {
  mapping.set(sellerSku, to);
  const orderLineId = await orderLineOf(packageLineId);
  return withCompany(companyId, () =>
    remapPackageLines([{ orderLineId, to }], { actorId, holdStock: true, orderCutoffAt: null, reason: `Ghép SKU ${sellerSku}` }),
  );
}

const lineOf = async (packageLineId: string) =>
  (
    await testPool().query<{ variant_id: string | null; stock_untracked: boolean; reserved_qty: number; remap_pending: boolean }>(
      'select variant_id, stock_untracked, reserved_qty, remap_pending from "order".package_lines where id = $1',
      [packageLineId],
    )
  ).rows[0];
const orderLineRow = async (packageLineId: string) =>
  (
    await testPool().query<{ variant_id: string | null; stock_untracked: boolean }>(
      'select variant_id, stock_untracked from "order".order_lines where id = $1',
      [await orderLineOf(packageLineId)],
    )
  ).rows[0];

/** Kiện `packed` của gian hàng giữ 1 món A mang SKU người bán `sellerSku`, mã kiện sàn có để mở gọi `repack`. */
async function packedHolding(a: string, sellerSku: string, o: Partial<Parameters<typeof seedPackage>[1]> = {}) {
  mapping.set(sellerSku, variant(a));
  return seedPackage(companyId, {
    status: 'packed',
    shopId,
    platformPackageCode: `FP-${randomUUID().slice(0, 8)}`,
    lines: [{ variantId: a, quantity: 1, reserved: true, externalSku: sellerSku }],
    ...o,
  });
}

describe('mở kiện đơn sàn áp lại ghép hiện hành (spec 237 §5.6)', () => {
  it('D2-G13 20: kiện ở 19 (A → B, có dấu, Cần mở remap), kho mở → kiện reserved, dòng đơn và dòng kiện là B, giữ B, cờ gỡ, dấu xoá, lịch sử open rồi remap', async () => {
    const [a, b] = [await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s);
    expect([...(await remap(p.lineIds[0]!, s, variant(b))).values()]).toEqual(['needs_unload']);

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false, open_purpose: null });
    expect(await lineOf(p.lineIds[0]!)).toEqual({ variant_id: b, stock_untracked: false, reserved_qty: 1, remap_pending: false });
    expect(await orderLineRow(p.lineIds[0]!)).toEqual({ variant_id: b, stock_untracked: false });
    expect((await stockOfVariant(companyId, a)).reserved).toBe(0);
    expect((await stockOfVariant(companyId, b)).reserved).toBe(1);
    expect((await transitionsOf(p.packageId)).map((t) => t.action)).toEqual(['remap', 'open', 'remap']);
  });

  it('D2-G13 20: như trên nhưng B thiếu → kiện backordered, mở vẫn 200', async () => {
    const [a, b] = [await sku(5), await sku(0)];
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, variant(b));

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'backordered', needs_open: false });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: b, reserved_qty: 0 });
    expect((await stockOfVariant(companyId, a)).reserved).toBe(0);
  });

  it('D2-G11 19a: kiện awaiting_pickup ở 19, mở → giữ vận đơn, không gọi repack, dòng thành B', async () => {
    const [a, b] = [await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s, { status: 'awaiting_pickup', trackingCode: `VD-${randomUUID().slice(0, 8)}` });
    await remap(p.lineIds[0]!, s, variant(b));

    const res = await open(p.packageId, {
      repack: async () => {
        throw new Error('không được gọi repack');
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false });
    expect((await testPool().query('select waybill_kept from "order".packages where id = $1', [p.packageId])).rows[0].waybill_kept).toBe(true);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: b, reserved_qty: 1 });
  });

  it('D2-G13 20a: kiện packed giữ A, ghép đã là B, không dấu, Cần mở edit có dòng chờ bỏ → mở: dòng sống thành B, dòng chờ bỏ bỏ ra', async () => {
    const [a, b, c] = [await sku(5), await sku(5), await sku(5)];
    const s = newSku();
    mapping.set(s, variant(b));
    const p = await seedPackage(companyId, {
      status: 'packed',
      shopId,
      platformPackageCode: `FP-${randomUUID().slice(0, 8)}`,
      needsOpen: true,
      openPurpose: 'edit',
      lines: [
        { variantId: a, quantity: 1, reserved: true, externalSku: s },
        { variantId: c, quantity: 1, reserved: true, externalSku: newSku() },
      ],
    });
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('update "order".order_lines set cancelled_qty = quantity where id = $1', [await orderLineOf(p.lineIds[1]!)]);
      await client.query('update "order".package_lines set pending_drop_qty = quantity where id = $1', [p.lineIds[1]]);
      await client.query('commit');
    } finally {
      client.release();
    }

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: b, reserved_qty: 1 });
    expect(await lineOf(p.lineIds[1]!)).toBeUndefined();
    expect(await orderLineRow(p.lineIds[0]!)).toEqual({ variant_id: b, stock_untracked: false });
  });

  it('D2-G13 20d: kiện packed chưa giữ A, A hết hàng, ghép đã là B (B đủ) → mở không 422, dòng B, kiện reserved', async () => {
    const [a, b] = [await sku(0), await sku(5)];
    const s = newSku();
    mapping.set(s, variant(b));
    const p = await seedPackage(companyId, {
      status: 'packed',
      shopId,
      platformPackageCode: `FP-${randomUUID().slice(0, 8)}`,
      lines: [{ variantId: a, quantity: 1, externalSku: s }],
    });

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved' });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: b, reserved_qty: 1 });
    expect((await stockOfVariant(companyId, b)).reserved).toBe(1);
    // Kiện chưa từng giữ nhận mốc giữ khi giữ được B (`planReclaim` sắp theo mốc này; review PR 2).
    const { rows } = await testPool().query<{ reserved_at: Date | null }>('select reserved_at from "order".packages where id = $1', [p.packageId]);
    expect(rows[0]!.reserved_at).not.toBeNull();
  });

  it('D2-G13 20e: trong lúc repack, ghép đổi B → C (dấu không đổi, version giữ) → bước ghi áp C', async () => {
    const [a, b, c] = [await sku(5), await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, variant(b));
    const before = (await packageRow(p.packageId)).version;

    const res = await open(p.packageId, {
      repack: async () => {
        await remap(p.lineIds[0]!, s, variant(c));
        expect((await packageRow(p.packageId)).version).toBe(before);
        return 'repacked';
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: c, reserved_qty: 1 });
    expect(await orderLineRow(p.lineIds[0]!)).toEqual({ variant_id: c, stock_untracked: false });
  });

  it('D2-G13 20e: trong lúc repack, ghép đổi về A (xoá dấu, version tăng) → 409 version_conflict, kiện vẫn packed', async () => {
    const [a, b] = [await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, variant(b));

    const res = await open(p.packageId, {
      repack: async () => {
        await remap(p.lineIds[0]!, s, variant(a));
        return 'repacked';
      },
    });

    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'stocktake' });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: a, remap_pending: false });
  });

  it('D2-G15 Review Focus 1: kiện packed giữ A, đổi sang không quản tồn rồi mở → dòng stock_untracked, A nhả, kiện reserved', async () => {
    const a = await sku(5);
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, { kind: 'untracked' });

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false });
    expect(await lineOf(p.lineIds[0]!)).toEqual({ variant_id: null, stock_untracked: true, reserved_qty: 0, remap_pending: false });
    expect(await orderLineRow(p.lineIds[0]!)).toEqual({ variant_id: null, stock_untracked: true });
    expect((await stockOfVariant(companyId, a)).reserved).toBe(0);
  });

  it('D2-G13 Review Focus 2: ghép hiện hành unmapped (Map không có SKU) → mở: dòng giữ A, dấu xoá, kiện reserved', async () => {
    const [a, b] = [await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, variant(b));
    mapping.delete(s);

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false });
    expect(await lineOf(p.lineIds[0]!)).toEqual({ variant_id: a, stock_untracked: false, reserved_qty: 1, remap_pending: false });
    expect(await orderLineRow(p.lineIds[0]!)).toEqual({ variant_id: a, stock_untracked: false });
  });

  it('D2-G18 Review Focus 5, D26: kiện thay đã đóng có dòng chờ thay và dòng thường, ghép cả hai đã đổi → mở: dòng chờ thay giữ ghép cũ, dòng thường thành ghép mới', async () => {
    const [a, b, c, d] = [await sku(5), await sku(5), await sku(5), await sku(5)];
    const [s, s2] = [newSku(), newSku()];
    mapping.set(s, variant(a));
    mapping.set(s2, variant(c));
    const p = await seedPackage(companyId, {
      status: 'packed',
      shopId,
      platformPackageCode: `FP-${randomUUID().slice(0, 8)}`,
      lines: [
        { variantId: a, quantity: 1, reserved: true, externalSku: s },
        { variantId: c, quantity: 1, reserved: true, externalSku: s2 },
      ],
    });
    // Kiện cũ đã đóng của cùng đơn còn dòng chờ bỏ cho dòng đơn đầu: dòng đó của `p` là dòng chờ thay (#238 D9).
    const { rows } = await testPool().query<{ id: string }>(
      `insert into "order".packages (company_id, code, order_id, shop_id, status) values ($1, $2, $3, $4, 'packed') returning id`,
      [companyId, `KH-${randomUUID().slice(0, 8)}`, p.orderId, shopId],
    );
    await testPool().query(
      `insert into "order".package_lines (company_id, package_id, order_line_id, variant_id, quantity, pending_drop_qty) values ($1, $2, $3, $4, 1, 1)`,
      [companyId, rows[0]!.id, await orderLineOf(p.lineIds[0]!), a],
    );
    mapping.set(s, variant(b));
    mapping.set(s2, variant(d));

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: a, reserved_qty: 1 });
    expect(await orderLineRow(p.lineIds[0]!)).toEqual({ variant_id: a, stock_untracked: false });
    expect(await lineOf(p.lineIds[1]!)).toMatchObject({ variant_id: d, reserved_qty: 1 });
    expect(await orderLineRow(p.lineIds[1]!)).toEqual({ variant_id: d, stock_untracked: false });
  });

  it('D2-G13 D21: bước ghi khoá đơn trước dòng đơn như lượt nhận đơn (không khoá chéo): đơn đang bị giữ thì mở kiện chờ rồi xong', async () => {
    const [a, b] = [await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, variant(b));
    const version = (await packageRow(p.packageId)).version;

    const res = await raceBehindLock(
      (holder) => holder.query('select id from "order".orders where id = $1 for update', [p.orderId]),
      1,
      () =>
        packingApp(repacked, ctx)
          .post(`/api/v1/fulfillment/packages/${p.packageId}/open`)
          .set('Authorization', `Bearer ${kho.token}`)
          .send({ version })
          .then((r) => r),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: b, reserved_qty: 1 });
  });

  it('D2-G12 open_cancel: kiện mang dấu chờ đổi ghép mà mọi dòng chờ bỏ → mở là huỷ kiện, dấu xoá', async () => {
    const [a, b] = [await sku(5), await sku(5)];
    const s = newSku();
    const p = await packedHolding(a, s);
    await remap(p.lineIds[0]!, s, variant(b));
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('update "order".order_lines set cancelled_qty = quantity where id = $1', [await orderLineOf(p.lineIds[0]!)]);
      await client.query('update "order".package_lines set pending_drop_qty = quantity where id = $1', [p.lineIds[0]]);
      await client.query('commit');
    } finally {
      client.release();
    }

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'cancelled', needs_open: false, open_purpose: null });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: a, remap_pending: false });
    expect((await stockOfVariant(companyId, a)).reserved).toBe(0);
  });
});
