import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { StockDetail, StockPage } from '#src/modules/product/inventory/api/schemas.ts';
import type { StockDocumentKind } from '#src/modules/product/inventory/domain/moves.ts';
import { getStock } from '#src/modules/product/inventory/service/stock.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { revokePermission } from '../../helpers/state.ts';
import { createSupplier, orderedRequest, postedReceipt } from '../purchasing/helpers.ts';
import { archiveVariant, inv, receive, setBuckets } from './helpers.ts';

// API tồn và ngưỡng /inventory/stock (Documents/21 mục 15.1, 15.2; K3, V29–V33).
let A: { companyId: string; ceo: string; admin: string; kho: string; sale: string };
let B: { companyId: string; ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    admin: (await addMember(a.companyId, 'admin')).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
    sale: (await addMember(a.companyId, 'sale')).token,
  };
  const b = await createCompany();
  B = { companyId: b.companyId, ceo: b.ceo.token };
});

describe('danh sách tồn', () => {
  it('dòng có tồn thực, đang giữ, khả dụng, chờ xử lý; CEO thấy giá vốn, Admin và Kho nhận null', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 20, 100000);
    await setBuckets(c.companyId, v, { reserved: 6, quarantine: 3 });
    const res = await inv(c.ceo.token).get('/stock');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        variantId: v,
        onHand: 20,
        reserved: 6,
        locked: 0,
        available: 14,
        quarantine: 3,
        negative: false,
        avgCost: 100000,
        stockValue: 2000000,
      }),
    ]);
    const byKho = (await inv(kho).get('/stock')).body;
    expect(byKho.items[0]).toMatchObject({ avgCost: null, stockValue: null });
    expect(byKho.summary).toMatchObject({ totalValue: null, quarantineCount: 1, negativeCount: 0 });
  });

  it('giá vốn lưu 100000.40, API trả 100000, giá trị tồn 5 × 100000.40 = 500002', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 3, 100000);
    await receive(c.companyId, v, 2, 100001);
    const [item] = (await inv(c.ceo.token).get('/stock')).body.items;
    expect(item).toMatchObject({ onHand: 5, avgCost: 100000, stockValue: 500002 });
  });

  it('lọc dưới ngưỡng và có hàng chờ xử lý; summary tính trên cả công ty', async () => {
    const c = await createCompany();
    const x = await createVariant(c.companyId);
    const y = await createVariant(c.companyId);
    await receive(c.companyId, y.variantId, 2, 1000);
    await setBuckets(c.companyId, y.variantId, { quarantine: 1 });
    await inv(c.ceo.token).put(`/stock/${y.variantId}/reorder-rule`, { minQty: 5, version: 1 });
    const below = (await inv(c.ceo.token).get('/stock?belowMin=true')).body;
    expect(below.items.map((i: { variantId: string }) => i.variantId)).toEqual([y.variantId]);
    expect(below.summary).toMatchObject({ variantCount: 2, belowMinCount: 1 });
    const quarantine = (await inv(c.ceo.token).get('/stock?quarantine=true')).body;
    expect(quarantine.items.map((i: { variantId: string }) => i.variantId)).toEqual([y.variantId]);
    expect((await inv(c.ceo.token).get(`/stock?search=${x.sku}`)).body.items).toHaveLength(1);
  });

  /** X thường; Y chờ xử lý 1, dưới ngưỡng; Z tồn thực âm; W đang giữ vượt tồn thực (cờ Tồn âm, tồn thực vẫn dương). */
  async function fourVariants() {
    const c = await createCompany();
    const [x, y, z, w] = [
      await createVariant(c.companyId),
      await createVariant(c.companyId),
      await createVariant(c.companyId),
      await createVariant(c.companyId),
    ];
    await receive(c.companyId, x.variantId, 10, 1000);
    await receive(c.companyId, y.variantId, 2, 1000);
    await setBuckets(c.companyId, y.variantId, { quarantine: 1 });
    await inv(c.ceo.token).put(`/stock/${y.variantId}/reorder-rule`, { minQty: 5, version: 1 });
    await receive(c.companyId, z.variantId, 2, 1000);
    await setBuckets(c.companyId, z.variantId, { onHand: -2, invariantBroken: true });
    await receive(c.companyId, w.variantId, 1, 1000);
    await setBuckets(c.companyId, w.variantId, { reserved: 3, invariantBroken: true });
    return { c, x, y, z, w };
  }

  it('summary đếm biến thể có hàng chờ xử lý và biến thể Tồn âm (cả khi tồn thực chưa âm); dòng có state', async () => {
    const { c, x, y, z, w } = await fourVariants();
    const body = (await inv(c.ceo.token).get('/stock')).body;
    expect(body.summary).toMatchObject({ variantCount: 4, belowMinCount: 1, quarantineCount: 1, negativeCount: 2 });
    const state = Object.fromEntries(body.items.map((i: { variantId: string; state: string }) => [i.variantId, i.state]));
    expect(state).toEqual({ [x.variantId]: 'in_stock', [y.variantId]: 'low', [z.variantId]: 'out', [w.variantId]: 'out' });
  });

  it('lọc chờ xử lý, dưới ngưỡng, tìm kiếm không đổi summary', async () => {
    const { c, x } = await fourVariants();
    const all = (await inv(c.ceo.token).get('/stock')).body.summary;
    for (const q of ['quarantine=true', 'belowMin=true', `search=${x.sku}`]) {
      expect((await inv(c.ceo.token).get(`/stock?${q}`)).body.summary).toEqual(all);
    }
  });

  const idsOf = (body: { items: { variantId: string }[] }) => body.items.map((i) => i.variantId).sort();

  it('AC1: negative=true chỉ trả SKU Tồn âm; summary không theo lọc; negative=abc → 422', async () => {
    const c = await createCompany();
    const a = await createVariant(c.companyId);
    const b = await createVariant(c.companyId);
    await receive(c.companyId, a.variantId, 3, 1000);
    await setBuckets(c.companyId, a.variantId, { reserved: 5, invariantBroken: true });
    await receive(c.companyId, b.variantId, 2, 1000);

    const res = await inv(c.ceo.token).get('/stock?negative=true');
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([a.variantId]);
    expect(res.body.total).toBe(1);
    expect(res.body.summary).toEqual((await inv(c.ceo.token).get('/stock')).body.summary);
    expect(res.body.summary).toMatchObject({ variantCount: 2, negativeCount: 1 });

    const bad = await inv(c.ceo.token).get('/stock?negative=abc');
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('negative');
  });

  it('negative và belowMin gộp AND', async () => {
    const c = await createCompany();
    // A Tồn âm và dưới ngưỡng; B Tồn âm, chưa đặt ngưỡng; C dưới ngưỡng, không Tồn âm.
    const [a, b, d] = [await createVariant(c.companyId), await createVariant(c.companyId), await createVariant(c.companyId)];
    await receive(c.companyId, a.variantId, 1, 1000);
    await inv(c.ceo.token).put(`/stock/${a.variantId}/reorder-rule`, { minQty: 5, version: 1 });
    await setBuckets(c.companyId, a.variantId, { reserved: 3, invariantBroken: true });
    await receive(c.companyId, b.variantId, 1, 1000);
    await setBuckets(c.companyId, b.variantId, { reserved: 3, invariantBroken: true });
    await receive(c.companyId, d.variantId, 2, 1000);
    await inv(c.ceo.token).put(`/stock/${d.variantId}/reorder-rule`, { minQty: 5, version: 1 });

    expect(idsOf((await inv(c.ceo.token).get('/stock?negative=true')).body)).toEqual([a.variantId, b.variantId].sort());
    expect(idsOf((await inv(c.ceo.token).get('/stock?belowMin=true')).body)).toEqual([a.variantId, d.variantId].sort());
    expect(idsOf((await inv(c.ceo.token).get('/stock?negative=true&belowMin=true')).body)).toEqual([a.variantId]);
  });

  it('AC2: mọi dòng có drift false; body parse được bằng StockPage', async () => {
    const { c } = await fourVariants();
    const res = await inv(c.ceo.token).get('/stock');
    StockPage.parse(res.body);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.items.every((i: { drift: unknown }) => i.drift === false)).toBe(true);
  });

  it('biến thể lưu trữ còn hàng vẫn hiện, hết hàng thì ẩn', async () => {
    const c = await createCompany();
    const kept = await createVariant(c.companyId);
    const gone = await createVariant(c.companyId);
    await receive(c.companyId, kept.variantId, 1, 1000);
    await archiveVariant(kept.variantId);
    await archiveVariant(gone.variantId);
    const ids = (await inv(c.ceo.token).get('/stock')).body.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).toEqual([kept.variantId]);
  });
});

