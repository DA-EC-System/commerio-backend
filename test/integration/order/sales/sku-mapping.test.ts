// Áp ghép SKU lên dòng đơn đã về (spec 237 §5.4, AC1, AC2, AC10, AC13, AC14, D3, Review Focus 4, 5).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { applySkuMapping, type MappedSku, type PlatformOrder } from '#src/modules/order/index.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';
import { outboxOf, packageDocuments, packageRow } from '../fulfillment/helpers.ts';
import { ingest, type LineStatus, remote, setup } from '../fulfillment/platform-fixtures.ts';

const actorId = randomUUID();

afterEach(() => setStockPort());

/** Đơn một món chưa ghép mang SKU người bán `sellerSku`, của gian hàng `shopId`. */
function unmappedOrder(v: { variantId: string; sku: string }, shopId: string, sellerSku: string, status: LineStatus = 'pending'): PlatformOrder {
  const o = remote(v, { status, lines: 0, unmapped: 1 });
  return { ...o, shopId, lines: o.lines.map((l) => ({ ...l, sellerSku })) };
}

const apply = (companyId: string, shopId: string, sellerSku: string, to: MappedSku) =>
  withCompany(companyId, () => applySkuMapping({ shopId, sellerSku, to, actorId, holdStock: true, orderCutoffAt: null }));

const orderLinesOf = async (orderId: string) =>
  (
    await testPool().query(
      'select variant_id, stock_untracked, sku, external_sku from "order".order_lines where order_id = $1 order by external_line_id',
      [orderId],
    )
  ).rows;
const packageLinesOf = async (orderId: string) =>
  (
    await testPool().query(
      `select l.variant_id, l.stock_untracked from "order".package_lines l join "order".packages p on p.id = l.package_id
        where p.order_id = $1 order by l.created_at, l.id`,
      [orderId],
    )
  ).rows;
const statusEvents = (orderId: string) => outboxOf(orderId, 'sales.order_status_changed');
const remapHistory = async (packageId: string) =>
  (await testPool().query(`select 1 from core.state_transitions where entity_type = 'packages' and entity_id = $1 and action = 'remap'`, [packageId])).rows
    .length;
const allocationJobs = async (companyId: string) =>
  (await testPool().query(`select data from pgboss.job where name = 'fulfillment.allocation' and data->>'companyId' = $1`, [companyId])).rows;

