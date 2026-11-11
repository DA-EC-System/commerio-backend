// TikTok Shop: tồn, giá, ẩn/hiện (#226) và đăng sản phẩm (#219). Gọi sàn qua `client.call` của `tiktok-client.ts`.
// Nguồn (docv2, tra 07/11/2026 qua `api/v1/document/detail`; cây tài liệu ngày đó không có bản mới hơn 202309 cho các
// API dưới đây): update-inventory-202309, update-price-202309, deactivate-products-202309, activate-products-202309,
// get-warehouse-list-202309 (bản 202502 của `/logistics/.../warehouses` là tạo kho, khác việc), get-categories-202309,
// get-category-attributes-202309, upload-product-image-202309, create-product-202309, sign-your-api-request.
// Đẩy lại (#219): edit-product-202509 (bản mới nhất của Edit Product trong OAS của skill `tts-openapi-guide`, tra
// 11/11/2026), get-product-202309.
// Kết quả gọi thật trên shop thử: mục TikTok của `channel/CLAUDE.md`.
import {
  type CategoryAttribute,
  type CreatedProduct,
  type MarketplaceAdapter,
  MarketplaceError,
  type NewProduct,
  type PerSkuResult,
  type PlatformCategory,
  type PriceQuantity,
  type RemoteSku,
} from './common.ts';
import { downloadImage, type ImageSourceOptions } from './image-source.ts';
import { type TiktokClient, unpackTiktokToken } from './tiktok-client.ts';

export { isPrivateAddress } from './image-source.ts';

type Row = Record<string, unknown>;

/** Cây danh mục 7 cấp: docv2 bắt shop US, EU, SEA (gồm VN) gửi `v2` cho danh mục, thuộc tính và tạo sản phẩm. */
const CATEGORY_VERSION = 'v2';
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
  | 'listCategories'
  | 'categoryAttributes'
  | 'uploadImage'
  | 'createProduct'
  | 'updateProduct'
  | 'updatePriceQuantity'
  | 'deactivate'
  | 'activate'
>;

