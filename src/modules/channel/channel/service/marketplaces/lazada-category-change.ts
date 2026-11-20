// Lazada: đổi category của sản phẩm đang bán (`apply-category`, commerio-backend#467). Hàm thuần đọc `data` của
// GetProductItem (`/product/item/get`: `skus[]` {SkuId, SellerSku, price, special_price, Status}, `images[]`, `status`);
// `lazada.ts` gọi sàn. Tên trường theo `Documents/tich-hop-san/lazada.md`; chưa gọi thật với sản phẩm đổi category.

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const text = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** Một SKU khi đọc: mã SKU sàn, SKU người bán, giá và giá khuyến mãi (chuỗi như sàn trả), trạng thái viết thường. */
export interface LazadaSkuView {
  skuId: string;
  sellerSku: string;
  price: string | null;
  specialPrice: string | null;
  status: string;
}

export function lazadaSkuViews(data: unknown): LazadaSkuView[] {
  const skus = isRow(data) ? rows(data.skus) : [];
  return skus.map((s) => ({
    skuId: String(s.SkuId ?? ''),
    sellerSku: text(s.SellerSku) ?? String(s.SkuId ?? ''),
    price: text(s.price),
    specialPrice: text(s.special_price),
    status: String(s.Status ?? '').toLowerCase(),
  }));
}

const imageCount = (data: unknown): number => (isRow(data) && Array.isArray(data.images) ? data.images.filter((i) => typeof i === 'string' && i !== '').length : 0);

const samePrice = (a: string | null, b: string | null) => a === b || (a !== null && b !== null && Number(a) === Number(b));

/**
 * So sản phẩm trước khi sửa với lần đọc lại sau khi sửa: số SKU, SKU người bán, giá và giá khuyến mãi từng SKU, số ảnh. Trả
 * các chỗ lệch, mỗi chỗ một cụm viết thường đầu câu để ghép sau "Sau khi đổi category, <sàn> "; rỗng là khớp.
 */
export function lazadaCategoryMismatch(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  const was = lazadaSkuViews(before);
  const now = lazadaSkuViews(after);
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
    if (!n) continue;
    if (!samePrice(s.price, n.price)) out.push(`đổi giá SKU ${s.sellerSku}: ${s.price ?? 'trống'} → ${n.price ?? 'trống'}`);
    if (!samePrice(s.specialPrice, n.specialPrice)) {
      out.push(`đổi giá khuyến mãi SKU ${s.sellerSku}: ${s.specialPrice ?? 'trống'} → ${n.specialPrice ?? 'trống'}`);
    }
  }
  const imagesBefore = imageCount(before);
  const imagesAfter = imageCount(after);
  if (imagesAfter !== imagesBefore) out.push(`còn ${imagesAfter}/${imagesBefore} ảnh`);
  return out;
}

/** Mã SKU (sàn) đã tắt trước khi sửa mà sau khi sửa đang bật: phải tắt lại. `all` coi mọi SKU còn lại là phải tắt. */
export function lazadaReactivated(before: unknown, after: unknown, all = false): string[] {
  const wasInactive = new Set(lazadaSkuViews(before).filter((s) => all || s.status === 'inactive').map((s) => s.skuId));
  return lazadaSkuViews(after)
    .filter((s) => wasInactive.has(s.skuId) && s.status === 'active')
    .map((s) => s.skuId);
}

/** Sản phẩm đang chờ duyệt lại sau khi sửa: `data.status` "Pending QC", hoặc có SKU ở trạng thái chờ duyệt. */
export function lazadaUnderReview(after: unknown): boolean {
  if (!isRow(after)) return false;
  if (String(after.status ?? '') === 'Pending QC') return true;
  return lazadaSkuViews(after).some((s) => s.status.includes('pending'));
}
