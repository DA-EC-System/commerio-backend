import { beforeAll, describe, expect, it } from 'vitest';
import { BusinessStatusResult, ProductDetail } from '#src/modules/product/catalog/api/schemas.ts';
import type { BusinessAction, BusinessStatus } from '#src/modules/product/catalog/domain/business-status.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../inventory/helpers.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, uniq, valueId } from './helpers.ts';

// Đổi trạng thái kinh doanh SKU (#204, Documents/21 §17.2, §17.3; kiem-thu/ca-theo-so-do.md B1).
let companyId: string;
let ceo: string;
let ceoId: string;
let sale: string;
let kho: string;
let color: AttributeBody;
beforeAll(async () => {
  const company = await createCompany();
  companyId = company.companyId;
  ceo = company.ceo.token;
  ceoId = (await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [company.ceo.email])).rows[0]!.id;
  sale = (await addMember(companyId, 'sale')).token;
  kho = (await addMember(companyId, 'warehouse')).token;
  color = await createAttribute(ceo, uniq('Màu'), ['Đen', 'Trắng', 'Xám']);
});

/** Sản phẩm `n` SKU (1 đến 3), danh mục riêng. */
const shirt = async (n = 1) => {
  const category = await createCategory(ceo, uniq('Áo'), 'AO-{SEQ}-{VAL}');
  const values = ['Đen', 'Trắng', 'Xám'].slice(0, n).map((v) => [valueId(color, v)]);
  return createProduct(ceo, { name: uniq('Áo'), categoryId: category.id, variants: values });
};
const change = (token: string, productId: string, action: BusinessAction, variantIds?: string[]) =>
  api(token).post(`/products/${productId}/business-status`, variantIds ? { action, variantIds } : { action });
const statusOf = async (productId: string, variantId: string): Promise<BusinessStatus> =>
  (await api(ceo).get(`/products/${productId}`)).body.variants.find((v: { id: string }) => v.id === variantId).businessStatus;

/** Đưa SKU mới (`selling`) tới `state` bằng các thao tác hợp lệ. */
const PATH: Record<BusinessStatus, BusinessAction[]> = {
  selling: [],
  paused: ['pause'],
  discontinued: ['discontinue'],
  archived: ['discontinue', 'archive'],
};
async function skuAt(state: BusinessStatus) {
  const product = await shirt();
  const variantId = product.variants[0]!.id;
  for (const action of PATH[state]) expect((await change(ceo, product.id, action, [variantId])).status).toBe(200);
  return { productId: product.id, variantId };
}

describe('POST /catalog/products/:id/business-status: mũi tên đúng (B1)', () => {
  it.each([
    ['B1-01', 'selling', 'pause', 'paused'],
    ['B1-02', 'discontinued', 'pause', 'paused'],
    ['B1-03', 'paused', 'unpause', 'selling'],
    ['B1-04', 'selling', 'discontinue', 'discontinued'],
    ['B1-05', 'paused', 'discontinue', 'discontinued'],
    ['B1-06', 'discontinued', 'reactivate', 'selling'],
    ['B1-07', 'discontinued', 'archive', 'archived'],
    ['B1-08', 'archived', 'restore', 'discontinued'],
  ] as const)('%s: %s --%s--> %s', async (_code, from, action, to) => {
    const { productId, variantId } = await skuAt(from);
    const res = await change(ceo, productId, action, [variantId]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: [variantId], skipped: [] });
    const variant = res.body.product.variants.find((v: { id: string }) => v.id === variantId);
    expect(variant.businessStatus).toBe(to);
    expect(variant.archivedAt === null).toBe(to !== 'archived');
    expect(BusinessStatusResult.parse(res.body)).toEqual(res.body);
  });

  it('một lần đổi ghi một dòng lịch sử, một dòng nhật ký, một sự kiện catalog.variant_status_changed', async () => {
    const { productId, variantId } = await skuAt('selling');
    await change(ceo, productId, 'pause', [variantId]);
    const history = await testPool().query(
      'select from_state, to_state, action, actor_id, source from core.state_transitions where entity_type = $1 and entity_id = $2',
      ['product_variants', variantId],
    );
    expect(history.rows).toEqual([{ from_state: 'selling', to_state: 'paused', action: 'pause', actor_id: ceoId, source: 'user' }]);
    expect(await auditOf(variantId)).toEqual([
      { action: 'update', entity_type: 'product.product_variants', before: { businessStatus: 'selling' }, after: { businessStatus: 'paused' } },
    ]);
    const events = await testPool().query(
      "select payload from core.outbox_messages where type = 'catalog.variant_status_changed' and key = $1",
      [variantId],
    );
    expect(events.rows.map((r) => r.payload)).toEqual([
      { variantId, productId, from: 'selling', to: 'paused', changedAt: expect.any(String) },
    ]);
  });
});

