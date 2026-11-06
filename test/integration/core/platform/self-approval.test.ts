import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { CompanyAuditLogPage } from '#src/modules/core/audit/api/schemas.ts';
import { SelfApprovalsResponse } from '#src/modules/insight/report/api/schemas.ts';
import { PurchaseRequest } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testApp } from '../../helpers/http.ts';
import { act, createRequest, createSupplier } from '../../product/purchasing/helpers.ts';

// Nhãn tự duyệt trong lịch sử, nhật ký thao tác và báo cáo CEO (#246; Documents/21 mục 14.1, 25 mục 11;
// US-CT-10 dòng 2, US-NH-03 dòng 9).

const get = (token: string, path: string) =>
  request(testApp()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

let ceo: string;
let kho: string;
let supplierId: string;
let variantId: string;

beforeAll(async () => {
  const c = await createCompany();
  ceo = c.ceo.token;
  kho = (await addMember(c.companyId, 'warehouse')).token;
  ({ variantId } = await createVariant(c.companyId));
  supplierId = (await createSupplier(ceo)).id;
});

/** Đề nghị do `creator` lập và gửi duyệt, CEO duyệt; trả body sau khi duyệt. */
async function approvedBy(creator: string) {
  const r = await createRequest(creator, supplierId, [{ variantId, quantity: 5, unitCost: 50000 }]);
  const sent = await act(creator, r.id, 'submit', { version: r.version });
  const res = await act(ceo, r.id, 'approve', { version: sent.body.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PurchaseRequest.parse(res.body);
}

describe('tự duyệt (#246)', () => {
  it('CEO tự lập rồi tự duyệt: bước duyệt trong statusHistory có selfApproved, các bước khác không', async () => {
    const body = await approvedBy(ceo);
    expect(body.statusHistory.map((h) => [h.to, h.selfApproved])).toEqual([
      ['draft', false],
      ['pending_approval', false],
      ['approved', true],
    ]);
  });

  it('người khác lập, CEO duyệt: không phải tự duyệt', async () => {
    const body = await approvedBy(kho);
    expect(body.statusHistory.at(-1)).toMatchObject({ to: 'approved', selfApproved: false });
  });

  it('US-CT-10 dòng 2: nhật ký thao tác có dòng tự duyệt mang mã đề nghị, lọc riêng được', async () => {
    const body = await approvedBy(ceo);
    const res = await get(ceo, '/audit/logs?selfApproved=true&pageSize=100');
    expect(res.status).toBe(200);
    const page = CompanyAuditLogPage.parse(res.body);
    expect(page.items.every((i) => i.selfApproved)).toBe(true);
    expect(page.items.find((i) => i.entityId === body.id)).toMatchObject({
      action: 'update',
      entityType: 'product.purchase_requests',
      entityLabel: body.number,
      selfApproved: true,
    });
    const all = CompanyAuditLogPage.parse((await get(ceo, '/audit/logs?pageSize=100')).body);
    expect(all.items.some((i) => !i.selfApproved)).toBe(true);
  });

  it('báo cáo CEO liệt kê lần tự duyệt trong khoảng ngày, kèm người làm', async () => {
    const body = await approvedBy(ceo);
    const res = await get(ceo, '/report/self-approvals?pageSize=100');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = SelfApprovalsResponse.parse(res.body);
    expect(report.items.find((i) => i.entityId === body.id)).toMatchObject({
      entityType: 'purchase_requests',
      action: 'approve',
      from: 'pending_approval',
      to: 'approved',
      selfApproved: true,
      by: { id: expect.any(String) },
    });
    expect(report.items.every((i) => i.selfApproved)).toBe(true);
    const past = await get(ceo, '/report/self-approvals?from=2026-01-01&to=2026-01-31');
    expect(past.body).toMatchObject({ items: [], total: 0 });
  });

  it('Kho không xem được danh sách tự duyệt của báo cáo CEO (403)', async () => {
    const res = await get(kho, '/report/self-approvals');
    expect([res.status, res.body.code]).toEqual([403, 'forbidden']);
  });
});