describe('chi tiết tồn', () => {
  it('thẻ kho mới nhất trước, kèm ngăn, chứng từ gốc, người làm; Kho không thấy giá', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId: v } = await createVariant(c.companyId);
    const { rows } = await testPool().query<{ account_id: string }>(
      'select account_id from core.memberships where company_id = $1 limit 1',
      [c.companyId],
    );
    await receive(c.companyId, v, 3, 1000, rows[0]!.account_id);
    await receive(c.companyId, v, 2, 1000);
    const res = await inv(c.ceo.token).get(`/stock/${v}`);
    expect(res.status).toBe(200);
    StockDetail.parse(res.body);
    expect(res.body.level).toMatchObject({ variantId: v, onHand: 5 });
    expect(res.body.moves).toHaveLength(2);
    expect(res.body.moves[0]).toEqual({
      id: expect.any(String),
      area: 'stock',
      qtyChange: 2,
      onHandAfter: 5,
      document: { id: expect.any(String), number: expect.stringMatching(/^KK-/), type: 'stocktake', kind: 'manual' },
      unitCost: 1000,
      doneAt: expect.any(String),
      doneBy: null,
    });
    expect(res.body.moves[1]).toMatchObject({ onHandAfter: 3, doneBy: expect.any(String) });
    const byKho = await inv(kho).get(`/stock/${v}`);
    expect(byKho.body.moves[0].unitCost).toBeNull();
    expect(byKho.body.level.avgCost).toBeNull();
  });

  /** Thẻ kho của SKU trên một phiếu kho đã ghi sổ, chèn bằng role chủ bảng (luồng lập phiếu làm ở #266, B3). */
  async function docMove(
    companyId: string,
    variantId: string,
    d: { kind: StockDocumentKind; number: string; isOpening?: boolean; sourceType?: string | null },
    m: { qty: number; balanceAfter: number; bucket?: 'on_hand' | 'quarantine'; doneBy?: string | null },
  ): Promise<string> {
    const byPackage = d.kind === 'shipment' || d.kind === 'shipment_reversal';
    const sourceType = byPackage ? 'package' : (d.sourceType ?? null);
    const doc = await testPool().query<{ id: string }>(
      `insert into product.stock_documents
         (company_id, number, kind, status, area, counted_at, is_opening, source_type, source_id, posted_at)
       values ($1, $2, $3::product.stock_document_kind, 'posted', $4, case when $3::product.stock_document_kind = 'stocktake' then now() end, $5, $6, $7, now()) returning id`,
      [companyId, d.number, d.kind, m.bucket ?? 'on_hand', d.isOpening ?? false, sourceType, sourceType ? randomUUID() : null],
    );
    const documentId = doc.rows[0]!.id;
    await rawMove(companyId, variantId, { ...m, sourceType: 'stock_document', sourceId: documentId });
    return documentId;
  }

  /** Một dòng thẻ kho trỏ chứng từ bất kỳ (kể cả không tồn tại). */
  async function rawMove(
    companyId: string,
    variantId: string,
    m: { qty: number; balanceAfter: number; bucket?: 'on_hand' | 'quarantine'; doneBy?: string | null; sourceType: string; sourceId: string },
  ) {
    await testPool().query(
      `insert into product.stock_moves (company_id, variant_id, bucket, qty_change, balance_after, source_type, source_id, done_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [companyId, variantId, m.bucket ?? 'on_hand', m.qty, m.balanceAfter, m.sourceType, m.sourceId, m.doneBy ?? null],
    );
  }

  /** Công ty có Kho lập đề nghị, Kho nhận hàng và một NCC, để ghi sổ phiếu nhận qua API. */
  async function purchasingTeam() {
    const c = await createCompany();
    const kho = await addMember(c.companyId, 'warehouse');
    const t = { ceo: c.ceo.token, requester: (await addMember(c.companyId, 'warehouse')).token, kho: kho.token };
    return { c, t, khoId: kho.accountId, supplierId: (await createSupplier(c.ceo.token)).id };
  }

  async function detail(token: string, variantId: string) {
    const res = await inv(token).get(`/stock/${variantId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return StockDetail.parse(res.body);
  }

  const documentsOf = async (token: string, variantId: string) =>
    (await detail(token, variantId)).moves.map((m) => ({ number: m.document.number, type: m.document.type, kind: m.document.kind }));

  it('AC3: ngăn stock và quarantine, onHandAfter là số của ngăn đó', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await docMove(c.companyId, v, { kind: 'stocktake', number: 'KK-000001' }, { qty: 5, balanceAfter: 5 });
    await docMove(c.companyId, v, { kind: 'to_quarantine', number: 'CX-000001' }, { qty: 2, balanceAfter: 2, bucket: 'quarantine' });

    const { moves } = await detail(c.ceo.token, v);

    expect(moves.map((m) => [m.area, m.qtyChange, m.onHandAfter])).toEqual([
      ['quarantine', 2, 2],
      ['stock', 5, 5],
    ]);
  });

  it('AC4: phiếu nhận → { id: receiptId, number: NH-000001, type: goods_receipt, kind: purchase }, doneBy là tên người ghi sổ', async () => {
    const { c, t, khoId, supplierId } = await purchasingTeam();
    const { variantId: v } = await createVariant(c.companyId);
    const receipt = await postedReceipt(t, supplierId, v, { accepted: 4 });
    const { rows } = await testPool().query<{ full_name: string }>('select full_name from core.accounts where id = $1', [khoId]);

    const { moves } = await detail(c.ceo.token, v);

    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      area: 'stock',
      qtyChange: 4,
      onHandAfter: 4,
      document: { id: receipt.receiptId, number: 'NH-000001', type: 'goods_receipt', kind: 'purchase' },
      doneBy: rows[0]!.full_name,
    });
  });

  it('AC5: XK-000001 → shipment, order; DX-000001 → shipment_reversal, order; doneBy null', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await docMove(c.companyId, v, { kind: 'shipment', number: 'XK-000001' }, { qty: -2, balanceAfter: -2 });
    await docMove(c.companyId, v, { kind: 'shipment_reversal', number: 'DX-000001' }, { qty: 2, balanceAfter: 0 });

    const { moves } = await detail(c.ceo.token, v);

    expect(moves.map((m) => [m.document.number, m.document.type, m.document.kind, m.doneBy])).toEqual([
      ['DX-000001', 'shipment_reversal', 'order', null],
      ['XK-000001', 'shipment', 'order', null],
    ]);
  });

  it('AC6: kiểm kê tay → manual; kiểm kê đầu kỳ, xuất huỷ có source_type, return_inspection → auto', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await docMove(c.companyId, v, { kind: 'stocktake', number: 'KK-000001', isOpening: true }, { qty: 10, balanceAfter: 10 });
    await docMove(c.companyId, v, { kind: 'stocktake', number: 'KK-000002' }, { qty: -1, balanceAfter: 9 });
    await docMove(c.companyId, v, { kind: 'return_inspection', number: 'KT-000001', sourceType: 'package' }, { qty: 1, balanceAfter: 1, bucket: 'quarantine' });
    await docMove(c.companyId, v, { kind: 'write_off', number: 'XH-000001', sourceType: 'stock_document' }, { qty: -1, balanceAfter: 0, bucket: 'quarantine' });

    expect(await documentsOf(c.ceo.token, v)).toEqual([
      { number: 'XH-000001', type: 'write_off', kind: 'auto' },
      { number: 'KT-000001', type: 'return_inspection', kind: 'auto' },
      { number: 'KK-000002', type: 'stocktake', kind: 'manual' },
      { number: 'KK-000001', type: 'stocktake', kind: 'auto' },
    ]);
  });

  it('Review Focus 1: một SKU có kiểm kê tay, phiếu nhận NH- và phiếu xuất XK- → mỗi dòng đúng số, loại, nhóm của nó', async () => {
    const { c, t, supplierId } = await purchasingTeam();
    const { variantId: v } = await createVariant(c.companyId);
    await docMove(c.companyId, v, { kind: 'stocktake', number: 'KK-000001' }, { qty: 2, balanceAfter: 2 });
    await postedReceipt(t, supplierId, v, { accepted: 3 });
    await docMove(c.companyId, v, { kind: 'shipment', number: 'XK-000001' }, { qty: -1, balanceAfter: 4 });

    expect(await documentsOf(c.ceo.token, v)).toEqual([
      { number: 'XK-000001', type: 'shipment', kind: 'order' },
      { number: 'NH-000001', type: 'goods_receipt', kind: 'purchase' },
      { number: 'KK-000001', type: 'stocktake', kind: 'manual' },
    ]);
  });

  it('Review Focus 4: dòng gắn phiếu trả NCC TN- → { number: TN-000001, type: supplier_return, kind: purchase }', async () => {
    const { c, t, supplierId } = await purchasingTeam();
    const { variantId: v } = await createVariant(c.companyId);
    const { returnId } = await postedReceipt(t, supplierId, v, { accepted: 2, defectKept: 1 });
    await rawMove(c.companyId, v, { qty: -1, balanceAfter: 0, bucket: 'quarantine', sourceType: 'supplier_return', sourceId: returnId! });

    const [latest] = (await detail(c.ceo.token, v)).moves;

    expect(latest).toMatchObject({
      area: 'quarantine',
      document: { id: returnId, number: 'TN-000001', type: 'supplier_return', kind: 'purchase' },
    });
  });

  it('Review Focus 2: SKU chưa có dòng thẻ kho → moves [], không tra số phiếu của purchasing', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    const purchaseNumbers = vi.fn(async () => new Map<string, string>());

    const result = await getStock(
      { incomingOf: async () => new Map(), purchaseNumbers },
      { companyId: c.companyId, accountId: randomUUID(), canCost: true },
      v,
    );

    expect(result.moves).toEqual([]);
    expect(purchaseNumbers).not.toHaveBeenCalled();
    expect((await detail(c.ceo.token, v)).moves).toEqual([]);
  });

  it('AC7: dòng thẻ kho trỏ chứng từ không tồn tại → 500', async () => {
    const c = await createCompany();
    const [x, y] = [await createVariant(c.companyId), await createVariant(c.companyId)];
    await rawMove(c.companyId, x.variantId, { qty: 1, balanceAfter: 1, sourceType: 'stock_document', sourceId: randomUUID() });
    await rawMove(c.companyId, y.variantId, { qty: 1, balanceAfter: 1, sourceType: 'goods_receipt', sourceId: randomUUID() });

    for (const v of [x.variantId, y.variantId]) {
      const res = await inv(c.ceo.token).get(`/stock/${v}`);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('internal_error');
    }
  });
});

