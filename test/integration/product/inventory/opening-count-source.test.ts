import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOpeningStocktake } from '#src/modules/product/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { inv, receive } from './helpers.ts';

// Tồn trên sàn và nguồn số đếm của phiếu kiểm kê đầu kỳ (#569, Documents/21 §18.6.2 `StockDocLine.platformStock`,
// `countSource`; Documents/19 `count_source`). Tồn sàn đọc từ bản sao SKU sàn của channel qua `ctx.platformStockOf`.

interface Line {
  variantId: string;
  counted: number | null;
  platformStock: number | null;
  countSource: 'manual' | 'platform' | null;
}

/** Gian hàng có bản sao SKU sàn: v1 liên kết SKU sàn tồn 4; v2 chỉ có listing đã gỡ (tồn 9); v3 không liên kết. */
async function setup() {
  const c = await createCompany();
  const [v1, v2, v3] = [
    (await createVariant(c.companyId)).variantId,
    (await createVariant(c.companyId)).variantId,
    (await createVariant(c.companyId)).variantId,
  ];
  await receive(c.companyId, v1, 7, 50000);
  const db = testPool();
  const shopId = (
    await db.query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop thử') returning id`,
      [c.companyId, randomUUID()],
    )
  ).rows[0]!.id;
  for (const [variantId, status, quantity] of [
    [v1, 'live', 4],
    [v2, 'delisted', 9],
  ] as const) {
    const ext = `sku-${randomUUID().slice(0, 10)}`;
    await db.query(
      `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity)
       values ($1, $2, $3, $4, $4, 'Cốc thử', 'live', $5)`,
      [c.companyId, shopId, `item-${ext}`, ext, quantity],
    );
    await db.query(
      `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku, external_product_id, external_sku_id)
       values ($1, $2, $3, $4, $5, $6, $5)`,
      [c.companyId, shopId, variantId, status, ext, `item-${ext}`],
    );
  }
  const { documentId } = await withCompany(c.companyId, () => createOpeningStocktake(shopId, { actorId: null }));
  return { ...c, v1, v2, v3, shopId, documentId };
}

const byVariant = (lines: Line[]) => new Map(lines.map((l) => [l.variantId, l]));

describe('kiểm kê đầu kỳ: platformStock, countSource (#569)', () => {
  it('platformStock cộng từ bản sao SKU sàn của listing chưa gỡ; không liên kết thì null; countSource null khi chưa đếm', async () => {
    const s = await setup();
    const doc = (await inv(s.ceo.token).get(`/documents/${s.documentId}`)).body;
    const lines = byVariant(doc.lines);
    expect([s.v1, s.v2, s.v3].map((id) => lines.get(id)!.platformStock)).toEqual([4, null, null]);
    expect([s.v1, s.v2, s.v3].map((id) => lines.get(id)!.countSource)).toEqual([null, null, null]);
  });

  it('PUT: platform khớp tồn sàn giữ platform; lệch hoặc không có tồn sàn ghi manual; thiếu ghi manual; chưa đếm null', async () => {
    const s = await setup();
    const doc = (await inv(s.ceo.token).get(`/documents/${s.documentId}`)).body;
    const saved = await inv(s.ceo.token).put(`/documents/${s.documentId}`, {
      note: doc.note,
      lines: [
        { variantId: s.v1, counted: 4, countSource: 'platform' },
        { variantId: s.v2, counted: 9, countSource: 'platform' },
        { variantId: s.v3, counted: 2 },
      ],
      version: doc.version,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    let lines = byVariant(saved.body.lines);
    expect([s.v1, s.v2, s.v3].map((id) => lines.get(id)!.countSource)).toEqual(['platform', 'manual', 'manual']);

    const again = await inv(s.ceo.token).put(`/documents/${s.documentId}`, {
      note: doc.note,
      lines: [
        { variantId: s.v1, counted: 5, countSource: 'platform' },
        { variantId: s.v2, counted: null, countSource: 'platform' },
        { variantId: s.v3, counted: 2, countSource: 'manual' },
      ],
      version: saved.body.version,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    lines = byVariant(again.body.lines);
    expect([s.v1, s.v2, s.v3].map((id) => lines.get(id)!.countSource)).toEqual(['manual', null, 'manual']);
  });

  it('nguồn số đếm giữ sau khi ghi sổ', async () => {
    const s = await setup();
    const doc = (await inv(s.ceo.token).get(`/documents/${s.documentId}`)).body;
    const saved = await inv(s.ceo.token).put(`/documents/${s.documentId}`, {
      note: doc.note,
      lines: [
        { variantId: s.v1, counted: 4, countSource: 'platform' },
        { variantId: s.v2, counted: 0 },
        { variantId: s.v3, counted: 0 },
      ],
      version: doc.version,
    });
    const sent = await inv(s.ceo.token).post(`/documents/${s.documentId}/submit`, { version: saved.body.version });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const ok = await inv(s.ceo.token).post(`/documents/${s.documentId}/approve`, { version: sent.body.version });
    expect([ok.status, ok.body.status]).toEqual([200, 'posted']);
    expect(byVariant(ok.body.lines).get(s.v1)!.countSource).toBe('platform');
  });

  it('phiếu kiểm kê lập tay: bỏ qua countSource, platformStock luôn null', async () => {
    const s = await setup();
    const created = await inv(s.ceo.token).post('/documents', {
      type: 'stocktake',
      area: 'stock',
      note: '',
      lines: [{ variantId: s.v1, counted: 4, countSource: 'platform' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.lines[0]).toMatchObject({ platformStock: null, countSource: null });
    const saved = await inv(s.ceo.token).put(`/documents/${created.body.id}`, {
      note: '',
      lines: [{ variantId: s.v1, counted: 4, countSource: 'platform' }],
      version: created.body.version,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.lines[0]).toMatchObject({ platformStock: null, countSource: null });
  });

  it('CHECK: count_source có giá trị thì counted_qty phải có', async () => {
    const s = await setup();
    await expect(
      testPool().query(
        `update product.stock_document_lines set count_source = 'manual', counted_qty = null where document_id = $1`,
        [s.documentId],
      ),
    ).rejects.toThrow(/stock_document_lines_count_source/);
  });
});
