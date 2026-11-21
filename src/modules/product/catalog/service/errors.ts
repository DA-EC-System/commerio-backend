// Lỗi nghiệp vụ dùng chung của catalog (Documents/21 5.3, C3, V6, V24). Mã lỗi đã chốt với FE.
import { AppError } from '../../../../shared/errors/app-error.ts';

/** Người gọi đã qua `ctx.authorize`: công ty đang chọn và tài khoản (ghi nhật ký). */
export interface Caller {
  readonly companyId: string;
  readonly accountId: string;
}

export const notFound = (what: string) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);

export const nameTaken = (message: string) =>
  new AppError(409, 'name_taken', 'Tên đã được dùng', { errors: { name: message } });

export const versionConflict = (detail: string, current: unknown) =>
  new AppError(409, 'version_conflict', detail, { current });

export const inUse = (detail: string) => new AppError(409, 'in_use', detail);

/** Ghi vào dòng nền tảng (dữ liệu chung, Documents/21 mục 5.5): chỉ migration đổi được. */
export const platformManaged = () => new AppError(403, 'platform_managed', 'Dữ liệu chuẩn của nền tảng, công ty không sửa được');

/** `company_id` NULL là dòng nền tảng. */
export const scopeOf = (companyId: string | null) => (companyId === null ? ('platform' as const) : ('company' as const));

/** Xoá hẳn sản phẩm đã hoàn thiện, đã dùng ở module khác hoặc sinh từ đề nghị nhập (#204, Documents/21 §17.4). */
export const productInUse = (detail: string) => new AppError(409, 'product_in_use', detail);

export const variantExists = (sku: string) => new AppError(409, 'variant_exists', `Tổ hợp này đã có biến thể ${sku}`);

/** Lưu trữ một SKU còn tồn hoặc chứng từ mở (Documents/21 §17.4); `reasons` là câu hiện thẳng ở FE. */
export const archiveBlocked = (sku: string, reasons: readonly string[]) =>
  new AppError(409, 'archive_blocked', `SKU ${sku} chưa lưu trữ được`, { reasons: [...reasons] });

/** Thao tác trạng thái kinh doanh không có từ trạng thái hiện tại; `current` là sản phẩm mới nhất. */
export const invalidTransition = (current: unknown) =>
  new AppError(409, 'invalid_transition', 'Thao tác không hợp lệ ở trạng thái hiện tại', { current });

/** Thêm biến thể trùng tổ hợp của SKU đã lưu trữ (Documents/21 §17.4): dùng Khôi phục SKU đó. */
export const variantArchived = (variantId: string) =>
  new AppError(409, 'variant_archived', 'Tổ hợp này thuộc SKU đã lưu trữ, dùng Khôi phục', { variantId });

/**
 * Xoá trống trường bắt buộc chung khi SKU còn listing chưa gỡ (US-SP-03 dòng 7, Documents/25 §5.1, Documents/21 §17.4);
 * `errors` theo ô như 422 để FE đánh dấu đúng ô.
 */
export const listingFieldRequired = (detail: string, errors: Record<string, string>) =>
  new AppError(409, 'listing_field_required', detail, { errors });

/** 422 theo ô cho luật kiểm ở service (cần đọc DB), cùng dạng với `validate()`. */
export const invalid = (errors: Record<string, string>) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });

export { isUuid } from '../../../../shared/uuid.ts';

export { pgError } from '../../../../shared/db/pg-error.ts';

/** Phần chung của một dòng nhật ký thao tác trong công ty. */
export function auditOf(caller: Caller, action: 'create' | 'update' | 'delete', entityType: string, entityId: string) {
  return { companyId: caller.companyId, actorId: caller.accountId, action, entityType, entityId };
}