describe('applySkuMapping: ghép SKU áp lên đơn đã về (spec 237 §5.4)', () => {
  it('D2-G01 AC1: hai đơn cùng gian hàng có dòng chưa ghép cùng SKU → dòng đơn, dòng kiện có biến thể; cờ tắt; mỗi đơn một sự kiện; xếp phân hàng', async () => {
    const s = await setup(10);
    const shopId = randomUUID();
    const sellerSku = `SAN-${randomUUID().slice(0, 8)}`;
    const a = await ingest(s.companyId, unmappedOrder(s, shopId, sellerSku));
    const b = await ingest(s.companyId, unmappedOrder(s, shopId, sellerSku));

    expect(await apply(s.companyId, shopId, sellerSku, { kind: 'variant', variantId: s.variantId })).toEqual({ lines: 2, orders: 2, needsUnload: 0 });

    for (const o of [a, b]) {
      expect(await orderLinesOf(o.orderId)).toEqual([{ variant_id: s.variantId, stock_untracked: false, sku: sellerSku, external_sku: sellerSku }]);
      expect(await packageLinesOf(o.orderId)).toEqual([{ variant_id: s.variantId, stock_untracked: false }]);
      const events = await statusEvents(o.orderId);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ orderId: o.orderId, from: 'processing', to: 'processing' });
      expect(events[1]!.flags).not.toContain('unmapped_sku');
    }
    expect(await allocationJobs(s.companyId)).not.toEqual([]);
  });

  it('D2-G02 Review Focus 4 / AC2: đơn của gian hàng khác cùng SKU người bán, và dòng đã ghép khác của cùng đơn → không đổi', async () => {
    const s = await setup(10);
    const { variantId: w } = await createVariant(s.companyId);
    const shopId = randomUUID();
    const sellerSku = `SAN-${randomUUID().slice(0, 8)}`;
    const other = await ingest(s.companyId, unmappedOrder(s, randomUUID(), sellerSku));
    // Cùng đơn: một dòng đã ghép biến thể w (ghép cũ của SKU này), một dòng chưa ghép.
    const mixed = remote(s, { lines: 1, unmapped: 1 });
    const own = await ingest(s.companyId, {
      ...mixed,
      shopId,
      lines: mixed.lines.map((l) => ({ ...l, sellerSku, ...(l.variantId && { variantId: w }) })),
    });

    expect(await apply(s.companyId, shopId, sellerSku, { kind: 'variant', variantId: s.variantId })).toEqual({ lines: 1, orders: 1, needsUnload: 0 });

    expect(await orderLinesOf(other.orderId)).toEqual([{ variant_id: null, stock_untracked: false, sku: null, external_sku: sellerSku }]);
    expect(await packageLinesOf(other.orderId)).toEqual([{ variant_id: null, stock_untracked: false }]);
    expect((await orderLinesOf(own.orderId)).map((l) => l.variant_id)).toEqual([w, s.variantId]);
  });

  it('D2-G06 AC10 (sales): ghép "không quản tồn" → dòng đơn, dòng kiện stock_untracked, sku null, cờ tắt; kiện chỉ có dòng đó sang reserved không qua cổng tồn', async () => {
    const s = await setup(10);
    const shopId = randomUUID();
    const sellerSku = `SAN-${randomUUID().slice(0, 8)}`;
    const o = await ingest(s.companyId, unmappedOrder(s, shopId, sellerSku));
    setStockPort({
      reserve: async () => {
        throw new Error('không được gọi cổng tồn');
      },
    });

    expect(await apply(s.companyId, shopId, sellerSku, { kind: 'untracked' })).toEqual({ lines: 1, orders: 1, needsUnload: 0 });

    expect(await orderLinesOf(o.orderId)).toEqual([{ variant_id: null, stock_untracked: true, sku: null, external_sku: sellerSku }]);
    expect(await packageLinesOf(o.orderId)).toEqual([{ variant_id: null, stock_untracked: true }]);
    expect(await packageRow(o.packageId)).toMatchObject({ status: 'reserved' });
    expect((await statusEvents(o.orderId)).at(-1)!.flags).not.toContain('unmapped_sku');
  });

  it('D2-G08 AC13 / Review Focus 5: gọi lại khi đã áp xong → không ghi gì: không phiếu XK, không sự kiện đơn, không lịch sử remap mới', async () => {
    const s = await setup(10);
    const shopId = randomUUID();
    const sellerSku = `SAN-${randomUUID().slice(0, 8)}`;
    const o = await ingest(s.companyId, unmappedOrder(s, shopId, sellerSku, 'in_transit'));
    const to: MappedSku = { kind: 'variant', variantId: s.variantId };
    await apply(s.companyId, shopId, sellerSku, to);
    const docs = (await packageDocuments(o.packageId)).length;
    const events = (await statusEvents(o.orderId)).length;
    expect(docs).toBe(1);
    expect(await remapHistory(o.packageId)).toBe(1);

    expect(await apply(s.companyId, shopId, sellerSku, to)).toEqual({ lines: 0, orders: 0, needsUnload: 0 });

    expect(await packageDocuments(o.packageId)).toHaveLength(docs);
    expect(await statusEvents(o.orderId)).toHaveLength(events);
    expect(await remapHistory(o.packageId)).toBe(1);
  });

  it('D2-G09 AC14: cổng tồn ném lỗi giữa lúc áp → hàm ném, giao dịch rollback: dòng đơn vẫn chưa ghép, không sự kiện', async () => {
    const s = await setup(10);
    const shopId = randomUUID();
    const sellerSku = `SAN-${randomUUID().slice(0, 8)}`;
    const o = await ingest(s.companyId, unmappedOrder(s, shopId, sellerSku, 'in_transit'));
    const events = (await statusEvents(o.orderId)).length;
    setStockPort({
      ship: async () => {
        throw new Error('hỏng');
      },
    });

    await expect(apply(s.companyId, shopId, sellerSku, { kind: 'variant', variantId: s.variantId })).rejects.toThrow('hỏng');

    expect(await orderLinesOf(o.orderId)).toEqual([{ variant_id: null, stock_untracked: false, sku: null, external_sku: sellerSku }]);
    expect(await statusEvents(o.orderId)).toHaveLength(events);
  });

  it('D2-G03 D3, P6: đơn completed có kiện bàn giao bắt buộc chưa ghép → dòng được ghép và trừ tồn; không phát sự kiện đơn', async () => {
    const s = await setup(10);
    const shopId = randomUUID();
    const sellerSku = `SAN-${randomUUID().slice(0, 8)}`;
    const o = await ingest(s.companyId, unmappedOrder(s, shopId, sellerSku, 'delivered'));
    await testPool().query(`update "order".orders set status = 'completed', outcome = 'full', completed_at = now() where id = $1`, [o.orderId]);
    await testPool().query(`update "order".packages set handover_source = 'forced' where id = $1`, [o.packageId]);
    const events = (await statusEvents(o.orderId)).length;

    expect(await apply(s.companyId, shopId, sellerSku, { kind: 'variant', variantId: s.variantId })).toEqual({ lines: 1, orders: 1, needsUnload: 0 });

    expect(await orderLinesOf(o.orderId)).toEqual([{ variant_id: s.variantId, stock_untracked: false, sku: sellerSku, external_sku: sellerSku }]);
    expect(await packageDocuments(o.packageId)).toHaveLength(1);
    expect(await statusEvents(o.orderId)).toHaveLength(events);
  });
});
