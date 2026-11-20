// Đổi category trên sàn (commerio-backend#467, Documents/21 §18.5): route `apply-category`, việc nền `channel.category_apply`
// với adapter giả, `Shop.categoryChangeIssues`, `PlatformCategory.pathIds`, `ListingRow.externalCategoryPath`.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldJob } from '#src/modules/core/index.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { CATEGORY_APPLY_ATTEMPTS, runCategoryApply } from '#src/modules/channel/channel/service/category-apply.ts';
import {
  type CategoryChangeInput,
  type CategoryChangeResult,
  MarketplaceError,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import type { CategoryApplyJob } from '#src/modules/channel/channel/service/shop-jobs.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const variant = (productId = randomUUID()): ListingVariant => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId,
    productName: 'Áo thun',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  };
  variants.push(v);
  return v;
};
const sizeCharts = new Map<string, string>();
const port = {
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  productSizeChartUrls: async (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (sizeCharts.has(id) ? [[id, sizeCharts.get(id)!] as const] : []))),
};
setProductPort(port);

let onChange: (productId: string, input: CategoryChangeInput) => Promise<CategoryChangeResult>;
const changeCategory = vi.fn((_t: string, productId: string, input: CategoryChangeInput) => onChange(productId, input));
const uploadImage = vi.fn(async (_t: string, url: string) => `tos/${encodeURIComponent(url)}`);
const seller = async (accessToken: string) => ({ externalShopId: accessToken.slice(4), shopName: `Shop ${accessToken.slice(4, 9)}`, region: 'VN' });
registerAdapter('tiktok', fakeAdapter({ name: 'TikTok Shop', getSeller: seller, changeCategory, uploadImage, getSkus: async () => [] }));
// Lazada chưa có `changeCategory` (PR hai của #467): 422.
registerAdapter('lazada', fakeAdapter({ name: 'Lazada', getSeller: seller, getSkus: async () => [] }));
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const shops: Record<'a' | 'b' | 'off' | 'lazada', string> = { a: '', b: '', off: '', lazada: '' };
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);
const apply = (productId: string, version: number, platform = 'tiktok', token?: string) =>
  auth(app().post(`/api/v1/channel/products/${productId}/specs/${platform}/apply-category`), token).send({ version });

/** Mã category ngẫu nhiên (bảng cây dùng chung giữa các file test). */
const catId = () => String(Math.floor(1e9 + Math.random() * 8e9));
const ROOT = catId();
const OLD = catId();
const NEW = catId();
const SIZED = catId();

