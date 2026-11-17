// Lazada `confirmed` (khách xác nhận đã nhận, #358): kiện đi theo sàn sang `delivered` như món `delivered`, tồn theo lõi
// bàn giao (Documents/21 §19.2: kiện `backordered` thử giữ trước, không đủ thì bàn giao bắt buộc).
import { describe, expect, it } from 'vitest';
import { lazadaPackageStatus } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { invariantBroken, packageDocuments, packageRow, stockOfVariant, transitionsOf } from './helpers.ts';
import { ingest, remote, setup, type LineStatus } from './platform-fixtures.ts';

const CONFIRMED = lazadaPackageStatus('confirmed') as LineStatus;

/** Sàn trả mọi món `confirmed` (mã thô giữ nguyên, trạng thái theo adapter Lazada). */
const confirmed = (o: PlatformOrder): PlatformOrder => ({
  ...o,
  rawStatus: 'confirmed',
  lines: o.lines.map((l) => ({ ...l, status: CONFIRMED, rawStatus: 'confirmed' })),
});

/** Món thứ i lấy trạng thái `pick(i)`: `returned` (khách trả sau nhận) hoặc `confirmed`. */
const mixed = (o: PlatformOrder, pick: (i: number) => 'returned' | 'confirmed'): PlatformOrder => ({
  ...o,
  rawStatus: 'returned,confirmed',
  lines: o.lines.map((l, i) => {
    const raw = pick(i);
    return { ...l, rawStatus: raw, status: raw === 'returned' ? 'returned' : CONFIRMED };
  }),
});

const deliveredAt = async (packageId: string) =>
  (await testPool().query<{ delivered_at: Date | null }>('select delivered_at from "order".packages where id = $1', [packageId])).rows[0]!.delivered_at;

describe('Lazada confirmed: kiện sang delivered theo sàn (#358 AC-2)', () => {
  it('adapter Lazada đổi confirmed thành delivered', () => {
    expect(CONFIRMED).toBe('delivered');
  });

  it('(a) SKU chưa ghép: backordered → delivered, marketplace, không phiếu, lịch sử nguồn sàn', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 0, unmapped: 1 });
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('backordered');

    await ingest(s.companyId, confirmed(o));

    const row = await packageRow(packageId);
    expect(row).toMatchObject({ status: 'delivered', handover_source: 'marketplace', needs_attention: false });
    expect(row.handed_over_at).not.toBeNull();
    expect(await deliveredAt(packageId)).not.toBeNull();
    expect(await packageDocuments(packageId)).toEqual([]);
    expect((await transitionsOf(packageId)).at(-1)).toMatchObject({ from_state: 'backordered', to_state: 'delivered', source: 'marketplace' });
  });

  it('(b) đã ghép, đủ khả dụng: backordered → giữ rồi trừ thường, một phiếu, không Tồn âm', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 2 });
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('backordered');
    await receive(s.companyId, s.variantId, 5, 100000);

    await ingest(s.companyId, confirmed(o));

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'marketplace', needs_attention: false });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(await invariantBroken(s.companyId, s.variantId)).toBe(false);
  });

  it('(c) đã ghép, thiếu khả dụng: bàn giao bắt buộc, cờ kiện, Tồn âm', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 2 });
    const { packageId } = await ingest(s.companyId, o);
    await receive(s.companyId, s.variantId, 1, 100000);

    await ingest(s.companyId, confirmed(o));

    const row = await packageRow(packageId);
    expect(row).toMatchObject({ status: 'delivered', handover_source: 'forced', needs_attention: true });
    expect(row.flag_note).toMatch(/^Bàn giao bắt buộc/);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: -1 });
    expect(await invariantBroken(s.companyId, s.variantId)).toBe(true);
  });

  it('(d) kiện đã giữ hàng: reserved → delivered, trừ đúng một lần', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('reserved');

    await ingest(s.companyId, confirmed(o));
    await ingest(s.companyId, confirmed(o));

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'marketplace' });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
  });

  it('đơn lần đầu thấy đã confirmed, đặt sau mốc: lập kiện delivered, trừ tồn', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { packageId } = await ingest(s.companyId, confirmed(remote(s, { placedAt: new Date(cutoff.getTime() + 60_000), orderCutoffAt: cutoff })));

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'marketplace' });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9 });
  });

  it('đơn lần đầu thấy đã confirmed, đặt trước mốc: before_cutoff, không phiếu', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { packageId } = await ingest(s.companyId, confirmed(remote(s, { placedAt: new Date(cutoff.getTime() - 60_000), orderCutoffAt: cutoff })));

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'before_cutoff' });
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 10 });
  });
});

describe('kiện có món delivered lẫn món returned là delivered (#358 AC-3, Documents/25 §9)', () => {
  // Dựng theo đơn thật 530740223180318: một mã kiện, 2 món khách trả sau nhận (`returned`) + 2 món `confirmed`.
  it.each([
    ['món returned đứng trước', (i: number) => (i < 2 ? 'returned' : 'confirmed') as 'returned' | 'confirmed'],
    ['món confirmed đứng trước', (i: number) => (i < 2 ? 'confirmed' : 'returned') as 'returned' | 'confirmed'],
  ])('%s → delivered, trừ tồn một lần', async (_name, pick) => {
    const s = await setup(10);
    const o = remote(s, { lines: 4 });
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('reserved');

    await ingest(s.companyId, mixed(o, pick));

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'marketplace' });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 6, reserved: 0 });
  });

  it('còn món chậm hơn (in_transit) thì món chậm nhất quyết, không ra delivered', async () => {
    const s = await setup(10);
    const o = remote(s, { lines: 4 });
    const { packageId } = await ingest(s.companyId, o);
    const m = mixed(o, (i) => (i < 2 ? 'returned' : 'confirmed'));

    await ingest(s.companyId, { ...m, lines: m.lines.map((l, i) => (i === 3 ? { ...l, status: 'in_transit', rawStatus: 'shipping' } : l)) });

    expect((await packageRow(packageId)).status).toBe('in_transit');
  });
});
