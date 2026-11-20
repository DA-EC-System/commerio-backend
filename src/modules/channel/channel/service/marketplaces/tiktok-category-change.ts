// TikTok: đổi category của sản phẩm đang bán (`apply-category`, commerio-backend#467, Documents/21 §18.5). Hàm thuần dựng
// body Edit Product từ chính dữ liệu Get Product và so hai lần đọc; `tiktok-listing.ts` gọi sàn.
//
// OAS cục bộ của skill `tts-openapi-guide` (references/oas/paths/product.json, tra 20/11/2026):
// - Edit Product `PUT /product/202509/products/{product_id}`: "All inputs, including blanks, in the request payload will
//   overwrite existing values"; SKU có trong sản phẩm mà không có trong `skus` bị xoá (`skus[].id`); bỏ `skus[].inventory` thì
//   giữ tồn cũ. Partial Edit không có `category_id`.
// - Get Product `GET /product/202309/products/{product_id}` (`return_under_review_version=true` đọc bản đang duyệt).
//
// Trường đọc (Get Product 202309) → trường gửi (Edit Product 202509), đều đã đối chiếu tên trong OAS:
//   title → title; description → description (nguyên chuỗi HTML sàn trả); main_images[].uri → main_images[].uri;
//   package_dimensions {length, width, height, unit} → package_dimensions; package_weight {value, unit} → package_weight;
//   brand.id → brand_id; size_chart.template.id → size_chart.template.id, không có thì size_chart.image.uri →
//   size_chart.image.uri, không có cả hai thì `sizeChartUri` của app → size_chart.image.uri;
//   delivery_options[] (is_available) → delivery_option_ids; is_cod_allowed → is_cod_allowed; video.id → video.id;
//   certifications[] {id, images[].uri, files[] {id, name, format}, expiration_date} → certifications[];
//   is_pre_owned, minimum_order_quantity, shipping_insurance_requirement, external_product_id, manufacturer_ids,
//   responsible_person_ids → cùng tên;
//   skus[]: id, seller_sku, price.sale_price (giá hiển thị của người bán VN) → price.amount + price.currency,
//   sales_attributes[] {id, name, value_id, value_name, sku_img.uri, supplementary_sku_images[].uri},
//   identifier_code {code, type}, extra_identifier_codes, external_sku_id, list_price {amount, currency} → cùng tên.
// Không gửi `skus[].inventory`: OAS cho bỏ để giữ tồn cũ; gửi số đọc được có thể đè số mới hơn do đơn hay lượt đẩy tồn ghi
// giữa lúc đọc và lúc sửa. Thay: category_id (+ category_version v2) và product_attributes (attribute của spec).
import type { CategoryChangeInput } from './common.ts';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** `product_attributes` đã đổi sang mã của sàn (`productAttributes` của `tiktok-listing.ts`). */
export type TiktokProductAttribute = { id: string; values: ({ id: string } | { name: string })[] };

/** Một SKU khi đọc: SKU người bán, mã SKU sàn, giá hiển thị (chuỗi như sàn trả, null khi không có). */
interface SkuView {
  id: string;
  sellerSku: string;
  price: string | null;
}

function skuViews(product: Row | undefined): SkuView[] {
  return rows(product?.skus).map((s) => {
    const price = isRow(s.price) ? (str(s.price.sale_price) ?? str(s.price.amount) ?? null) : null;
    return { id: String(s.id ?? ''), sellerSku: str(s.seller_sku) ?? String(s.id ?? ''), price };
  });
}

function salesAttributes(s: Row): Row[] {
  return rows(s.sales_attributes).map((a) => {
    const img = isRow(a.sku_img) ? str(a.sku_img.uri) : undefined;
    const more = rows(a.supplementary_sku_images).flatMap((i) => (str(i.uri) ? [{ uri: String(i.uri) }] : []));
    return {
      ...(a.id !== undefined && { id: String(a.id) }),
      ...(str(a.name) && { name: a.name }),
      ...(a.value_id !== undefined && { value_id: String(a.value_id) }),
      ...(str(a.value_name) && { value_name: a.value_name }),
      ...(img && { sku_img: { uri: img } }),
      ...(more.length && { supplementary_sku_images: more }),
    };
  });
}

function editSku(s: Row, currency: string): Row {
  const price = isRow(s.price) ? (str(s.price.sale_price) ?? str(s.price.amount)) : undefined;
  const sales = salesAttributes(s);
  const code = isRow(s.identifier_code) && str(s.identifier_code.code) ? { code: s.identifier_code.code, type: s.identifier_code.type } : undefined;
  const listPrice = isRow(s.list_price) && str(s.list_price.amount) ? { amount: s.list_price.amount, currency: s.list_price.currency ?? currency } : undefined;
  return {
    id: String(s.id),
    ...(str(s.seller_sku) && { seller_sku: s.seller_sku }),
    ...(price && { price: { amount: price, currency: (isRow(s.price) && str(s.price.currency)) || currency } }),
    ...(sales.length && { sales_attributes: sales }),
    ...(code && { identifier_code: code }),
    ...(strings(s.extra_identifier_codes).length && { extra_identifier_codes: strings(s.extra_identifier_codes) }),
    ...(str(s.external_sku_id) && { external_sku_id: s.external_sku_id }),
    ...(listPrice && { list_price: listPrice }),
  };
}