async function category(externalId: string, parent: string | null, path: string, opts: { leaf?: boolean; sizeChartRule?: string } = {}) {
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, parent_external_id, name, is_leaf, path, path_search, synced_at, size_chart_rule, attributes_fetched_at)
     values ('tiktok', $1, $2, $3, $4, $5, lower($5), now(), $6, now())`,
    [externalId, parent, path.split(' > ').at(-1), opts.leaf ?? true, path, opts.sizeChartRule ?? null],
  );
}

async function connect(platform: string): Promise<string> {
  const res = await auth(app().post(`/api/v1/channel/shops/${platform}/token`)).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  await activateShop(res.body.shop.id);
  return res.body.shop.id;
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  shops.a = await connect('tiktok');
  shops.b = await connect('tiktok');
  shops.off = await connect('tiktok');
  await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [shops.off]);
  shops.lazada = await connect('lazada');
  await category(ROOT, null, 'Thời trang', { leaf: false });
  await category(OLD, ROOT, 'Thời trang > Áo cũ');
  await category(NEW, ROOT, 'Thời trang > Áo mới');
  await category(SIZED, ROOT, 'Thời trang > Áo có size', { sizeChartRule: 'required' });
});

beforeEach(() => {
  changeCategory.mockClear();
  uploadImage.mockClear();
  onChange = async () => ({ underReview: false, mismatch: [] });
});

/** Listing của biến thể trên gian hàng; `cols` ghi đè (tên cột SQL). */
async function listing(v: ListingVariant, shopId: string, cols: Record<string, unknown> = {}) {
  const all = {
    company_id: company.companyId,
    shop_id: shopId,
    variant_id: v.id,
    seller_sku: v.sku,
    status: 'live',
    content_source: 'app',
    external_product_id: `P-${randomUUID().slice(0, 8)}`,
    external_sku_id: `S-${randomUUID().slice(0, 8)}`,
    external_category_id: OLD,
    ...cols,
  };
  const keys = Object.keys(all);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
  return rows[0]!.id;
}

/** Sản phẩm hai biến thể có spec TikTok ở `target`; trả id sản phẩm, biến thể. */
async function product(target = NEW, platform = 'tiktok') {
  const productId = randomUUID();
  const v1 = variant(productId);
  const v2 = variant(productId);
  await seedSpecs(company.companyId, platform, target, [v1, v2]);
  return { productId, v1, v2 };
}

const row = async (id: string) =>
  (await testPool().query('select status, version, category_change, revision_status, external_category_id from channel.listings where id = $1', [id])).rows[0];
const jobsOf = async (productId: string) =>
  (await testPool().query<{ data: CategoryApplyJob }>("select data from pgboss.job where name = 'channel.category_apply' and data->>'productId' = $1", [productId])).rows.map(
    (r) => r.data,
  );

describe('POST /channel/products/:productId/specs/:platform/apply-category (#467)', () => {
  it('xếp một việc mỗi (gian hàng, sản phẩm sàn), listing `queued`; bỏ listing đã đúng category, chưa có mã sàn, chưa bán; gian hàng mất token thì `shop_not_connected`', async () => {
    const { productId, v1, v2 } = await product();
    const pid = `P-${randomUUID().slice(0, 8)}`;
    // Gian hàng a: hai biến thể cùng một sản phẩm sàn (ghép tay) → một việc.
    const a1 = await listing(v1, shops.a, { external_product_id: pid });
    const a2 = await listing(v2, shops.a, { external_product_id: pid });
    const b1 = await listing(v1, shops.b, { status: 'hidden' });
    const b2 = await listing(v2, shops.b, { external_category_id: NEW });
    const off = await listing(v1, shops.off);
    const res = await apply(productId, 1);
    expect(res.status).toBe(202);
    expect(res.body.items).toHaveLength(3);
    const byShop = new Map((res.body.items as { shopId: string }[]).map((i) => [i.shopId, i]));
    expect(byShop.get(shops.a)).toMatchObject({
      externalProductId: pid,
      listingIds: [a1, a2].sort(),
      fromCategoryId: OLD,
      fromCategoryPath: 'Thời trang > Áo cũ',
      toCategoryId: NEW,
      toCategoryPath: 'Thời trang > Áo mới',
      code: null,
    });
    expect(byShop.get(shops.b)).toMatchObject({ listingIds: [b1], code: null });
    expect(byShop.get(shops.off)).toMatchObject({ listingIds: [off], code: 'shop_not_connected' });
    expect((await row(a1)).category_change).toMatchObject({ status: 'queued', toCategoryId: NEW, toCategoryPath: 'Thời trang > Áo mới', attempts: 0, code: null });
    expect((await row(b2)).category_change).toBeNull();
    expect((await row(off)).category_change).toBeNull();
    const jobs = await jobsOf(productId);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.shopId === shops.a)).toMatchObject({ companyId: company.companyId, externalProductId: pid, toCategoryId: NEW });
    expect(changeCategory).not.toHaveBeenCalled();
  });

  it('chưa có spec → 409 `category_unmapped`', async () => {
    const v = variant();
    expect((await apply(v.productId, 1)).body.type).toMatch(/category_unmapped$/);
  });

  it('spec `categoryStatus` khác `ok` → 409 `spec_incomplete`', async () => {
    const { productId, v1 } = await product();
    await listing(v1, shops.a);
    await testPool().query("update channel.product_specs set category_status = 'changed' where product_id = $1", [productId]);
    const res = await apply(productId, 1);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/spec_incomplete$/);
  });

  it('version cũ → 409 `version_conflict` kèm `current`', async () => {
    const { productId, v1 } = await product();
    await listing(v1, shops.a);
    const res = await apply(productId, 7);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/version_conflict$/);
    expect(res.body.current).toMatchObject({ productId, version: 1, externalCategoryId: NEW });
  });

  it('còn listing `queued` → 409 `category_change_in_progress`, không xếp thêm', async () => {
    const { productId, v1 } = await product();
    await listing(v1, shops.a);
    expect((await apply(productId, 1)).status).toBe(202);
    const res = await apply(productId, 1);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/category_change_in_progress$/);
    expect(await jobsOf(productId)).toHaveLength(1);
  });

  it('mọi listing đã đúng category (hoặc không có listing đang bán) → 409 `category_in_sync`', async () => {
    const { productId, v1, v2 } = await product();
    await listing(v1, shops.a, { external_category_id: NEW });
    await listing(v2, shops.a, { status: 'under_review' });
    const res = await apply(productId, 1);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/category_in_sync$/);
    expect(res.body.detail).toContain('TikTok Shop');
  });

  it('category mới bắt buộc bảng size mà sản phẩm chưa có → 409 `size_chart_missing`', async () => {
    const { productId, v1 } = await product(SIZED);
    await listing(v1, shops.a);
    const res = await apply(productId, 1);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/size_chart_missing$/);
  });

  it('sàn chưa có `changeCategory` (Lazada) → 422 `marketplace_unsupported`', async () => {
    const { productId, v1 } = await product('14275', 'lazada');
    await listing(v1, shops.lazada, { external_category_id: '999' });
    const res = await apply(productId, 1, 'lazada');
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/marketplace_unsupported$/);
  });

  it('không có `listing.manage` → 403 trước kiểm body', async () => {
    const { productId } = await product();
    const warehouse = await addMember(company.companyId, 'sale');
    const res = await auth(app().post(`/api/v1/channel/products/${productId}/specs/tiktok/apply-category`), warehouse.token).send({});
    expect(res.status).toBe(403);
  });
});

describe('việc nền channel.category_apply (#467)', () => {
  /** Xếp qua route rồi trả dữ liệu việc của gian hàng a. */
  async function queued(target = NEW, cols: Record<string, unknown> = {}) {
    const p = await product(target);
    const id = await listing(p.v1, shops.a, cols);
    const res = await apply(p.productId, 1);
    expect(res.status).toBe(202);
    const job = (await jobsOf(p.productId)).find((j) => j.shopId === shops.a)!;
    return { ...p, id, job };
  }

  it('sàn nhận, đọc lại khớp → `categoryChange` null, bản sửa `auditing`; không đổi trạng thái, category của listing', async () => {
    const { id, job } = await queued();
    const before = await row(id);
    await runCategoryApply(port, job);
    expect(changeCategory).toHaveBeenCalledWith(expect.any(String), job.externalProductId, expect.objectContaining({ externalCategoryId: NEW }));
    expect(changeCategory.mock.calls[0]![2]).not.toHaveProperty('sizeChartUri');
    const after = await row(id);
    expect(after).toMatchObject({ status: 'live', category_change: null, revision_status: 'auditing', external_category_id: OLD });
    expect(after.version).toBeGreaterThan(before.version);
    // Chạy lại (pg-boss giao lại) thì bỏ: listing không còn `queued`.
    await runCategoryApply(port, job);
    expect(changeCategory).toHaveBeenCalledTimes(1);
  });

  it('sàn ngừng bán để duyệt (`underReview`) → listing `live` chuyển `under_review`', async () => {
    const { id, job } = await queued();
    onChange = async () => ({ underReview: true, mismatch: [] });
    await runCategoryApply(port, job);
    expect(await row(id)).toMatchObject({ status: 'under_review', category_change: null, revision_status: null });
  });

  it('đọc lại lệch → `mismatch` kèm câu liệt kê, vẫn ghi bản sửa `auditing`', async () => {
    const { id, job } = await queued();
    onChange = async () => ({ underReview: false, mismatch: ['còn 2/3 SKU: thiếu AO-DEN-XL'] });
    await runCategoryApply(port, job);
    const after = await row(id);
    expect(after.revision_status).toBe('auditing');
    expect(after.category_change).toMatchObject({ status: 'mismatch', message: 'Sau khi đổi category, TikTok Shop còn 2/3 SKU: thiếu AO-DEN-XL' });
  });

  it('lỗi tạm: tăng `attempts`, giữ `queued`, ném để thử lại; tới lần thứ 5 thì `failed`', async () => {
    const { id, job } = await queued();
    onChange = async () => {
      throw new MarketplaceError('unavailable', '36009003', 'Sàn bận');
    };
    for (let i = 1; i < CATEGORY_APPLY_ATTEMPTS; i++) {
      await expect(runCategoryApply(port, job)).rejects.toMatchObject({ kind: 'unavailable' });
      expect((await row(id)).category_change).toMatchObject({ status: 'queued', attempts: i, code: 'marketplace_unavailable', message: 'Sàn bận' });
    }
    await expect(runCategoryApply(port, job)).resolves.toBeUndefined();
    expect((await row(id)).category_change).toMatchObject({ status: 'failed', attempts: CATEGORY_APPLY_ATTEMPTS, code: 'marketplace_unavailable' });
  });

  it('sàn từ chối → `failed` `marketplace_rejected` kèm câu sàn; gian hàng đếm vào `categoryChangeIssues`', async () => {
    const before = (await auth(app().get(`/api/v1/channel/shops/${shops.a}`))).body.categoryChangeIssues as number;
    const { id, job } = await queued();
    onChange = async () => {
      throw new MarketplaceError('rejected', '12052104', 'Thiếu thuộc tính bắt buộc');
    };
    await expect(runCategoryApply(port, job)).resolves.toBeUndefined();
    expect((await row(id)).category_change).toMatchObject({ status: 'failed', code: 'marketplace_rejected', message: 'Thiếu thuộc tính bắt buộc', attempts: 1 });
    const shop = await auth(app().get(`/api/v1/channel/shops/${shops.a}`));
    expect(shop.body.categoryChangeIssues).toBe(before + 1);
    const list = await auth(app().get('/api/v1/channel/shops'));
    expect((list.body.items as { id: string; categoryChangeIssues: number }[]).find((s) => s.id === shops.a)?.categoryChangeIssues).toBe(before + 1);
  });

  it('`queued` quá 30 phút → `failed`, không gọi sàn', async () => {
    const { id, job } = await queued();
    await testPool().query(
      "update channel.listings set category_change = jsonb_set(category_change, '{at}', to_jsonb((now() - interval '31 minutes')::text)) where id = $1",
      [id],
    );
    await runCategoryApply(port, job);
    expect(changeCategory).not.toHaveBeenCalled();
    expect((await row(id)).category_change).toMatchObject({ status: 'failed', code: 'marketplace_unavailable' });
  });

  it('category bắt buộc bảng size: đưa ảnh bảng size của app lên rồi truyền `sizeChartUri`', async () => {
    const p = await product(SIZED);
    sizeCharts.set(p.productId, 'https://img.test/size.png');
    await listing(p.v1, shops.a);
    expect((await apply(p.productId, 1)).status).toBe(202);
    const job = (await jobsOf(p.productId))[0]!;
    await runCategoryApply(port, job);
    expect(uploadImage).toHaveBeenCalledWith(expect.any(String), 'https://img.test/size.png', 'size_chart');
    expect(changeCategory.mock.calls[0]![2]).toMatchObject({ externalCategoryId: SIZED, sizeChartUri: 'tos/https%3A%2F%2Fimg.test%2Fsize.png' });
  });

  it('gian hàng mất uỷ quyền khi việc chạy → giữ việc (`HoldJob`)', async () => {
    const { job } = await queued();
    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [shops.a]);
    try {
      await expect(runCategoryApply(port, job)).rejects.toBeInstanceOf(HoldJob);
    } finally {
      await testPool().query("update channel.shops set status = 'active' where id = $1", [shops.a]);
    }
  });

  it('listing gỡ thì xoá `categoryChange` (CHECK `listings_category_change`)', async () => {
    const { id } = await queued();
    await expect(testPool().query("update channel.listings set status = 'delisted' where id = $1", [id])).rejects.toMatchObject({
      constraint: 'listings_category_change',
    });
  });
});

describe('pathIds, externalCategoryPath (#467)', () => {
  it('`PlatformCategory.pathIds` từ gốc tới chính category ở danh sách và chi tiết; cha chưa có trong cây thì chuỗi thiếu gốc', async () => {
    const list = await auth(app().get(`/api/v1/channel/platforms/tiktok/categories?parentId=${ROOT}`));
    expect(list.status).toBe(200);
    const item = (list.body.items as { externalId: string; pathIds: string[] }[]).find((c) => c.externalId === NEW);
    expect(item?.pathIds).toEqual([ROOT, NEW]);
    const detail = await auth(app().get(`/api/v1/channel/platforms/tiktok/categories/${NEW}?shopId=${shops.a}`));
    expect(detail.status).toBe(200);
    expect(detail.body.category.pathIds).toEqual([ROOT, NEW]);
    const orphan = catId();
    const missingParent = catId();
    await category(orphan, missingParent, 'Không rõ > Lá mồ côi');
    const one = await auth(app().get(`/api/v1/channel/platforms/tiktok/categories/${orphan}?shopId=${shops.a}`));
    expect(one.body.category.pathIds).toEqual([orphan]);
  });

  it('`ListingRow.externalCategoryPath` là đường dẫn category trên sàn của listing; category chưa có trong cây thì null', async () => {
    const { v1, v2 } = await product();
    await listing(v1, shops.b);
    await listing(v2, shops.b, { external_category_id: catId() });
    const res = await auth(app().get(`/api/v1/channel/shops/${shops.b}/listings`));
    expect(res.status).toBe(200);
    const rows = res.body.items as { variantId: string; externalCategoryPath: string | null; categoryChange: unknown; listing: { categoryChange: unknown } }[];
    expect(rows.find((r) => r.variantId === v1.id)).toMatchObject({ externalCategoryPath: 'Thời trang > Áo cũ', categoryChange: null, listing: { categoryChange: null } });
    expect(rows.find((r) => r.variantId === v2.id)?.externalCategoryPath).toBeNull();
  });
});
