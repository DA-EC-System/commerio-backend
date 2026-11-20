// SKU còn listing chưa gỡ thì không xoá trống trường bắt buộc chung (US-SP-03 dòng 7, Documents/25 §5.1, §5.2; review
// #345): lần đẩy, đồng bộ sau sẽ thiếu số liệu sàn bắt buộc. Trường của SKU (giá muốn bán, cân nặng, ba cạnh) xét listing
// của chính SKU đó, vì mỗi SKU là một sản phẩm trên sàn; ảnh ở cha dùng cho listing của mọi SKU nên xét mọi SKU của cha.
// Tên, nhóm hàng, mã SKU không xoá được qua API. Ngưỡng tồn (route của inventory, `minQty: null` ở sửa hàng loạt) chưa chặn.
// Đọc hiện diện không khoá: listing tạo xen giữa lúc kiểm và lúc ghi thì lọt, cùng loại D10.
import type { VariantRow } from '../repository/variants.ts';
import { type CatalogContext, requirePort } from './usage.ts';

const SKU_FIELDS = ['targetNetPrice', 'weightG', 'lengthMm', 'widthMm', 'heightMm'] as const;
type SkuField = (typeof SKU_FIELDS)[number];

const LABELS: Record<SkuField, string> = {
  targetNetPrice: 'giá muốn bán',
  weightG: 'cân nặng',
  lengthMm: 'chiều dài',
  widthMm: 'chiều rộng',
  heightMm: 'chiều cao',
};

const FIELD_MESSAGE = 'SKU còn listing chưa gỡ, không xoá trống được';

/** Trường mà lần sửa này xoá trống: gửi `null` khi đang có giá trị (gửi lại `null` cho ô đã trống không tính). */
export function clearedSkuFields(
  current: Pick<VariantRow, SkuField>,
  input: Partial<Record<SkuField, number | null | undefined>>,
): SkuField[] {
  return SKU_FIELDS.filter((field) => input[field] === null && current[field] !== null);
}

/** SKU có ít nhất một listing chưa gỡ, mọi gian hàng; một câu cho cả lô. */
async function listedIds(ctx: CatalogContext, variantIds: readonly string[]): Promise<Set<string>> {
  const presence = await requirePort(ctx, 'listingPresenceOf')(variantIds);
  return new Set(variantIds.filter((id) => (presence.get(id)?.listingCount ?? 0) > 0));
}

/**
 * Lỗi theo ô khi lần sửa xoá trống trường bắt buộc của một SKU còn listing chưa gỡ; không thì `null`. Chỉ hỏi channel khi
 * có ô bị xoá trống. Gọi trong `withCompany` của bên gọi (PATCH SKU, sửa hàng loạt), trước `applyVariantUpdate`.
 */
export async function listedFieldErrors(
  ctx: CatalogContext,
  current: Pick<VariantRow, 'id' | 'sku' | SkuField>,
  input: Partial<Record<SkuField, number | null | undefined>>,
): Promise<{ detail: string; errors: Record<string, string> } | null> {
  const cleared = clearedSkuFields(current, input);
  if (!cleared.length || !(await listedIds(ctx, [current.id])).has(current.id)) return null;
  return {
    detail: `SKU ${current.sku} còn listing chưa gỡ: không xoá trống được ${cleared.map((f) => LABELS[f]).join(', ')}`,
    errors: Object.fromEntries(cleared.map((f) => [f, FIELD_MESSAGE])),
  };
}

/**
 * Lỗi khi PUT gỡ hết ảnh của sản phẩm có SKU còn listing chưa gỡ; không thì `null`. `imageIds` là danh sách gửi lên
 * (`undefined` là giữ nguyên ảnh).
 */
export async function listedImageErrors(
  ctx: CatalogContext,
  variantIds: readonly string[],
  imagesBefore: readonly string[],
  imageIds: readonly string[] | undefined,
): Promise<{ detail: string; errors: Record<string, string> } | null> {
  if (!imageIds || imageIds.length || !imagesBefore.length || !variantIds.length) return null;
  if (!(await listedIds(ctx, variantIds)).size) return null;
  return {
    detail: 'Sản phẩm còn listing chưa gỡ: cần giữ ít nhất 1 ảnh',
    errors: { images: 'Sản phẩm còn listing chưa gỡ, cần ít nhất 1 ảnh' },
  };
}
