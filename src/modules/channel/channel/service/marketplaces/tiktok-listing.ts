// TikTok Shop: tồn, giá, ẩn/hiện (#226) và đăng sản phẩm (#219). Gọi sàn qua `client.call` của `tiktok-client.ts`.
// Nguồn (docv2, tra 07/11/2026 qua `api/v1/document/detail`; cây tài liệu ngày đó không có bản mới hơn 202309 cho các
// API dưới đây): update-inventory-202309, update-price-202309, deactivate-products-202309, activate-products-202309,
// get-warehouse-list-202309 (bản 202502 của `/logistics/.../warehouses` là tạo kho, khác việc), get-categories-202309,
// get-category-attributes-202309, upload-product-image-202309, create-product-202309, sign-your-api-request.
// Đẩy lại (#219): edit-product-202509 (bản mới nhất của Edit Product trong OAS của skill `tts-openapi-guide`, tra
// 11/11/2026), get-product-202309. Kiểm trước khi tạo (#305): check-listing-prerequisites-202312, check-product-listing-202309
// (bản mới nhất trong OAS của skill, tra 17/11/2026; bản 202404 là global product, khác việc).
// Kết quả gọi thật trên shop thử: mục TikTok của `channel/CLAUDE.md`.
import {
  type CategoryRules,
  type CategorySuggestion,
  type CreatedProduct,
  existingFromSkus,
  type ImagePurpose,
  type MarketplaceAdapter,
  MarketplaceError,
  type NewProduct,
  type NewVariants,
  partResults,
  type PerSkuResult,
  type PriceQuantity,
  plainDescription,
  type ProductSku,
  productSkus,
  type RemoteProductCategory,
  type RemoteProductFacts,
  type RemoteSku,
  type SalesAttribute,
  skuAxes,
  toGrams,
  toMillimeters,
} from './common.ts';
import { downloadImage, type ImageSourceOptions } from './image-source.ts';
import { tiktokCategoryEditBody, tiktokCategoryMismatch } from './tiktok-category-change.ts';
import { RESPONSIBLE_ATTRS, tiktokCategoryNodes, tiktokLeafAttributes } from './tiktok-categories.ts';
import { type TiktokClient, unpackTiktokToken } from './tiktok-client.ts';

export { isPrivateAddress } from './image-source.ts';

type Row = Record<string, unknown>;

/**
 * Trường dùng chung của Get Product 202309 (#497; OAS cục bộ của skill `tts-openapi-guide`, tra 20/11/2026; gọi thật 20/11/2026
 * trên shop thử, request_id 202611202334328A97039DD11D94143E7E): `brand.name`, `description` (HTML), `main_images[].urls[0]`,
 * `size_chart.image.urls[0]` (bảng size dạng template không có ảnh: null), `package_weight { value, unit: KILOGRAM | POUND }`,
 * `package_dimensions { length, width, height, unit: CENTIMETER | INCH }`. Cân nặng, kích thước ở cấp sản phẩm (202309 không
 * có theo SKU): mọi `skus[].id` cùng số.
 */
export function tiktokProductFacts(data: Row | undefined): RemoteProductFacts {
  const firstUrl = (img: unknown) => {
    const urls = (img as { urls?: unknown } | undefined)?.urls;
    return Array.isArray(urls) && typeof urls[0] === 'string' && urls[0] !== '' ? urls[0] : null;
  };
  const brand = (data?.brand as { name?: unknown } | undefined)?.name;
  const weight = data?.package_weight as { value?: unknown; unit?: unknown } | undefined;
  const dims = data?.package_dimensions as { length?: unknown; width?: unknown; height?: unknown; unit?: unknown } | undefined;
  const dimUnit = typeof dims?.unit === 'string' ? dims.unit : undefined;
  const measures = {
    weightG: weight ? toGrams(weight.value, typeof weight.unit === 'string' ? weight.unit : undefined) : null,
    lengthMm: dims ? toMillimeters(dims.length, dimUnit) : null,
    widthMm: dims ? toMillimeters(dims.width, dimUnit) : null,
    heightMm: dims ? toMillimeters(dims.height, dimUnit) : null,
  };
  return {
    brand: typeof brand === 'string' && brand.trim() !== '' ? brand.trim() : null,
    description: plainDescription(data?.description),
    imageUrls: ((data?.main_images ?? []) as unknown[]).map(firstUrl).filter((u): u is string => u !== null),
    sizeChartUrl: firstUrl((data?.size_chart as { image?: unknown } | undefined)?.image),
    skus: ((data?.skus ?? []) as Row[]).flatMap((k) => {
      if (k.id == null) return [];
      const saleValues = ((k.sales_attributes ?? []) as Row[]).flatMap((a) => (typeof a.value_name === 'string' && a.value_name.trim() ? [a.value_name.trim()] : []));
      return [{ externalSkuId: String(k.id), ...measures, ...(saleValues.length && { saleValues }) }];
    }),
  };
}

/** Cây danh mục 7 cấp: docv2 bắt shop US, EU, SEA (gồm VN) gửi `v2` cho danh mục, thuộc tính và tạo sản phẩm. */
const CATEGORY_VERSION = 'v2';
const htmlDescription = (text: string) => `<p>${escapeHtml(text)}</p>`;
/** Commerio chỉ bán VND (một công ty, VN). */
const CURRENCY = 'VND';
/** Kho của shop ít đổi: giữ trong process một giờ, đỡ một lượt gọi mỗi lần đẩy. */
const WAREHOUSE_TTL_MS = 60 * 60_000;
/** "product status invalid": sản phẩm không ở trạng thái thao tác được (vd đã tắt mà tắt lại). */
const STATUS_INVALID = '12052901';
/** Trạng thái sản phẩm coi như đã tắt, đã bật (bật lại vào duyệt `PENDING`). */
const TOGGLE_DONE = { deactivate: ['SELLER_DEACTIVATED', 'PLATFORM_DEACTIVATED'], activate: ['ACTIVATE', 'PENDING'] } as const;

/**
 * Create Product nhận lại một `idempotency_key` đã dùng: sàn không tạo thêm (issue #219, gọi thật #283 ngày 09/11/2026).
 * Mã này không có trong OAS của skill; nghĩa theo lần gọi thật đó.
 */
const DUPLICATE_REQUEST = '12052996';

