import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOpeningStocktake } from '#src/modules/product/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
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
    // `countedAt` là lúc lưu số đếm (21 mục 11.2), khác `postedAt` là lúc ghi sổ; `postedAt` trùng `posted_at` đã lưu
    const saved = (
      await testPool().query<{ counted_at: Date; posted_at: Date }>(
        'select counted_at, posted_at from product.stock_documents where id = $1',
        [documentId],
      )
    ).rows[0]!;
    expect(rows[0].payload.countedAt).toBe(saved.counted_at.toISOString());
    expect(rows[0].payload.postedAt).toBe(saved.posted_at.toISOString());
    expect(rows[0].payload.countedAt).not.toBe(rows[0].payload.postedAt);
    // Sau khi ghi sổ, gian hàng lập được phiếu đầu kỳ mới (phiếu cũ không còn mở)
    const next = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    expect(next.created).toBe(true);
  });

  it('phiếu đầu kỳ hơn 200 dòng vẫn sửa được số đếm; phiếu kiểm kê lập tay hơn 200 dòng vẫn 422 (#278)', async () => {
    const s = await setup();
    const many = [s.v1, s.v2];
    while (many.length < 205) many.push((await createVariant(s.companyId)).variantId);
    const { documentId } = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: null }));
    const doc = (await inv(s.ceo.token).get(`/documents/${documentId}`)).body;
    expect(doc.lines).toHaveLength(205);
    const lines = many.map((variantId) => ({ variantId, counted: 1 }));
    const saved = await inv(s.ceo.token).put(`/documents/${documentId}`, { note: doc.note, lines, version: doc.version });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.lines).toHaveLength(205);
    const manual = await inv(s.ceo.token).post('/documents', { type: 'stocktake', area: 'stock', note: '', lines });
    expect([manual.status, manual.body.code]).toEqual([422, 'validation_failed']);
    expect(manual.body.errors.lines).toBeDefined();
    const small = (await inv(s.ceo.token).post('/documents', { type: 'stocktake', area: 'stock', note: '', lines: lines.slice(0, 1) })).body;
    const grown = await inv(s.ceo.token).put(`/documents/${small.id}`, { note: '', lines, version: small.version });
    expect([grown.status, grown.body.code]).toEqual([422, 'validation_failed']);
    expect(grown.body.errors.lines).toBeDefined();
  });

  describe('người lập là người gửi duyệt, không phải người bấm thiết lập gian hàng (#278 review I1)', () => {
    async function ceoId(email: string) {
      return (await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [email])).rows[0]!.id;
    }
    async function submitAndApprove(submitter: string, approver: string, documentId: string) {
      const doc = (await inv(submitter).get(`/documents/${documentId}`)).body;
      const sent = await inv(submitter).post(`/documents/${documentId}/submit`, { version: doc.version });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      return inv(approver).post(`/documents/${documentId}/approve`, { version: sent.body.version });
    }

    it('CEO kết nối, kho gửi duyệt, CEO duyệt: không tự duyệt; lịch sử ghi CEO ở bước lập', async () => {
      const s = await setup();
      const ceo = await ceoId(s.ceo.email);
      const kho = await addMember(s.companyId, 'warehouse');
      const { documentId } = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: ceo }));
      const draft = (await inv(s.ceo.token).get(`/documents/${documentId}`)).body;
      expect(draft.createdById).toBe('');
      expect(draft.statusHistory[0]).toMatchObject({ to: 'draft', by: { id: ceo } });
      const ok = await submitAndApprove(kho.token, s.ceo.token, documentId);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.createdById).toBe(kho.accountId);
      expect(ok.body.statusHistory.at(-1)).toMatchObject({ to: 'posted', selfApproved: false });
    });

    it('CEO kết nối rồi tự gửi, tự duyệt: tự duyệt có nhãn', async () => {
      const s = await setup();
      const ceo = await ceoId(s.ceo.email);
      const { documentId } = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: ceo }));
      const ok = await submitAndApprove(s.ceo.token, s.ceo.token, documentId);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.statusHistory.at(-1)).toMatchObject({ to: 'posted', selfApproved: true });
    });

    it('người có quyền lập và duyệt (không phải CEO) tự gửi rồi tự duyệt: 409 second_person_required', async () => {
      const s = await setup();
      const ceo = await ceoId(s.ceo.email);
      const role = await createCustomRole(s.companyId, ['inventory.stock.view', 'inventory.receipt.create', 'inventory.document.approve']);
      const lapDuyet = await addMember(s.companyId, role);
      const { documentId } = await withCompany(s.companyId, () => createOpeningStocktake(s.shopId, { actorId: ceo }));
      const self = await submitAndApprove(lapDuyet.token, lapDuyet.token, documentId);
      expect([self.status, self.body.code]).toEqual([409, 'second_person_required']);
    });
  });
});