/** Lỗi theo từng mục của API lô (`data.errors[]`): mã, câu của lỗi phụ đầu tiên nếu có (cụ thể hơn 12052990 "check failed"). */
function itemError(e: Row): { code: string; message: string } {
  const detail = (e.detail ?? {}) as Row;
  const extra = ((detail.extra_errors ?? []) as Row[])[0];
  const src = extra ?? e;
  return { code: String(src.code ?? e.code ?? 'unknown'), message: typeof src.message === 'string' ? src.message : String(e.message ?? '') };
}

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

  /** Phần nội dung chung của Create Product và Edit Product: tiêu đề, mô tả, danh mục, ảnh, gói hàng, thuộc tính. */
  async function productContent(token: string, p: NewProduct) {
    const attrs = await rawAttributes(token, p.externalCategoryId);
    const byId = new Map(attrs.map((a) => [String(a.id), a]));
    const productAttributes = Object.entries(p.attributes).map(([id, value]) => {
      const builtIn = ((byId.get(id)?.values ?? []) as Row[]).find((v) => v.name === value);
      return { id, values: [builtIn ? { id: String(builtIn.id) } : { name: value }] };
    });
    return {
      title: p.name,
      description: `<p>${escapeHtml(p.description)}</p>`,
      category_id: p.externalCategoryId,
      category_version: CATEGORY_VERSION,
      main_images: p.imageUrls.map((uri) => ({ uri })),
      package_weight: { value: kg(p.weightG), unit: 'KILOGRAM' },
      package_dimensions: { length: cm(p.lengthMm), width: cm(p.widthMm), height: cm(p.heightMm), unit: 'CENTIMETER' },
      ...(productAttributes.length && { product_attributes: productAttributes }),
    };
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
      const image = await downloadImage(url, deps.image);
      const form = new FormData();
      form.append('data', new Blob([new Uint8Array(image.bytes)], { type: image.type }), image.name);
      form.append('use_case', 'MAIN_IMAGE');
      const data = await client.call<{ uri?: unknown }>('POST', '/product/202309/images/upload', { token, form, shopCipher: false });
      if (typeof data?.uri !== 'string' || !data.uri) throw new MarketplaceError('rejected', 'unexpected_response');
      return data.uri;
    },

    // Một sản phẩm một SKU, gán kho mặc định. Sản phẩm mới qua duyệt của TikTok (create-product-202309: "After creation,
    // it will be sent for audit review"); `live` theo trạng thái đọc lại ngay sau khi tạo, còn lại về qua đồng bộ.
    async createProduct(token, p: NewProduct): Promise<CreatedProduct> {
      // Idempotent theo `seller_sku`: lần đẩy trước đã tạo (mất kết quả vì lỗi mạng, tiến trình chết, token hỏng ở bước
      // đọc lại) thì trả sản phẩm đó, không tạo thêm. Search Products có thể trễ vài giây sau khi tạo (gọi thật 07/11/2026),
      // nên còn gửi `idempotency_key` của lượt đẩy (#219): sàn nhận lại khoá đã dùng thì trả `12052996`, không tạo trùng.
      const existing = deps.findSku ? await deps.findSku(token, p.sellerSku) : null;
      if (existing) return { externalProductId: existing.externalProductId, externalSkuId: existing.externalSkuId, live: existing.state === 'live' };
      const [warehouseId, content] = await Promise.all([defaultWarehouse(token), productContent(token, p)]);
      const body = {
        save_mode: 'LISTING',
        ...(p.idempotencyKey && { idempotency_key: p.idempotencyKey }),
        ...content,
        skus: [
          {
            seller_sku: p.sellerSku,
            price: { amount: p.price, currency: CURRENCY },
            // docv2 ghi `quantity` khoảng [1, 99999]: tồn 0 thì bỏ `quantity`, chỉ gán kho.
            inventory: [{ warehouse_id: warehouseId, ...(p.quantity > 0 && { quantity: p.quantity }) }],
          },
        ],
      };
      let data: { product_id?: unknown; skus?: Row[] } | undefined;
      try {
        data = await client.call<{ product_id?: unknown; skus?: Row[] }>('POST', '/product/202309/products', { token, body });
      } catch (err) {
        if (!(err instanceof MarketplaceError) || err.platformCode !== DUPLICATE_REQUEST) throw err;
        // Lượt này đã tạo sản phẩm: tìm theo `seller_sku`. Search chưa thấy (trễ) thì là lỗi tạm, việc nền thử lại sau;
        // quá 30 phút thì đồng bộ đưa listing về `push_failed` (Documents/21 §18.3).
        const found = deps.findSku ? await deps.findSku(token, p.sellerSku) : null;
        if (found) return { externalProductId: found.externalProductId, externalSkuId: found.externalSkuId, live: found.state === 'live' };
        throw new MarketplaceError('unavailable', DUPLICATE_REQUEST, 'Sàn đã nhận lượt tạo sản phẩm này nhưng chưa tìm thấy sản phẩm, thử lại sau');
      }
      const skuId = data?.skus?.[0]?.id;
      if (typeof data?.product_id !== 'string' || typeof skuId !== 'string') throw new MarketplaceError('rejected', 'unexpected_response');
      // Phản hồi không có trạng thái: đọc lại (shop thử SANDBOX duyệt ngay, `ACTIVATE`, gọi thật 07/11/2026). Sản phẩm đã
      // tạo: mọi lỗi của bước đọc lại (kể cả `unauthorized`) coi như chờ duyệt và vẫn trả kết quả, trạng thái thật về qua
      // đồng bộ. Ném ở đây thì bên gọi tưởng chưa tạo, đẩy lại thành sản phẩm trùng.
      const status = await productStatus(token, data.product_id).catch(() => null);
      return { externalProductId: data.product_id, externalSkuId: skuId, live: status === 'ACTIVATE' };
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