type SkuError = { code: string; message: string };

export interface TiktokListingDeps {
  /** Tải ảnh nguồn (`image-source.ts`): phân giải tên miền, địa chỉ được phép nối; test thay. */
  image?: Pick<ImageSourceOptions, 'resolveHost' | 'allowAddress'>;
  /**
   * SKU đang có trên sàn theo `seller_sku` (bỏ sản phẩm đã xoá), để `createProduct` không tạo trùng khi lần trước đã tạo
   * xong mà bên gọi không nhận được kết quả. `createTiktokAdapter` truyền bản dùng Search Products; không truyền thì bỏ bước tra.
   */
  findSku?: (token: string, sellerSku: string) => Promise<RemoteSku | null>;
}

type ListingMethods = Pick<
  MarketplaceAdapter,
  | 'categoryTree'
  | 'leafAttributes'
  | 'categoryRules'
  | 'suggestCategories'
  | 'productCategory'
  | 'uploadImage'
  | 'createProduct'
  | 'updateProduct'
  | 'addVariants'
  | 'removeVariants'
  | 'updateContent'
  | 'changeCategory'
  | 'updatePriceQuantity'
  | 'deactivate'
  | 'activate'
>;

/** Đọc phản hồi Recommend Category (#400 lát 9): một leaf, đường dẫn nối tên các cấp theo `level`, quyền của leaf. */
export function tiktokSuggestions(data: { categories?: Row[]; leaf_category_id?: unknown } | null | undefined): CategorySuggestion[] {
  const leafId = data?.leaf_category_id;
  if (leafId == null || leafId === '') return [];
  const chain = [...(data?.categories ?? [])].sort((a, b) => Number(a.level ?? 0) - Number(b.level ?? 0));
  const leaf = chain.find((c) => String(c.id) === String(leafId));
  const statuses = Array.isArray(leaf?.permission_statuses) ? (leaf.permission_statuses as unknown[]).map(String) : null;
  return [{ externalId: String(leafId), path: chain.map((c) => String(c.name ?? c.id)).join(' > '), permissionStatuses: statuses }];
}

/** Lỗi theo từng mục của API lô (`data.errors[]`): mã, câu của lỗi phụ đầu tiên nếu có (cụ thể hơn 12052990 "check failed"). */

function itemError(e: Row): { code: string; message: string } {
  const detail = (e.detail ?? {}) as Row;
  const extra = ((detail.extra_errors ?? []) as Row[])[0];
  const src = extra ?? e;
  return { code: String(src.code ?? e.code ?? 'unknown'), message: typeof src.message === 'string' ? src.message : String(e.message ?? '') };
}

/** Cây, attribute TikTok theo gian hàng: token null thì `unauthorized`, không gọi sàn (#400 A4). */
function requireToken(token: string | null): string {
  if (!token) throw new MarketplaceError('unauthorized', 'shop_token_required', 'TikTok cần token gian hàng để đọc category');
  return token;
}