function sizeChartOf(current: Row | undefined, fallbackUri: string | undefined): Row | undefined {
  const chart = isRow(current?.size_chart) ? current.size_chart : undefined;
  const templateId = isRow(chart?.template) ? str(chart.template.id) : undefined;
  if (templateId) return { template: { id: templateId } };
  const uri = isRow(chart?.image) ? str(chart.image.uri) : undefined;
  if (uri) return { image: { uri } };
  return fallbackUri ? { image: { uri: fallbackUri } } : undefined;
}

function certificationsOf(current: Row | undefined): Row[] {
  return rows(current?.certifications).flatMap((c) => {
    if (!str(c.id)) return [];
    const images = rows(c.images).flatMap((i) => (str(i.uri) ? [{ uri: String(i.uri) }] : []));
    const files = rows(c.files).flatMap((f) => (str(f.id) ? [{ id: f.id, ...(str(f.name) && { name: f.name }), ...(str(f.format) && { format: f.format }) }] : []));
    return [
      {
        id: c.id,
        ...(images.length && { images }),
        ...(files.length && { files }),
        ...(typeof c.expiration_date === 'number' && { expiration_date: c.expiration_date }),
      },
    ];
  });
}

/**
 * Body Edit Product 202509 cho đổi category: mọi thứ lấy từ sản phẩm đang có trên sàn (`current`, Get Product 202309), chỉ
 * thay `category_id` và `product_attributes`. `sizeChartUri` chỉ dùng khi sản phẩm chưa có bảng size.
 */
export function tiktokCategoryEditBody(
  current: Row | undefined,
  input: Pick<CategoryChangeInput, 'externalCategoryId' | 'sizeChartUri'>,
  attributes: readonly TiktokProductAttribute[],
  opts: { categoryVersion: string; currency: string },
): Row {
  const images = rows(current?.main_images).flatMap((i) => (str(i.uri) ? [{ uri: String(i.uri) }] : []));
  const brandId = isRow(current?.brand) ? str(current.brand.id) : undefined;
  const deliveryIds = rows(current?.delivery_options).filter((d) => d.is_available === true).map((d) => String(d.id));
  const sizeChart = sizeChartOf(current, input.sizeChartUri);
  const certifications = certificationsOf(current);
  const videoId = isRow(current?.video) ? str(current.video.id) : undefined;
  const copy = (key: string) => (current?.[key] !== undefined && current[key] !== null ? { [key]: current[key] } : {});
  return {
    save_mode: 'LISTING',
    ...(str(current?.title) && { title: current!.title }),
    ...(typeof current?.description === 'string' && { description: current.description }),
    category_id: input.externalCategoryId,
    category_version: opts.categoryVersion,
    ...(images.length && { main_images: images }),
    ...(isRow(current?.package_dimensions) && { package_dimensions: current.package_dimensions }),
    ...(isRow(current?.package_weight) && { package_weight: current.package_weight }),
    ...(brandId && { brand_id: brandId }),
    ...(sizeChart && { size_chart: sizeChart }),
    ...(deliveryIds.length && { delivery_option_ids: deliveryIds }),
    ...(typeof current?.is_cod_allowed === 'boolean' && { is_cod_allowed: current.is_cod_allowed }),
    ...(videoId && { video: { id: videoId } }),
    ...(certifications.length && { certifications }),
    ...copy('is_pre_owned'),
    ...copy('minimum_order_quantity'),
    ...copy('shipping_insurance_requirement'),
    ...copy('external_product_id'),
    ...(strings(current?.manufacturer_ids).length && { manufacturer_ids: strings(current?.manufacturer_ids) }),
    ...(strings(current?.responsible_person_ids).length && { responsible_person_ids: strings(current?.responsible_person_ids) }),
    ...(attributes.length && { product_attributes: attributes }),
    skus: rows(current?.skus).map((s) => editSku(s, opts.currency)),
  };
}

const samePrice = (a: string | null, b: string | null) => a === b || (a !== null && b !== null && Number(a) === Number(b));

/**
 * So sản phẩm trước khi sửa với lần đọc lại sau khi sửa: số SKU, SKU người bán, giá từng SKU, số ảnh. Trả các chỗ lệch, mỗi
 * chỗ một cụm viết thường đầu câu để ghép sau "Sau khi đổi category, <sàn> " (vd "còn 2/3 SKU: thiếu AO-DEN-XL"); rỗng là khớp.
 */
export function tiktokCategoryMismatch(before: Row | undefined, after: Row | undefined): string[] {
  const out: string[] = [];
  const was = skuViews(before);
  const now = skuViews(after);
  const nowBySku = new Map(now.map((s) => [s.sellerSku, s]));
  const wasSkus = new Set(was.map((s) => s.sellerSku));
  const lost = was.filter((s) => !nowBySku.has(s.sellerSku)).map((s) => s.sellerSku);
  const added = now.filter((s) => !wasSkus.has(s.sellerSku)).map((s) => s.sellerSku);
  if (now.length !== was.length || lost.length) {
    out.push(`còn ${now.length}/${was.length} SKU${lost.length ? `: thiếu ${lost.join(', ')}` : ''}`);
  }
  if (added.length) out.push(`có thêm SKU ${added.join(', ')}`);
  for (const s of was) {
    const n = nowBySku.get(s.sellerSku);
    if (n && !samePrice(s.price, n.price)) out.push(`đổi giá SKU ${s.sellerSku}: ${s.price ?? 'trống'} → ${n.price ?? 'trống'}`);
  }
  const imagesBefore = rows(before?.main_images).length;
  const imagesAfter = rows(after?.main_images).length;
  if (imagesAfter !== imagesBefore) out.push(`còn ${imagesAfter}/${imagesBefore} ảnh`);
  return out;
}