describe('ca bị chặn (B1)', () => {
  const actions = ['pause', 'unpause', 'discontinue', 'reactivate', 'archive', 'restore'] as const;
  it.each(actions.flatMap((a) => [['Sale', a] as const, ['Kho', a] as const]))(
    'B1-0Nq: %s gọi %s → 403 forbidden',
    async (who, action) => {
      const { productId, variantId } = await skuAt('selling');
      const res = await change(who === 'Sale' ? sale : kho, productId, action, [variantId]);
      expect(res.status).toBe(403);
      expect(res.body.type).toBe('/problems/forbidden');
    },
  );

  it('B1-07g: SKU ngừng nhập còn tồn → 409 archive_blocked kèm lý do, trạng thái không đổi', async () => {
    const { productId, variantId } = await skuAt('discontinued');
    await receive(companyId, variantId, 3, 100000);
    const res = await change(ceo, productId, 'archive', [variantId]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/archive_blocked');
    expect(res.body.reasons).toEqual(['Còn 3 tồn thực']);
    expect(await statusOf(productId, variantId)).toBe('discontinued');
  });

  const allowed: Record<BusinessStatus, readonly BusinessAction[]> = {
    selling: ['pause', 'discontinue'],
    paused: ['unpause', 'discontinue'],
    discontinued: ['pause', 'reactivate', 'archive'],
    archived: ['restore'],
  };
  const invalid = (Object.keys(allowed) as BusinessStatus[]).flatMap((from, i) =>
    actions.filter((a) => !allowed[from].includes(a)).map((a) => [`B1-X0${i + 1}`, from, a] as const),
  );
  it.each(invalid)('%s: %s gọi %s → 409 invalid_transition kèm current, trạng thái không đổi', async (_code, from, action) => {
    const { productId, variantId } = await skuAt(from);
    const res = await change(ceo, productId, action, [variantId]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(res.body.current.id).toBe(productId);
    expect(await statusOf(productId, variantId)).toBe(from);
  });
});

describe('thao tác trên cả sản phẩm cha', () => {
  it('SKU không có thao tác này vào skipped, SKU khác vẫn đổi', async () => {
    const product = await shirt(3);
    const [a, b, c] = product.variants.map((v) => v.id) as [string, string, string];
    await change(ceo, product.id, 'pause', [c]);
    const res = await change(ceo, product.id, 'pause');
    expect(res.status).toBe(200);
    expect(res.body.applied.sort()).toEqual([a, b].sort());
    expect(res.body.skipped).toEqual([{ variantId: c, sku: expect.any(String), code: 'invalid_transition', reasons: [] }]);
  });

  it('lưu trữ cả cha: SKU còn tồn vào skipped kèm lý do, SKU khác lưu trữ', async () => {
    const product = await shirt(2);
    const [free, stocked] = product.variants.map((v) => v.id) as [string, string];
    await change(ceo, product.id, 'discontinue');
    await receive(companyId, stocked, 2, 100000);
    const res = await change(ceo, product.id, 'archive');
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([free]);
    expect(res.body.skipped).toEqual([{ variantId: stocked, sku: expect.any(String), code: 'archive_blocked', reasons: ['Còn 2 tồn thực'] }]);
  });
});

describe('đầu vào sai', () => {
  it('variantIds lặp → 422 errors.variantIds, không đổi gì', async () => {
    const { productId, variantId } = await skuAt('selling');
    const res = await change(ceo, productId, 'pause', [variantId, variantId]);
    expect(res.status).toBe(422);
    expect(res.body.errors.variantIds).toBeTruthy();
    expect(await statusOf(productId, variantId)).toBe('selling');
  });

  it('variantIds có SKU của sản phẩm khác → 422 errors.variantIds, không đổi gì', async () => {
    const mine = await skuAt('selling');
    const other = await skuAt('selling');
    const res = await change(ceo, mine.productId, 'pause', [mine.variantId, other.variantId]);
    expect(res.status).toBe(422);
    expect(res.body.errors.variantIds).toBeTruthy();
    expect(await statusOf(mine.productId, mine.variantId)).toBe('selling');
  });

  it('thao tác lạ → 422 errors.action', async () => {
    const { productId } = await skuAt('selling');
    const res = await api(ceo).post(`/products/${productId}/business-status`, { action: 'delete' });
    expect(res.status).toBe(422);
    expect(res.body.errors.action).toBeTruthy();
  });

  it('sản phẩm đã lưu trữ kiểu cũ → 409 product_archived', async () => {
    const { productId, variantId } = await skuAt('selling');
    expect((await api(ceo).delete(`/products/${productId}?version=1`)).status).toBe(204);
    const res = await change(ceo, productId, 'pause', [variantId]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/product_archived');
  });
});

describe('chi tiết sản phẩm: archiveBlockers', () => {
  it('SKU ngừng nhập còn tồn có lý do; SKU đang bán có mảng rỗng; body khớp schema', async () => {
    const product = await shirt(2);
    const [selling, stopped] = product.variants.map((v) => v.id) as [string, string];
    await change(ceo, product.id, 'discontinue', [stopped]);
    await receive(companyId, stopped, 3, 100000);
    const res = await api(ceo).get(`/products/${product.id}`);
    const byId = new Map(res.body.variants.map((v: { id: string; archiveBlockers: string[] }) => [v.id, v.archiveBlockers]));
    expect(byId.get(selling)).toEqual([]);
    expect(byId.get(stopped)).toEqual(['Còn 3 tồn thực']);
    expect(ProductDetail.parse(res.body)).toEqual(res.body);
  });
});

describe('review cuối PR 2', () => {
  it('áp SKU theo thứ tự id tăng dần dù gửi đảo: khoá dòng SKU cùng thứ tự với hệ thống tự khôi phục, không deadlock', async () => {
    const product = await shirt(3);
    const ids = product.variants.map((v) => v.id).sort();
    const res = await change(ceo, product.id, 'pause', [...ids].reverse());
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(ids);
  });

  it('người không có catalog.product.manage xem chi tiết: archiveBlockers rỗng, không lộ số tồn, số mua hàng', async () => {
    const { productId, variantId } = await skuAt('discontinued');
    await receive(companyId, variantId, 3, 100000);
    const blockersFor = async (token: string) =>
      (await api(token).get(`/products/${productId}`)).body.variants.find((v: { id: string }) => v.id === variantId).archiveBlockers;
    expect(await blockersFor(ceo)).toEqual(['Còn 3 tồn thực']);
    expect(await blockersFor(sale)).toEqual([]);
  });
});