/** Gram → kg tối đa 3 chữ số thập phân; mm → cm số nguyên dương (create-product-202309, VN chỉ nhận KILOGRAM, CENTIMETER). */
const kg = (g: number) => String(Math.max(1, Math.round(g)) / 1000);
const cm = (mm: number) => String(Math.max(1, Math.ceil(mm / 10)));
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * `skus[]` của Create Product và phân loại mới của Partial Edit (#295): trục `sales_attributes` theo thứ tự `salesAttributes`.
 * `quantityRequired`: Partial Edit 202509 bắt buộc `quantity` của SKU mới ("Quantity of Inventory[0] is a required field",
 * 36009004, gọi thật 21/11/2026 request `20261121182632426DA02F582365317A4D`) và nhận `quantity: 0`
 * (`2026112118280548420235C998D03211DE`), nên luôn gửi, chưa có số thì 0 (SKU mới chưa có tồn trên sàn).
 */
function newSkuBody(sku: ProductSku, attrs: readonly SalesAttribute[] | undefined, warehouseId: string, quantityRequired = false) {
  const sales = skuAxes(attrs, sku).map((x) => ({
    ...(x.attr.code ? { id: x.attr.code } : { name: x.attr.name }),
    value_name: x.label,
    ...(x.value?.optionId && { value_id: x.value.optionId }),
    ...(x.value?.imageUri && { sku_img: { uri: x.value.imageUri } }),
  }));
  return {
    seller_sku: sku.sellerSku,
    price: { amount: sku.price, currency: CURRENCY },
    // Create Product: docv2 ghi `quantity` khoảng [1, 99999], tồn 0 thì bỏ `quantity`, chỉ gán kho.
    inventory: [
      quantityRequired
        ? { warehouse_id: warehouseId, quantity: sku.quantity ?? 0 }
        : { warehouse_id: warehouseId, ...(sku.quantity !== undefined && sku.quantity > 0 && { quantity: sku.quantity }) },
    ],
    ...(sales.length && { sales_attributes: sales }),
  };
}

/** SKU đang có trên sàn (Get Product) dựng lại cho Partial Edit: `id`, giá, tồn theo kho, trục `{ id, value_id, sku_img }` (#295). */
function remoteSkuBody(s: Row) {
  const price = s.price as Row | undefined;
  const amount = price?.sale_price ?? price?.amount;
  const inventory = ((s.inventory ?? []) as Row[]).map((i) => ({ warehouse_id: i.warehouse_id, quantity: i.quantity }));
  const sales = ((s.sales_attributes ?? []) as Row[]).map((a) => {
    const img = a.sku_img as Row | undefined;
    return { id: a.id, value_id: a.value_id, ...(typeof img?.uri === 'string' && { sku_img: { uri: img.uri } }) };
  });
  return {
    id: String(s.id),
    seller_sku: s.seller_sku,
    ...(amount !== undefined && { price: { amount: String(amount), currency: typeof price?.currency === 'string' ? price.currency : CURRENCY } }),
    ...(inventory.length && { inventory }),
    ...(sales.length && { sales_attributes: sales }),
  };
}

/**
 * Ghép SKU sàn trả về với seller_sku đã gửi theo `seller_sku`. Một SKU mà sàn không ghi seller_sku thì lấy phần tử đầu
 * (hành vi cũ), trừ khi `strict` (thêm phân loại: phản hồi lẫn SKU cũ, không đoán).
 */
function matchSkus(sellerSkus: readonly string[], rows: Row[] | undefined, strict = false): { sellerSku: string; externalSkuId: string }[] {
  const list = rows ?? [];
  if (!strict && sellerSkus.length === 1 && list.length >= 1 && list.every((r) => r.seller_sku === undefined)) {
    return typeof list[0]!.id === 'string' ? [{ sellerSku: sellerSkus[0]!, externalSkuId: list[0]!.id }] : [];
  }
  return sellerSkus.flatMap((sellerSku) => {
    const row = list.find((r) => r.seller_sku === sellerSku && typeof r.id === 'string');
    return row ? [{ sellerSku, externalSkuId: String(row.id) }] : [];
  });
}

export function tiktokListingMethods(client: TiktokClient, deps: TiktokListingDeps = {}): ListingMethods {
  const warehouses = new Map<string, { at: number; id: Promise<string> }>();

  /**
   * Kho bán mặc định của gian hàng (`type = SALES_WAREHOUSE`, ưu tiên `is_default`). Update Inventory đòi đủ kho đang gán
   * cho SKU; Commerio một kho nên mọi SKU của app nằm ở kho mặc định (tạo sản phẩm cũng gán kho này).
   */
  function defaultWarehouse(token: string): Promise<string> {
    const shopId = unpackTiktokToken(token).shopId;
    const hit = warehouses.get(shopId);
    if (hit && Date.now() - hit.at < WAREHOUSE_TTL_MS) return hit.id;
    const id = (async () => {
      const data = await client.call<{ warehouses?: Row[] }>('GET', '/logistics/202309/warehouses', { token });
      const sales = (data?.warehouses ?? []).filter((w) => w.type === 'SALES_WAREHOUSE');
      const pick = sales.find((w) => w.is_default === true) ?? sales.find((w) => w.effect_status === 'ENABLED') ?? sales[0];
      if (!pick || typeof pick.id !== 'string') throw new MarketplaceError('rejected', 'no_warehouse', 'Gian hàng TikTok chưa có kho bán hàng');
      return pick.id;
    })();
    warehouses.set(shopId, { at: Date.now(), id });
    // Lỗi thì không giữ, lần sau hỏi lại.
    id.catch(() => warehouses.delete(shopId));
    return id;
  }

  async function rawAttributes(token: string, categoryId: string): Promise<Row[]> {
    const data = await client.call<{ attributes?: Row[] }>('GET', `/product/202309/categories/${encodeURIComponent(categoryId)}/attributes`, {
      token,
      query: { category_version: CATEGORY_VERSION },
    });
    return data?.attributes ?? [];
  }

  /**
   * Một lời gọi cho các SKU của một sản phẩm; trả lỗi theo `externalSkuId`. `unauthorized` thì ném. Lỗi chung của lời gọi
   * đánh lỗi mọi SKU trong đó; riêng `rejected` khi gọi nhiều SKU thì gọi lại từng SKU, vì một mã SKU sai làm sàn từ chối
   * cả lời gọi (gọi thật 07/11/2026: 12052556 "No `sku` matches", code khác 0) và SKU đúng không được đổi.
   */
  async function perProduct(group: PriceQuantity[], run: (subset: PriceQuantity[]) => Promise<Row | undefined>): Promise<Map<string, SkuError>> {
    const failed = new Map<string, SkuError>();
    let data: Row | undefined;
    try {
      data = await run(group);
    } catch (err) {
      if (!(err instanceof MarketplaceError) || err.kind === 'unauthorized') throw err;
      if (err.kind === 'rejected' && group.length > 1) {
        for (const item of group) for (const [k, v] of await perProduct([item], run)) failed.set(k, v);
        return failed;
      }
      const e = { code: err.platformCode ?? `marketplace_${err.kind}`, message: err.platformMessage ?? 'Sàn lỗi tạm' };
      for (const i of group) failed.set(i.externalSkuId, e);
      return failed;
    }
    // `code` 0 vẫn có thể kèm lỗi từng SKU (update-inventory-202309); lỗi không ghi SKU thì tính cho cả lời gọi.
    for (const e of (data?.errors ?? []) as Row[]) {
      const sku = ((e.detail ?? {}) as Row).sku_id;
      const err = itemError(e);
      if (typeof sku === 'string' && sku) failed.set(sku, err);
      else for (const i of group) failed.set(i.externalSkuId, err);
    }
    return failed;
  }

  /**
   * `use_case` của Upload Product Image 202309 (OAS cục bộ, tra 20/11/2026). Ảnh minh chứng (#476) gửi `DESCRIPTION_IMAGE`:
   * chỉ chịu giới hạn chung 100–20000 px; `MAIN_IMAGE` đòi 300–4000 px và ép ảnh lệch tỉ lệ 3:4–4:3 về 1:1.
   */
  // `sku_img.uri` phải tải với `ATTRIBUTE_IMAGE` (OAS Create Product 202309, `skus[].sales_attributes[].sku_img`).
  const USE_CASE = { main: 'MAIN_IMAGE', size_chart: 'SIZE_CHART_IMAGE', evidence: 'DESCRIPTION_IMAGE', sale_attribute: 'ATTRIBUTE_IMAGE' } as const;

  // Sàn chỉ nhận file (multipart), không nhận URL: tải ảnh nguồn rồi đưa lên. Không gửi `shop_cipher` (API không theo
  // gian hàng). Trả `uri`, chuỗi Create Product cần trong `main_images`.
  async function uploadImageFile(token: string, url: string, purpose: ImagePurpose = 'main'): Promise<string> {
    const image = await downloadImage(url, deps.image);
    const form = new FormData();
    form.append('data', new Blob([new Uint8Array(image.bytes)], { type: image.type }), image.name);
    form.append('use_case', USE_CASE[purpose]);
    const data = await client.call<{ uri?: unknown }>('POST', '/product/202309/images/upload', { token, form, shopCipher: false });
    if (typeof data?.uri !== 'string' || !data.uri) throw new MarketplaceError('rejected', 'unexpected_response');
    return data.uri;
  }

  async function productStatus(token: string, productId: string): Promise<string | null> {
    const data = await client.call<{ status?: unknown }>('GET', `/product/202309/products/${encodeURIComponent(productId)}`, { token });
    return typeof data?.status === 'string' ? data.status : null;
  }

  /**
   * Tắt hoặc bật một sản phẩm; lỗi theo sản phẩm trong `data.errors` (code 0 vẫn có lỗi) thì ném `rejected` giữ mã của
   * sàn. Gọi lại khi sản phẩm đã ở trạng thái đích sàn báo 12052901 "product status invalid" (gọi thật 07/11/2026): đọc
   * trạng thái (Get Product 202309), đã đúng đích thì coi là xong, để gỡ, ẩn, hiện lặp lại được.
   */
  async function toggle(token: string, action: 'activate' | 'deactivate', productId: string): Promise<void> {
    const data = await client.call<{ errors?: Row[] }>('POST', `/product/202309/products/${action}`, { token, body: { product_ids: [productId] } });
    const e = (data?.errors ?? [])[0];
    if (!e) return;
    const { code, message } = itemError(e);
    if (code === STATUS_INVALID) {
      const status = await productStatus(token, productId);
      if (status && (TOGGLE_DONE[action] as readonly string[]).includes(status)) return;
    }
    throw new MarketplaceError('rejected', code, message);
  }

  /**
   * Gian hàng đủ điều kiện đăng bán chưa (Check Listing Prerequisites 202312, #305): mục `is_failed` thì ném `rejected`
   * `shop_not_eligible`, câu là lý do sàn trả (thiếu thì tên mục). Gọi thật 17/11/2026: shop thử đạt cả 10 mục.
   */
  async function assertShopEligible(token: string): Promise<void> {
    const data = await client.call<{ check_results?: Row[] }>('GET', '/product/202312/prerequisites', { token });
    const failed = (data?.check_results ?? []).filter((r) => r.is_failed === true);
    if (!failed.length) return;
    const reasons = failed.flatMap((r) => (Array.isArray(r.fail_reasons) && r.fail_reasons.length ? r.fail_reasons.map(String) : [String(r.check_item)]));
    throw new MarketplaceError('rejected', 'shop_not_eligible', reasons.join('; '));
  }

  /**
   * Thử body tạo sản phẩm bằng Check Product Listing 202309 (#305). Chỉ chặn khi `FAILED` kèm `fail_reasons` (cùng mã lỗi
   * của Create Product); `FAILED` không lý do thì để Create Product quyết. `is_diagnosis_required=false`: bỏ phần gợi ý chất
   * lượng (đã deprecated), gọi thật 17/11/2026 nhanh từ ~5 giây xuống dưới 1 giây, `fail_reasons` không đổi.
   */
  async function assertListingPasses(token: string, body: Row): Promise<void> {
    const data = await client.call<{ check_result?: unknown; fail_reasons?: Row[] }>('POST', '/product/202309/products/listing_check', {
      token,
      query: { is_diagnosis_required: 'false' },
      body,
    });
    const reasons = data?.check_result === 'FAILED' ? (data.fail_reasons ?? []) : [];
    if (!reasons.length) return;
    const err = new MarketplaceError('rejected', 'listing_check_failed', reasons.map((r) => `${String(r.code)}: ${String(r.message ?? '')}`).join('; '));
    // Mỗi lý do một `details` để bảng dịch khớp mã Create Product (12052051, 12052104…) trước mã kiểm trước (#567).
    err.details = reasons.map((r) => ({ field: null, code: r.code === undefined || r.code === null ? null : String(r.code), message: typeof r.message === 'string' ? r.message : null }));
    throw err;
  }

  /**
   * Phần nội dung chung của Create Product và Edit Product: tiêu đề, mô tả, danh mục, ảnh, gói hàng, thuộc tính.
   * Tổ chức chịu trách nhiệm (#292): ô người dùng để trống lấy hồ sơ công ty lúc đẩy, chỉ khi danh mục có mã đó.
   */
  async function productAttributes(token: string, p: Pick<NewProduct, 'externalCategoryId' | 'attributes' | 'responsible'>) {
    const attrs = await rawAttributes(token, p.externalCategoryId);
    const byId = new Map(attrs.map((a) => [String(a.id), a]));
    const filled = { ...p.attributes };
    for (const [id, field] of Object.entries(RESPONSIBLE_ATTRS)) {
      const value = p.responsible?.[field];
      if (!filled[id] && value && byId.has(id)) filled[id] = value;
    }
    return Object.entries(filled).map(([id, value]) => {
      const values = (Array.isArray(value) ? value : [value]).map((one) => {
        const builtIn = ((byId.get(id)?.values ?? []) as Row[]).find((v) => v.name === one);
        return builtIn ? { id: String(builtIn.id) } : { name: one };
      });
      return { id, values };
    });
  }

  async function productContent(token: string, p: NewProduct) {
    const contentAttributes = await productAttributes(token, p);
    return {
      title: p.name,
      description: htmlDescription(p.description),
      category_id: p.externalCategoryId,
      category_version: CATEGORY_VERSION,
      main_images: p.imageUrls.map((uri) => ({ uri })),
      // Danh mục quần áo, giày dép bắt buộc (`size_chart_image is required`, #347).
      ...(p.sizeChartUri && { size_chart: { image: { uri: p.sizeChartUri } } }),
      package_weight: { value: kg(p.weightG), unit: 'KILOGRAM' },
      package_dimensions: { length: cm(p.lengthMm), width: cm(p.widthMm), height: cm(p.heightMm), unit: 'CENTIMETER' },
      ...(contentAttributes.length && { product_attributes: contentAttributes }),
    };
  }

  // Get Brands 202309 (OAS cục bộ tts-openapi-guide, tra 19/11/2026; #400 A1): `brand_name` lọc theo tiền tố, `category_id`
  // cho biết thương hiệu đã uỷ quyền có dùng được ở category đó (`brand_status`). Lấy đúng tên, không phân biệt hoa thường.
  // Dùng được: đã uỷ quyền và không `UNAVAILABLE`; chưa uỷ quyền mà không phải T1 (sàn nhận nhưng không hiện thương hiệu).
  // T1 chưa uỷ quyền thì sàn chặn tạo: không gửi. Lỗi sàn: không gửi, để Create Product quyết (TikTok cho bỏ trống).
  async function brandIdOf(token: string, categoryId: string, name: string): Promise<string | null> {
    try {
      const data = await client.call<{ brands?: Row[] }>('GET', '/product/202309/brands', {
        token,
        query: { brand_name: name, category_id: categoryId, category_version: CATEGORY_VERSION, page_size: '100' },
      });
      const wanted = name.toLocaleLowerCase('vi');
      const usable = (b: Row) =>
        b.authorized_status === 'AUTHORIZED' ? b.brand_status !== 'UNAVAILABLE' : b.is_t1_brand === false;
      const hit = (data?.brands ?? []).find((b) => typeof b.id === 'string' && String(b.name ?? '').trim().toLocaleLowerCase('vi') === wanted && usable(b));
      return hit ? String(hit.id) : null;
    } catch (err) {
      if (err instanceof MarketplaceError) return null;
      throw err;
    }
  }

  return {
    // Cây đầy đủ (#400): mọi node, quyền của gian hàng mang token. Get Categories bắt `shop_cipher` (G2.6): không token thì
    // không gọi.
    async categoryTree(token) {
      const data = await client.call<{ categories?: Row[] }>('GET', '/product/202309/categories', {
        token: requireToken(token),
        query: { category_version: CATEGORY_VERSION },
      });
      return tiktokCategoryNodes(data?.categories ?? []);
    },

    // Recommend Category 202309 (OAS cục bộ tts-openapi-guide, tra 19/11/2026): `product_title` (VN 25–255 ký tự, bên gọi
    // kiểm trước), `category_version`. Sàn trả chuỗi cấp từ gốc tới một leaf (`leaf_category_id`) kèm quyền của gian hàng
    // mang token. Gọi thật 18/11/2026: tên "Giày sneaker…" ra 601352 > 900616 > 601357.
    async suggestCategories(token, input): Promise<CategorySuggestion[]> {
      const data = await client.call<{ categories?: Row[]; leaf_category_id?: unknown }>('POST', '/product/202309/categories/recommend', {
        token: requireToken(token),
        query: { locale: 'vi-VN' },
        // `description` (HTML, tối đa 10000 ký tự) giúp khi tên chung chung nhưng không gỡ được luật tên 25 ký tự (Documents#214 mục 1.3).
        body: {
          product_title: input.name,
          category_version: CATEGORY_VERSION,
          ...(input.description?.trim() && { description: htmlDescription(input.description.trim().slice(0, 9_000)) }),
        },
      });
      return tiktokSuggestions(data);
    },

    // Get Product 202309 (OAS cục bộ, gọi thật 18/11/2026): `category_chains` từ gốc tới lá, `product_attributes[{id, values[{id,
    // name}]}]` (giá trị tự nhập cũng có mã riêng). Trường dùng chung (#497): `tiktokProductFacts`.
    async productCategory(token, externalProductId): Promise<RemoteProductCategory | null> {
      const data = await client.call<Row>('GET', `/product/202309/products/${encodeURIComponent(externalProductId)}`, { token: requireToken(token) });
      const leaf = ((data?.category_chains ?? []) as Row[]).find((c) => c.is_leaf === true);
      if (!leaf?.id) return null;
      return {
        externalCategoryId: String(leaf.id),
        attributes: ((data?.product_attributes ?? []) as Row[]).flatMap((a) => {
          const values = ((a.values ?? []) as Row[])
            .filter((v) => typeof v.name === 'string' && v.name !== '')
            .map((v) => ({ id: v.id == null ? null : String(v.id), name: String(v.name) }));
          return a.id != null && values.length ? [{ code: String(a.id), values }] : [];
        }),
        facts: tiktokProductFacts(data),
      };
    },

    async leafAttributes(token, externalCategoryId) {
      const data = await client.call<{ attributes?: unknown }>('GET', `/product/202309/categories/${encodeURIComponent(externalCategoryId)}/attributes`, {
        token: requireToken(token),
        query: { category_version: CATEGORY_VERSION },
      });
      // Không phải mảng thì không coi là "leaf không có attribute": `replaceLeaf` sẽ xoá cả tập (review BE1 P2-1).
      if (!Array.isArray(data?.attributes)) {
        throw new MarketplaceError('rejected', 'unexpected_response', 'Sàn trả attribute của category không phải danh sách');
      }
      return tiktokLeafAttributes(data.attributes as Row[]);
    },

    // Get Category Rules 202309: `size_chart.is_required`, `is_supported` (#347). Danh mục không hỗ trợ bảng kích cỡ thì không
    // gửi `size_chart`; sàn không trả khối này thì coi là tuỳ chọn.
    async categoryRules(token, externalCategoryId): Promise<CategoryRules> {
      const data = await client.call<{ size_chart?: { is_required?: unknown; is_supported?: unknown } }>(
        'GET',
        `/product/202309/categories/${encodeURIComponent(externalCategoryId)}/rules`,
        { token, query: { category_version: CATEGORY_VERSION } },
      );
      const chart = data?.size_chart;
      if (chart?.is_required === true) return { sizeChart: 'required' };
      if (chart?.is_supported === false) return { sizeChart: 'unsupported' };
      return { sizeChart: 'optional' };
    },

    uploadImage: uploadImageFile,

    // Một sản phẩm một SKU, gán kho mặc định. Sản phẩm mới qua duyệt của TikTok (create-product-202309: "After creation,
    // it will be sent for audit review"); `live` theo trạng thái đọc lại ngay sau khi tạo, còn lại về qua đồng bộ.
    async createProduct(token, p: NewProduct): Promise<CreatedProduct> {
      // Idempotent theo `seller_sku`: lần đẩy trước đã tạo (mất kết quả vì lỗi mạng, tiến trình chết, token hỏng ở bước
      // đọc lại) thì trả sản phẩm đó, không tạo thêm. Search Products có thể trễ vài giây sau khi tạo (gọi thật 07/11/2026),
      // nên còn gửi `idempotency_key` của lượt đẩy (#219): sàn nhận lại khoá đã dùng thì trả `12052996`, không tạo trùng.
      // Nhiều SKU (#295): tra từng seller_sku; đủ và cùng sản phẩm thì trả sản phẩm đó, một phần thì từ chối.
      const skus = productSkus(p);
      const sellerSkus = skus.map((x) => x.sellerSku);
      const found: (RemoteSku | null)[] = [];
      for (const sku of sellerSkus) found.push(deps.findSku && !p.skipExistingSkuCheck ? await deps.findSku(token, sku) : null); // #295 regroup: bỏ chống trùng
      const existing = existingFromSkus(sellerSkus, found);
      if (existing) {
        return existing;
      }
      // Kiểm điều kiện đăng trước khi tạo (#305, Documents/21 §18.6.4): gian hàng, rồi thử chính body tạo.
      const [warehouseId, content, , brandId] = await Promise.all([
        defaultWarehouse(token),
        productContent(token, p),
        assertShopEligible(token),
        p.brand?.trim() ? brandIdOf(token, p.externalCategoryId, p.brand.trim()) : null,
      ]);
      const listing = {
        ...content,
        ...(brandId && { brand_id: brandId }),
        skus: skus.map((x) => newSkuBody(x, p.salesAttributes, warehouseId)),
      };
      await assertListingPasses(token, listing);
      const body = { save_mode: 'LISTING', ...(p.idempotencyKey && { idempotency_key: p.idempotencyKey }), ...listing };
      let data: { product_id?: unknown; skus?: Row[] } | undefined;
      try {
        data = await client.call<{ product_id?: unknown; skus?: Row[] }>('POST', '/product/202309/products', { token, body });
      } catch (err) {
        if (!(err instanceof MarketplaceError) || err.platformCode !== DUPLICATE_REQUEST) throw err;
        // Lượt này đã tạo sản phẩm: tìm theo `seller_sku`. Search chưa thấy (trễ) thì là lỗi tạm, việc nền thử lại sau;
        // quá 30 phút thì đồng bộ đưa listing về `push_failed` (Documents/21 §18.3).
        const again: (RemoteSku | null)[] = [];
        for (const sku of sellerSkus) again.push(deps.findSku ? await deps.findSku(token, sku) : null);
        const hits = again.filter((x): x is RemoteSku => x !== null);
        if (hits.length === sellerSkus.length && new Set(hits.map((x) => x.externalProductId)).size === 1) {
          const head = hits[0]!;
          return {
            externalProductId: head.externalProductId,
            externalSkuId: head.externalSkuId,
            live: head.state === 'live',
            ...(p.skus?.length && { skus: hits.map((x) => ({ sellerSku: x.sellerSku, externalSkuId: x.externalSkuId })) }),
          };
        }
        throw new MarketplaceError('unavailable', DUPLICATE_REQUEST, 'Sàn đã nhận lượt tạo sản phẩm này nhưng chưa tìm thấy sản phẩm, thử lại sau');
      }
      // Ghép theo seller_sku, không theo vị trí. Một SKU mà sàn không ghi seller_sku thì lấy phần tử đầu như trước.
      const created = matchSkus(sellerSkus, data?.skus);
      const skuId = created.find((x) => x.sellerSku === sellerSkus[0])?.externalSkuId;
      if (typeof data?.product_id !== 'string' || typeof skuId !== 'string') throw new MarketplaceError('rejected', 'unexpected_response');
      // Phản hồi không có trạng thái: đọc lại (shop thử SANDBOX duyệt ngay, `ACTIVATE`, gọi thật 07/11/2026). Sản phẩm đã
      // tạo: mọi lỗi của bước đọc lại (kể cả `unauthorized`) coi như chờ duyệt và vẫn trả kết quả, trạng thái thật về qua
      // đồng bộ. Ném ở đây thì bên gọi tưởng chưa tạo, đẩy lại thành sản phẩm trùng.
      const status = await productStatus(token, data.product_id).catch(() => null);
      return { externalProductId: data.product_id, externalSkuId: skuId, live: status === 'ACTIVATE', ...(p.skus?.length && { skus: created }) };
    },

    // Thêm phân loại (#295): Partial Edit 202509 thay cả `skus` (SKU không có trong mảng bị xoá), nên gửi lại mọi SKU cũ kèm
    // `id` (giá, tồn, thuộc tính đọc từ sàn để không ghi đè) cộng SKU mới (không `id`, giá trị gửi `value_name`; sàn tự cấp
    // value_id). Đo 21/11/2026: id SKU cũ giữ nguyên; giá trị mới ở trục có ảnh bắt buộc `sku_img` (12052522). Sàn đưa sản
    // phẩm đi duyệt lại (`AUDITING`), trong lúc đó Get Product vẫn trả bản cũ: `live: false`.
    async addVariants(token, externalProductId, input: NewVariants) {
      const path = `/product/202309/products/${encodeURIComponent(externalProductId)}`;
      const [current, warehouseId] = await Promise.all([client.call<Row>('GET', path, { token }), defaultWarehouse(token)]);
      const sellerSkus = input.skus.map((x) => x.sellerSku);
      const old = ((current?.skus ?? []) as Row[]).map(remoteSkuBody);
      const dup = old.filter((x) => sellerSkus.includes(String(x.seller_sku)));
      if (dup.length) {
        throw new MarketplaceError('rejected', 'sku_exists_on_platform', `Sản phẩm trên sàn đã có SKU ${dup.map((x) => String(x.seller_sku)).join(', ')}`);
      }
      const skus = [...old, ...input.skus.map((x) => newSkuBody(x, input.salesAttributes, warehouseId, true))];
      const edit = `/product/202509/products/${encodeURIComponent(externalProductId)}/partial_edit`;
      const data = await client.call<{ skus?: Row[] }>('POST', edit, { token, body: { skus } });
      let created = matchSkus(sellerSkus, data?.skus, true);
      if (created.length < sellerSkus.length) {
        // Phản hồi thiếu SKU mới: đọc lại sản phẩm (có thể còn là bản live cũ nếu sàn đang duyệt).
        const again = await client.call<Row>('GET', path, { token });
        created = matchSkus(sellerSkus, (again?.skus ?? []) as Row[], true);
      }
      if (created.length < sellerSkus.length) throw new MarketplaceError('rejected', 'unexpected_response', 'Sàn không trả mã SKU vừa thêm');
      return { skus: created, live: false };
    },

    // Gỡ phân loại (#295): Partial Edit gửi lại `skus` không có các SKU đó (không có API xoá riêng một SKU), sàn duyệt lại.
    // Gỡ hết thì `last_variant`: bên gọi tắt cả sản phẩm.
    async removeVariants(token, externalProductId, externalSkuIds) {
      const path = `/product/202309/products/${encodeURIComponent(externalProductId)}`;
      const current = await client.call<Row>('GET', path, { token });
      const drop = new Set(externalSkuIds);
      const skus = ((current?.skus ?? []) as Row[]).filter((x) => !drop.has(String(x.id))).map(remoteSkuBody);
      if (!skus.length) throw new MarketplaceError('rejected', 'last_variant', 'Không gỡ được SKU cuối cùng của sản phẩm trên sàn; tắt cả sản phẩm');
      await client.call('POST', `/product/202509/products/${encodeURIComponent(externalProductId)}/partial_edit`, { token, body: { skus } });
    },

    // Edit Product 202509 ghi đè mọi trường gửi lên, kể cả trường để trống, trừ `price`, `inventory` (bỏ thì giữ); SKU
    // không có trong `skus` bị xoá; sửa xong sản phẩm vào duyệt lại (edit-product-202509). Vì vậy đọc Get Product trước
    // và gửi lại những gì app không quản: `brand_id`, `delivery_option_ids` (đang dùng được), `is_cod_allowed`, mọi SKU
    // kèm `id`, `seller_sku`, thuộc tính bán hàng. Không gửi `inventory`: tồn do đồng bộ đẩy. Sản phẩm người bán đã tắt
    // (`SELLER_DEACTIVATED`, vd dòng mới sau gỡ) thì bật lại (`activate`, sàn đưa vào duyệt).
    async updateProduct(token, externalProductId, externalSkuId, p: NewProduct) {
      const path = `/product/202309/products/${encodeURIComponent(externalProductId)}`;
      const [current, content] = await Promise.all([client.call<Row>('GET', path, { token }), productContent(token, p)]);
      const skus = ((current?.skus ?? []) as Row[]).map((s) => {
        const sales = ((s.sales_attributes ?? []) as Row[]).map((a) => {
          const img = a.sku_img as Row | undefined;
          return {
            id: a.id,
            ...(a.value_id !== undefined && { value_id: a.value_id }),
            ...(a.value_name !== undefined && { value_name: a.value_name }),
            ...(typeof img?.uri === 'string' && { sku_img: { uri: img.uri } }),
          };
        });
        const mine = String(s.id) === externalSkuId;
        return {
          id: String(s.id),
          seller_sku: mine ? p.sellerSku : s.seller_sku,
          ...(sales.length && { sales_attributes: sales }),
          ...(mine && { price: { amount: p.price, currency: CURRENCY } }),
        };
      });
      if (!skus.some((s) => s.id === externalSkuId)) {
        throw new MarketplaceError('rejected', 'sku_not_found', 'Sản phẩm trên sàn không còn SKU của listing này');
      }
      const brandId = (current?.brand as Row | undefined)?.id;
      const deliveryIds = ((current?.delivery_options ?? []) as Row[]).filter((d) => d.is_available === true).map((d) => String(d.id));
      const body = {
        save_mode: 'LISTING',
        ...content,
        ...(typeof brandId === 'string' && brandId && { brand_id: brandId }),
        ...(deliveryIds.length && { delivery_option_ids: deliveryIds }),
        ...(typeof current?.is_cod_allowed === 'boolean' && { is_cod_allowed: current.is_cod_allowed }),
        skus,
      };
      await client.call('PUT', `/product/202509/products/${encodeURIComponent(externalProductId)}`, { token, body });
      let status = await productStatus(token, externalProductId);
      if (status === 'SELLER_DEACTIVATED') {
        await toggle(token, 'activate', externalProductId);
        status = await productStatus(token, externalProductId);
      }
      if (status === 'ACTIVATE') return { live: true };
      if (status === 'PENDING' || status === 'FAILED') return { live: false };
      throw new MarketplaceError('rejected', 'still_inactive', `Sàn chưa bật lại sản phẩm (trạng thái ${status ?? 'không rõ'})`);
    },

    // Partial Edit 202509 (#293): chỉ gửi tiêu đề, mô tả, thuộc tính; không gửi `skus` (SKU thiếu trong danh sách bị sàn
    // xoá) hay ảnh. Đọc sản phẩm trước để chặn sản phẩm nhiều SKU (trừ `wholeProduct`, #295) và danh mục lệch ghép (Partial Edit không đổi danh mục),
    // đọc lại sau để biết sàn ngừng bán (`PENDING`) hay vẫn bán bản cũ trong lúc duyệt (gọi thật 09/11/2026: `ACTIVATE`).
    async updateContent(token, externalProductId, c) {
      const path = `/product/202309/products/${encodeURIComponent(externalProductId)}`;
      const [current, attributes] = await Promise.all([client.call<Row>('GET', path, { token }), productAttributes(token, c)]);
      if (!c.wholeProduct && ((current?.skus ?? []) as Row[]).length > 1) {
        throw new MarketplaceError('rejected', 'shared_remote_product', 'Sản phẩm trên sàn có nhiều SKU; sửa nội dung từng SKU chưa hỗ trợ');
      }
      const leaf = ((current?.category_chains ?? []) as Row[]).find((x) => x.is_leaf === true)?.id;
      if (leaf !== undefined && String(leaf) !== c.externalCategoryId) {
        throw new MarketplaceError('rejected', 'category_mismatch', `Sản phẩm trên sàn ở danh mục ${String(leaf)}, khác category đã liên kết`);
      }
      const body = {
        title: c.name,
        description: htmlDescription(c.description),
        ...(attributes.length && { product_attributes: attributes }),
      };
      await client.call('POST', `/product/202509/products/${encodeURIComponent(externalProductId)}/partial_edit`, { token, body });
      // Sàn đã nhận bản sửa: đọc lại lỗi thì coi như vẫn bán, không ném (ném thì bên gọi tưởng chưa sửa, hay gửi lại).
      const status = await productStatus(token, externalProductId).catch(() => null);
      return { underReview: status === 'PENDING' };
    },

    // Đổi category (#467, Documents/21 §18.5; trường đã đối chiếu OAS ở `tiktok-category-change.ts`): Edit Product 202509 ghi
    // đè mọi trường gửi lên nên body dựng từ chính Get Product, chỉ thay category và attribute. Không bật, tắt sản phẩm.
    // Sau khi sửa: trạng thái bản đang bán (Get Product thường, `PENDING` là sàn ngừng bán để duyệt) và bản đang duyệt
    // (`return_under_review_version=true`) để so với lần đọc trước. Sàn đã nhận bản sửa nên lỗi đọc lại không ném: không đọc
    // được bản đang duyệt thì so với bản đang bán, cả hai lỗi thì báo lệch để người dùng kiểm trên sàn (không im lặng).
    async changeCategory(token, externalProductId, input) {
      const path = `/product/202309/products/${encodeURIComponent(externalProductId)}`;
      const [current, attributes] = await Promise.all([
        client.call<Row>('GET', path, { token }),
        productAttributes(token, { externalCategoryId: input.externalCategoryId, attributes: input.attributes, responsible: input.responsible }),
      ]);
      // Ảnh bảng size của app chỉ đưa lên khi sản phẩm trên sàn chưa có bảng size (mẫu hay ảnh).
      const chart = current?.size_chart as Row | undefined;
      const hasChart = Boolean(chart && (chart.template || chart.image));
      const sizeChartUri = !hasChart && input.sizeChartUrl ? await uploadImageFile(token, input.sizeChartUrl, 'size_chart') : undefined;
      const body = tiktokCategoryEditBody(current, { externalCategoryId: input.externalCategoryId, sizeChartUri }, attributes, {
        categoryVersion: CATEGORY_VERSION,
        currency: CURRENCY,
      });
      await client.call('PUT', `/product/202509/products/${encodeURIComponent(externalProductId)}`, { token, body });
      // Edit Product (`save_mode = LISTING`) đăng lại sản phẩm: sản phẩm người bán đang tắt thành `ACTIVATE` (gọi thật 20/11/2026,
      // request_id 2026112017530477A4AD0A7268C20A23EF: SELLER_DEACTIVATED → ACTIVATE). Đổi category không được bật bán: tắt lại khi sản phẩm đang tắt lúc đọc hoặc app đã ẩn listing (`keepDeactivated`, lượt thử lại sau khi lần trước lỡ bật);
      // tắt lỗi thì báo lệch, không im lặng.
      const restore: string[] = [];
      if (current?.status === 'SELLER_DEACTIVATED' || input.keepDeactivated) {
        try {
          await toggle(token, 'deactivate', externalProductId);
        } catch (err) {
          if (!(err instanceof MarketplaceError)) throw err;
          restore.push('bật lại sản phẩm đang tắt và chưa tắt lại được; tắt trên Seller Center');
        }
      }
      const status = await productStatus(token, externalProductId).catch(() => null);
      const after =
        (await client.call<Row>('GET', path, { token, query: { return_under_review_version: 'true' } }).catch(() => undefined)) ??
        (await client.call<Row>('GET', path, { token }).catch(() => undefined));
      const mismatch = after ? tiktokCategoryMismatch(current, after) : ['chưa đọc lại được sản phẩm để kiểm SKU, giá, ảnh; kiểm trên sàn'];
      return { underReview: status === 'PENDING', mismatch: [...restore, ...mismatch] };
    },

    // Hai API theo sản phẩm: tồn (`inventory/update`, kho mặc định) và giá (`prices/update`, chỉ nhận sản phẩm `ACTIVATE`).
    // SKU có cả giá và tồn thì lỗi ở một trong hai là lỗi của SKU (bên gọi tính chung, như Lazada).
    async updatePriceQuantity(token, items): Promise<PerSkuResult[]> {
      const groups = new Map<string, PriceQuantity[]>();
      for (const i of items) groups.set(i.externalProductId, [...(groups.get(i.externalProductId) ?? []), i]);
      // Tồn và giá là hai API riêng: lỗi giữ riêng từng phần (#223), trả `stock`, `price` trong kết quả.
      const stockFailed = new Map<string, SkuError>();
      const priceFailed = new Map<string, SkuError>();
      const keepFirst = (failed: Map<string, SkuError>, m: Map<string, SkuError>) => {
        for (const [k, v] of m) if (!failed.has(k)) failed.set(k, v);
      };
      for (const [productId, group] of groups) {
        const path = `/product/202309/products/${encodeURIComponent(productId)}`;
        const stock = group.filter((i) => i.quantity !== undefined);
        if (stock.length) {
          const warehouseId = await defaultWarehouse(token).catch((err: unknown) => {
            if (err instanceof MarketplaceError && err.kind !== 'unauthorized') return err;
            throw err;
          });
          if (warehouseId instanceof MarketplaceError) {
            const e = { code: warehouseId.platformCode ?? `marketplace_${warehouseId.kind}`, message: warehouseId.platformMessage ?? 'Không đọc được kho' };
            for (const i of stock) if (!stockFailed.has(i.externalSkuId)) stockFailed.set(i.externalSkuId, e);
          } else {
            // Gọi thật 07/11/2026: `quantity: 0` được nhận dù docv2 ghi khoảng [1, 99999].
            const stockBody = (subset: PriceQuantity[]) => ({
              skus: subset.map((i) => ({ id: i.externalSkuId, inventory: [{ warehouse_id: warehouseId, quantity: i.quantity }] })),
            });
            keepFirst(stockFailed, await perProduct(stock, (s) => client.call<Row>('POST', `${path}/inventory/update`, { token, body: stockBody(s) })));
          }
        }
        const price = group.filter((i) => i.price !== undefined);
        if (price.length) {
          const priceBody = (subset: PriceQuantity[]) => ({
            skus: subset.map((i) => ({ id: i.externalSkuId, price: { amount: i.price, currency: CURRENCY } })),
          });
          keepFirst(priceFailed, await perProduct(price, (s) => client.call<Row>('POST', `${path}/prices/update`, { token, body: priceBody(s) })));
        }
      }
      return partResults(items, stockFailed, priceFailed);
    },

    // TikTok tắt, bật theo cả sản phẩm (không theo SKU): sản phẩm nhiều SKU thì mọi SKU cùng ẩn, hiện. Bật lại đưa sản
    // phẩm vào duyệt (`PENDING`, activate-products-202309).
    async deactivate(token, externalProductId) {
      await toggle(token, 'deactivate', externalProductId);
    },
    async activate(token, externalProductId) {
      await toggle(token, 'activate', externalProductId);
    },
  };
}
