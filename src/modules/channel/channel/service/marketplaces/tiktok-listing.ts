// TikTok Shop: tồn, giá, ẩn/hiện (#226) và đăng sản phẩm (#219). Gọi sàn qua `client.call` của `tiktok-client.ts`.
// Nguồn (docv2, tra 07/11/2026 qua `api/v1/document/detail`; cây tài liệu ngày đó không có bản mới hơn 202309 cho các
// API dưới đây): update-inventory-202309, update-price-202309, deactivate-products-202309, activate-products-202309,
// get-warehouse-list-202309 (bản 202502 của `/logistics/.../warehouses` là tạo kho, khác việc), get-categories-202309,
// get-category-attributes-202309, upload-product-image-202309, create-product-202309, sign-your-api-request.
// Kết quả gọi thật trên shop thử: mục TikTok của `channel/CLAUDE.md`.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  type CategoryAttribute,
  type CreatedProduct,
  type MarketplaceAdapter,
  MarketplaceError,
  type NewProduct,
  type PerSkuResult,
  type PlatformCategory,
  type PriceQuantity,
} from './common.ts';
import { type TiktokClient, unpackTiktokToken } from './tiktok-client.ts';

type Row = Record<string, unknown>;

/** Cây danh mục 7 cấp: docv2 bắt shop US, EU, SEA (gồm VN) gửi `v2` cho danh mục, thuộc tính và tạo sản phẩm. */
const CATEGORY_VERSION = 'v2';
/** Commerio chỉ bán VND (một công ty, VN). */
const CURRENCY = 'VND';
/** Kho của shop ít đổi: giữ trong process một giờ, đỡ một lượt gọi mỗi lần đẩy. */
const WAREHOUSE_TTL_MS = 60 * 60_000;
/** Ảnh tối đa 10MB (upload-product-image-202309). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** "product status invalid": sản phẩm không ở trạng thái thao tác được (vd đã tắt mà tắt lại). */
const STATUS_INVALID = '12052901';
/** Trạng thái sản phẩm coi như đã tắt, đã bật (bật lại vào duyệt `PENDING`). */
const TOGGLE_DONE = { deactivate: ['SELLER_DEACTIVATED', 'PLATFORM_DEACTIVATED'], activate: ['ACTIVATE', 'PENDING'] } as const;

type SkuError = { code: string; message: string };

export interface TiktokListingDeps {
  /** Tải ảnh nguồn (mặc định `fetch`); test thay. */
  fetchImage?: typeof fetch;
  /** Phân giải tên miền của URL ảnh để chặn địa chỉ nội bộ; test thay. */
  resolveHost?: (host: string) => Promise<string[]>;
}

type ListingMethods = Pick<
  MarketplaceAdapter,
  'listCategories' | 'categoryAttributes' | 'uploadImage' | 'createProduct' | 'updatePriceQuantity' | 'deactivate' | 'activate'
>;

/** Lỗi theo từng mục của API lô (`data.errors[]`): mã, câu của lỗi phụ đầu tiên nếu có (cụ thể hơn 12052990 "check failed"). */
function itemError(e: Row): { code: string; message: string } {
  const detail = (e.detail ?? {}) as Row;
  const extra = ((detail.extra_errors ?? []) as Row[])[0];
  const src = extra ?? e;
  return { code: String(src.code ?? e.code ?? 'unknown'), message: typeof src.message === 'string' ? src.message : String(e.message ?? '') };
}

/** Địa chỉ không được tải ảnh: loopback, mạng riêng, link-local, CGNAT, ULA, không xác định. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** Danh mục lá dùng được (`AVAILABLE`), tên là đường dẫn từ gốc. */
function leavesOf(categories: Row[]): PlatformCategory[] {
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  const pathOf = (c: Row): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let n: Row | undefined = c; n && !seen.has(String(n.id)); n = byId.get(String(n.parent_id))) {
      seen.add(String(n.id));
      names.unshift(String(n.local_name ?? ''));
    }
    return names.join(' > ');
  };
  return categories
    .filter((c) => c.is_leaf === true)
    .filter((c) => !Array.isArray(c.permission_statuses) || c.permission_statuses.includes('AVAILABLE'))
    .map((c) => ({ externalId: String(c.id), name: pathOf(c) }));
}

