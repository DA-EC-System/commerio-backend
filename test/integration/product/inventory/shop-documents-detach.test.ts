import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { detachShopStockDocuments } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from './helpers.ts';

// #398: xoá gian hàng đã ngắt. Phiếu kho của gian hàng: nháp, chờ duyệt thì xoá (cả dòng); đã ghi sổ, từ chối, huỷ thì
// giữ, cắt `shop_id`, thêm ghi chú. Tồn và thẻ kho không đổi.

const db = testPool();
let companyId: string;
let variantId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ variantId } = await createVariant(companyId));
  await receive(companyId, variantId, 10, 100000);
});

interface DocInput {
  kind: string;
  status: 'draft' | 'pending' | 'posted';
  sourceType?: string | null;
  sourceId?: string | null;
  shopId?: string | null;
  orderId?: string | null;
  note?: string | null;
}

/** Một phiếu kho kèm một dòng, chèn bằng role chủ bảng. */
async function doc(d: DocInput): Promise<string> {
  const posted = d.status === 'posted';
  const { rows } = await db.query<{ id: string }>(
    `insert into product.stock_documents (company_id, number, kind, status, counted_at, is_opening, source_type, source_id,
       shop_id, order_id, note, posted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [
      companyId,
      `PK-${randomUUID().slice(0, 8)}`,
      d.kind,
      d.status,
      d.kind === 'stocktake' ? new Date() : null,
      d.sourceType === 'shop_setup',
      d.sourceType ?? null,
      d.sourceId ?? null,
      d.shopId ?? null,
      d.orderId ?? null,
      d.note ?? null,
      posted ? new Date() : null,
    ],
  );
  await db.query('insert into product.stock_document_lines (company_id, document_id, variant_id, quantity) values ($1, $2, $3, 1)', [
    companyId,
    rows[0]!.id,
    variantId,
  ]);
  return rows[0]!.id;
}

const docRow = async (id: string) =>
  (
    await db.query<{ status: string; shop_id: string | null; note: string | null; source_id: string | null }>(
      'select status, shop_id, note, source_id from product.stock_documents where id = $1',
      [id],
    )
  ).rows[0];
const lineCount = async (id: string) =>
  Number((await db.query<{ n: string }>('select count(*) as n from product.stock_document_lines where document_id = $1', [id])).rows[0]!.n);

/** Gian hàng có: phiếu đầu kỳ đã ghi sổ, phiếu XK đã ghi sổ theo kiện, phiếu KT nháp có `shop_id`, kiểm kê đầu kỳ chờ duyệt. */
async function seed() {
  const shopId = randomUUID();
  const packageId = randomUUID();
  const orderId = randomUUID();
  const opening = await doc({ kind: 'stocktake', status: 'posted', sourceType: 'shop_setup', sourceId: shopId, note: 'Kiểm kê đầu kỳ' });
  const shipment = await doc({ kind: 'shipment', status: 'posted', sourceType: 'package', sourceId: packageId, orderId });
  const inspection = await doc({ kind: 'return_inspection', status: 'draft', sourceType: 'package', sourceId: randomUUID(), shopId });
  const pendingOpening = await doc({ kind: 'stocktake', status: 'pending', sourceType: 'shop_setup', sourceId: shopId });
  const otherShop = await doc({ kind: 'shipment', status: 'posted', sourceType: 'package', sourceId: randomUUID(), shopId: randomUUID() });
  const scope = {
    shopId,
    shopName: 'Shop Thử Xoá',
    orderIds: [orderId],
    packageIds: [packageId],
    returnRequestIds: [],
    parcelIds: [],
  };
  return { scope, opening, shipment, inspection, pendingOpening, otherShop };
}

describe('tách phiếu kho khỏi gian hàng bị xoá (#398)', () => {
  it('xoá phiếu nháp, chờ duyệt; giữ phiếu đã ghi sổ, cắt shop_id', async () => {
    const s = await seed();
    const otherBefore = await docRow(s.otherShop);

    const result = await withCompany(companyId, () => detachShopStockDocuments(s.scope));

    expect(result).toEqual({ deleted: 2, detached: 2 });
    for (const id of [s.inspection, s.pendingOpening]) {
      expect(await docRow(id)).toBeUndefined();
      expect(await lineCount(id)).toBe(0);
    }
    expect(await docRow(s.opening)).toEqual({
      status: 'posted',
      shop_id: null,
      note: 'Kiểm kê đầu kỳ\nGian hàng Shop Thử Xoá đã xoá',
      source_id: s.scope.shopId,
    });
    expect(await docRow(s.shipment)).toEqual({
      status: 'posted',
      shop_id: null,
      note: 'Gian hàng Shop Thử Xoá đã xoá',
      source_id: s.scope.packageIds[0],
    });
    expect(await lineCount(s.opening)).toBe(1);
    expect(await docRow(s.otherShop)).toEqual(otherBefore);
  });

  it('nhận phiếu theo yêu cầu trả, kiện trả lạc, đơn của gian hàng', async () => {
    const shopId = randomUUID();
    const requestId = randomUUID();
    const parcelId = randomUUID();
    const orderId = randomUUID();
    const byRequest = await doc({ kind: 'return_inspection', status: 'posted', sourceType: 'return_request', sourceId: requestId });
    const byParcel = await doc({ kind: 'return_inspection', status: 'draft', sourceType: 'unmatched_parcel', sourceId: parcelId });
    const byOrder = await doc({ kind: 'write_off', status: 'posted', orderId });
    const unrelated = await doc({ kind: 'write_off', status: 'draft' });

    const result = await withCompany(companyId, () =>
      detachShopStockDocuments({ shopId, shopName: 'Shop B', orderIds: [orderId], packageIds: [], returnRequestIds: [requestId], parcelIds: [parcelId] }),
    );

    expect(result).toEqual({ deleted: 1, detached: 2 });
    expect(await docRow(byParcel)).toBeUndefined();
    expect((await docRow(byRequest))!.note).toBe('Gian hàng Shop B đã xoá');
    expect((await docRow(byOrder))!.note).toBe('Gian hàng Shop B đã xoá');
    expect((await docRow(unrelated))!.status).toBe('draft');
  });

  it('tồn thực và thẻ kho không đổi', async () => {
    const s = await seed();
    const levels = async () =>
      (await db.query('select on_hand, reserved, quarantine from product.stock_levels where company_id = $1 order by variant_id', [companyId])).rows;
    const moves = async () =>
      Number((await db.query<{ n: string }>('select count(*) as n from product.stock_moves where company_id = $1', [companyId])).rows[0]!.n);
    const [levelsBefore, movesBefore] = [await levels(), await moves()];

    await withCompany(companyId, () => detachShopStockDocuments(s.scope));

    expect(await levels()).toEqual(levelsBefore);
    expect(await moves()).toBe(movesBefore);
  });
});
