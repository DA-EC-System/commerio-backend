import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOpeningStocktake } from '#src/modules/product/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { inv, receive } from './helpers.ts';

// Cổng kiểm kê đầu kỳ cho gian hàng đầu tiên (#245; Documents/21 mục 11.3, 11.2 `inventory.stocktake_posted`; 25 §6.1).

async function setup() {
  const c = await createCompany();
  const v1 = (await createVariant(c.companyId)).variantId;
  const v2 = (await createVariant(c.companyId)).variantId;
  await receive(c.companyId, v1, 7, 50000);
  return { ...c, v1, v2, shopId: randomUUID() };
}

describe('createOpeningStocktake (#245)', () => {
  it('lập nháp nguồn shop_setup, mỗi SKU đang bán một dòng, số đếm điền sẵn bằng tồn thực', async () => {
    const s = await setup();
    const res = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    expect(res).toMatchObject({ created: true, number: expect.stringMatching(/^KK-/) });
    const doc = (await inv(s.ceo.token).get(`/documents/${res.documentId}`)).body;
    expect(doc).toMatchObject({ type: 'stocktake', status: 'draft', kind: 'auto', area: 'stock', source: null });
    expect(doc.lines.map((l: { variantId: string; bookQty: number; counted: number }) => [l.variantId, l.bookQty, l.counted]).sort()).toEqual(
      [
        [s.v1, 7, 7],
        [s.v2, 0, 0],
      ].sort(),
    );
  });

  it('gọi hai lần chỉ ra một phiếu nháp; hai lần đua nhau cũng vậy', async () => {
    const s = await setup();
    const first = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    const again = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    expect(again).toEqual({ ...first, created: false });
    const other = randomUUID();
    const raced = await Promise.all([
      withCompany(s.companyId, () => createOpeningStocktake(other, { actorId: null })),
      withCompany(s.companyId, () => createOpeningStocktake(other, { actorId: null })),
    ]);
    expect(new Set(raced.map((r) => r.documentId)).size).toBe(1);
    expect(raced.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await testPool().query(
      "select count(*)::int as n from product.stock_documents where source_type = 'shop_setup' and source_id = $1",
      [other],
    );
    expect(rows[0].n).toBe(1);
  });

  it('ghi sổ phát inventory.stocktake_posted đúng một lần, kèm source shop_setup', async () => {
    const s = await setup();
    const { documentId } = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    const doc = (await inv(s.ceo.token).get(`/documents/${documentId}`)).body;
    const counted = (
      await inv(s.ceo.token).put(`/documents/${documentId}`, {
        note: doc.note,
        lines: [
          { variantId: s.v1, counted: 6 },
          { variantId: s.v2, counted: 3 },
        ],
        version: doc.version,
      })
    ).body;
    const sent = (await inv(s.ceo.token).post(`/documents/${documentId}/submit`, { version: counted.version })).body;
    const ok = await inv(s.ceo.token).post(`/documents/${documentId}/approve`, { version: sent.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await inv(s.ceo.token).post(`/documents/${documentId}/approve`, { version: ok.body.version });
    expect(again.status).toBe(409);
    const { rows } = await testPool().query(
      "select payload from core.outbox_messages where type = 'inventory.stocktake_posted' and key = $1",
      [documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ source: { type: 'shop_setup', shopId: s.shopId } });
    // Sau khi ghi sổ, gian hàng lập được phiếu đầu kỳ mới (phiếu cũ không còn mở)
    const next = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    expect(next.created).toBe(true);
  });
});