/** Gram → kg tối đa 3 chữ số thập phân; mm → cm số nguyên dương (create-product-202309, VN chỉ nhận KILOGRAM, CENTIMETER). */
const kg = (g: number) => String(Math.max(1, Math.round(g)) / 1000);
const cm = (mm: number) => String(Math.max(1, Math.ceil(mm / 10)));
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function tiktokListingMethods(client: TiktokClient, deps: TiktokListingDeps = {}): ListingMethods {
  const fetchImage = deps.fetchImage ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolve;
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

  /** Tải ảnh nguồn: chỉ http(s), host phân giải ra địa chỉ công khai (kiểm lại sau mỗi lần chuyển hướng), tối đa 10MB. */
  async function download(source: string): Promise<{ bytes: ArrayBuffer; type: string; name: string }> {
    const bad = (why: string) => new MarketplaceError('rejected', 'image_source_invalid', why);
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw bad('URL ảnh không hợp lệ');
    }
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw bad('URL ảnh phải là http hoặc https');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addrs = isIP(host) ? [host] : await resolveHost(host).catch(() => []);
      if (!addrs.length || addrs.some(isPrivateAddress)) throw bad('Không tải được ảnh từ địa chỉ này');
      let res: Response;
      try {
        res = await fetchImage(url, { redirect: 'manual', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
      } catch {
        throw bad('Không tải được ảnh nguồn');
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw bad('Ảnh chuyển hướng quá nhiều lần');
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) throw bad(`Tải ảnh nguồn lỗi HTTP ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!type.startsWith('image/')) throw bad('URL không trỏ tới ảnh');
      if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw bad('Ảnh quá 10MB');
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw bad(bytes.byteLength ? 'Ảnh quá 10MB' : 'Ảnh rỗng');
      const name = decodeURIComponent(url.pathname.split('/').pop() || 'image') || 'image';
      return { bytes, type, name };
    }
  }

  return {
    async listCategories(token) {
      const data = await client.call<{ categories?: Row[] }>('GET', '/product/202309/categories', {
        token,
        query: { category_version: CATEGORY_VERSION },
      });
      return leavesOf(data?.categories ?? []);
    },

    // Chỉ thuộc tính sản phẩm luôn bắt buộc (`PRODUCT_PROPERTY`, `is_requried`, sàn viết sai chính tả); thuộc tính bắt buộc
    // theo điều kiện (`requirement_conditions`) và thuộc tính bán hàng (phân loại) chưa xử lý. `name` là mã thuộc tính
    // của sàn. Thuộc tính cho tự nhập (`is_customizable`) trả `options` rỗng để người dùng gõ giá trị riêng; lúc tạo sản
    // phẩm giá trị trùng tên lựa chọn có sẵn thì gửi theo mã.
    async categoryAttributes(token, externalCategoryId): Promise<CategoryAttribute[]> {
      return (await rawAttributes(token, externalCategoryId))
        .filter((a) => a.type === 'PRODUCT_PROPERTY' && a.is_requried === true)
        .map((a) => ({
          name: String(a.id),
          label: String(a.name ?? a.id),
          options: a.is_customizable === true ? [] : ((a.values ?? []) as Row[]).map((v) => String(v.name)),
        }));
    },

    // Sàn chỉ nhận file (multipart), không nhận URL: tải ảnh nguồn rồi đưa lên. Không gửi `shop_cipher` (API không theo
    // gian hàng). Trả `uri`, chuỗi Create Product cần trong `main_images`.
    async uploadImage(token, url) {
      const image = await download(url);
      const form = new FormData();
      form.append('data', new Blob([image.bytes], { type: image.type }), image.name);
      form.append('use_case', 'MAIN_IMAGE');
      const data = await client.call<{ uri?: unknown }>('POST', '/product/202309/images/upload', { token, form, shopCipher: false });
      if (typeof data?.uri !== 'string' || !data.uri) throw new MarketplaceError('rejected', 'unexpected_response');
      return data.uri;
    },

    // Một sản phẩm một SKU, gán kho mặc định. Sản phẩm mới qua duyệt của TikTok (create-product-202309: "After creation,
    // it will be sent for audit review"); `live` theo trạng thái đọc lại ngay sau khi tạo, còn lại về qua đồng bộ.
    async createProduct(token, p: NewProduct): Promise<CreatedProduct> {
      const [warehouseId, attrs] = await Promise.all([defaultWarehouse(token), rawAttributes(token, p.externalCategoryId)]);
      const byId = new Map(attrs.map((a) => [String(a.id), a]));
      const productAttributes = Object.entries(p.attributes).map(([id, value]) => {
        const builtIn = ((byId.get(id)?.values ?? []) as Row[]).find((v) => v.name === value);
        return { id, values: [builtIn ? { id: String(builtIn.id) } : { name: value }] };
      });
      const body = {
        save_mode: 'LISTING',
        title: p.name,
        description: `<p>${escapeHtml(p.description)}</p>`,
        category_id: p.externalCategoryId,
        category_version: CATEGORY_VERSION,
        main_images: p.imageUrls.map((uri) => ({ uri })),
        package_weight: { value: kg(p.weightG), unit: 'KILOGRAM' },
        package_dimensions: { length: cm(p.lengthMm), width: cm(p.widthMm), height: cm(p.heightMm), unit: 'CENTIMETER' },
        ...(productAttributes.length && { product_attributes: productAttributes }),
        skus: [
          {
            seller_sku: p.sellerSku,
            price: { amount: p.price, currency: CURRENCY },
            // docv2 ghi `quantity` khoảng [1, 99999]: tồn 0 thì bỏ `quantity`, chỉ gán kho.
            inventory: [{ warehouse_id: warehouseId, ...(p.quantity > 0 && { quantity: p.quantity }) }],
          },
        ],
      };
      const data = await client.call<{ product_id?: unknown; skus?: Row[] }>('POST', '/product/202309/products', { token, body });
      const skuId = data?.skus?.[0]?.id;
      if (typeof data?.product_id !== 'string' || typeof skuId !== 'string') throw new MarketplaceError('rejected', 'unexpected_response');
      // Phản hồi không có trạng thái: đọc lại (shop thử SANDBOX duyệt ngay, `ACTIVATE`, gọi thật 07/11/2026). Đọc lỗi thì
      // coi như chờ duyệt, sản phẩm đã tạo nên không ném; mất uỷ quyền vẫn ném.
      const status = await productStatus(token, data.product_id).catch((err: unknown) => {
        if (err instanceof MarketplaceError && err.kind !== 'unauthorized') return null;
        throw err;
      });
      return { externalProductId: data.product_id, externalSkuId: skuId, live: status === 'ACTIVATE' };
    },

    // Hai API theo sản phẩm: tồn (`inventory/update`, kho mặc định) và giá (`prices/update`, chỉ nhận sản phẩm `ACTIVATE`).
    // SKU có cả giá và tồn thì lỗi ở một trong hai là lỗi của SKU (bên gọi tính chung, như Lazada).
    async updatePriceQuantity(token, items): Promise<PerSkuResult[]> {
      const groups = new Map<string, PriceQuantity[]>();
      for (const i of items) groups.set(i.externalProductId, [...(groups.get(i.externalProductId) ?? []), i]);
      const failed = new Map<string, SkuError>();
      const keepFirst = (m: Map<string, SkuError>) => {
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
            for (const i of stock) if (!failed.has(i.externalSkuId)) failed.set(i.externalSkuId, e);
          } else {
            // Gọi thật 07/11/2026: `quantity: 0` được nhận dù docv2 ghi khoảng [1, 99999].
            const stockBody = (subset: PriceQuantity[]) => ({
              skus: subset.map((i) => ({ id: i.externalSkuId, inventory: [{ warehouse_id: warehouseId, quantity: i.quantity }] })),
            });
            keepFirst(await perProduct(stock, (s) => client.call<Row>('POST', `${path}/inventory/update`, { token, body: stockBody(s) })));
          }
        }
        const price = group.filter((i) => i.price !== undefined);
        if (price.length) {
          const priceBody = (subset: PriceQuantity[]) => ({
            skus: subset.map((i) => ({ id: i.externalSkuId, price: { amount: i.price, currency: CURRENCY } })),
          });
          keepFirst(await perProduct(price, (s) => client.call<Row>('POST', `${path}/prices/update`, { token, body: priceBody(s) })));
        }
      }
      return items.map((i): PerSkuResult => {
        const e = failed.get(i.externalSkuId);
        return e ? { externalSkuId: i.externalSkuId, ok: false, ...e } : { externalSkuId: i.externalSkuId, ok: true };
      });
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