describe('ngưỡng tồn', () => {
  it('dưới ngưỡng tính cả đang về; bằng ngưỡng là dưới và Sắp hết; SKU ngừng bán thì không (Documents/25 mục 7.2, 7.5)', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const [x, y, z] = [await createVariant(c.companyId), await createVariant(c.companyId), await createVariant(c.companyId)];
    for (const v of [x, y, z]) {
      await receive(c.companyId, v.variantId, 5, 1000);
      await inv(c.ceo.token).put(`/stock/${v.variantId}/reorder-rule`, { minQty: 5, version: 1 });
    }
    const supplier = await createSupplier(c.ceo.token);
    await orderedRequest({ requester: kho, ceo: c.ceo.token }, supplier.id, [{ variantId: y.variantId, quantity: 1, unitCost: 1000 }]);
    await testPool().query("update product.product_variants set business_status = 'discontinued' where id = $1", [z.variantId]);
    const items = (await inv(c.ceo.token).get('/stock')).body.items as { variantId: string; incoming: number; belowMin: boolean; state: string }[];
    const by = Object.fromEntries(items.map((i) => [i.variantId, i]));
    expect(by[x.variantId]).toMatchObject({ incoming: 0, belowMin: true, state: 'low' });
    expect(by[y.variantId]).toMatchObject({ incoming: 1, belowMin: false, state: 'low' });
    expect(by[z.variantId]).toMatchObject({ belowMin: false });
  });

  it('đặt ngưỡng khi chưa có dòng tồn (version 0): belowMin, ghi nhật ký trước/sau', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const res = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 5, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minQty: 5, belowMin: true, reorderVersion: 2 });
    const audit = await testPool().query(
      "select action, before, after from core.audit_logs where entity_type = 'product.stock_levels.min_qty' and entity_id = $1",
      [v],
    );
    expect(audit.rows).toEqual([{ action: 'create', before: null, after: { minQty: 5 } }]);
  });

  it('minQty null bỏ ngưỡng; sai dạng → 422 errors.minQty', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const set = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 });
    const cleared = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: null, version: set.body.reorderVersion });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ minQty: null, belowMin: false });
    const bad = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: -1, version: cleared.body.reorderVersion });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('minQty');
  });

  it('version cũ → 409 version_conflict kèm current là StockLevel', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 });
    const res = await inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 4, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current).toMatchObject({ variantId: v, minQty: 3 });
  });

  it('hai người cùng đặt ngưỡng lần đầu: một 200, một 409, không 500', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const results = await Promise.all([
      inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 1, version: 0 }),
      inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 2, version: 0 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('người khác vừa đặt ngưỡng lần đầu trong lúc mình chờ khoá → 409, không ghi đè', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    // Giao dịch kia đã tạo dòng tồn và đặt ngưỡng 1 nhưng chưa commit: lúc request đọc thì chưa thấy dòng nào.
    const res = await raceBehindLock(
      (h) =>
        h.query("insert into product.stock_levels (company_id, variant_id, min_qty, version) values ($1, $2, 1, 2)", [A.companyId, v]),
      1,
      () => inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 2, version: 0 }),
    );
    expect(res.status).toBe(409);
    expect(res.body.current).toMatchObject({ minQty: 1 });
  });
});

describe('quyền và công ty khác', () => {
  it('Kho đặt ngưỡng → 403; Sale xem tồn → 403', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    expect((await inv(A.kho).put(`/stock/${v}/reorder-rule`, {})).body.type).toBe('/problems/forbidden');
    expect((await inv(A.sale).get('/stock')).body.type).toBe('/problems/forbidden');
  });

  it('biến thể của công ty khác → 404 cho chi tiết và ngưỡng; danh sách A không có dòng B', async () => {
    const { variantId: theirs } = await createVariant(B.companyId);
    expect((await inv(A.ceo).get(`/stock/${theirs}`)).status).toBe(404);
    expect((await inv(A.ceo).put(`/stock/${theirs}/reorder-rule`, { minQty: 1, version: 0 })).status).toBe(404);
    expect((await inv(A.ceo).get('/stock/khong-phai-uuid')).status).toBe(404);
    expect((await inv(B.ceo).get(`/stock/${theirs}`)).body.level.minQty).toBeNull();
    const ids = (await inv(A.ceo).get('/stock?pageSize=100')).body.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).not.toContain(theirs);
  });

  it('thu quyền giá vốn thì lần gọi sau nhận null ngay (A1)', async () => {
    const role = await createCustomRole(A.companyId, ['inventory.stock.view', 'inventory.cost.view']);
    const user = (await addMember(A.companyId, role)).token;
    expect((await inv(user).get('/stock')).body.summary.totalValue).not.toBeNull();
    await revokePermission(role, 'inventory.cost.view');
    expect((await inv(user).get('/stock')).body.summary.totalValue).toBeNull();
  });

  it('chưa có route phiếu kho cũ (/documents) trước issue phiếu kho có duyệt', async () => {
    expect((await inv(A.ceo).get('/documents')).status).toBe(404);
  });
});

describe('Swagger (#162)', () => {
  it('StockPage.summary có quarantineCount, negativeCount; StockLevel có state', async () => {
    const { components } = (await request(testApp()).get('/api/openapi.json')).body;
    const summary = components.schemas.StockPage.properties.summary;
    expect(summary.required).toEqual(expect.arrayContaining(['quarantineCount', 'negativeCount']));
    expect(components.schemas.StockLevel.properties.state.enum).toEqual(['in_stock', 'low', 'out']);
  });
});
