// Lỗi nghiệp vụ dùng chung của catalog (Documents/21 5.3, C3, V6, V24). Mã lỗi đã chốt với FE.
import { AppError } from '../../../shared/errors/app-error.ts';

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

export const productArchived = () => new AppError(409, 'product_archived', 'Sản phẩm đã lưu trữ, không sửa được');

export const variantExists = (sku: string) => new AppError(409, 'variant_exists', `Tổ hợp này đã có biến thể ${sku}`);

export const lastVariant = () =>
  new AppError(409, 'last_variant', 'Sản phẩm phải còn ít nhất một biến thể đang bán. Muốn ngừng hẳn thì xoá sản phẩm');

/** 422 theo ô cho luật kiểm ở service (cần đọc DB), cùng dạng với `validate()`. */
export const invalid = (errors: Record<string, string>) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });

export { isUuid } from '../../../shared/uuid.ts';

export { pgError } from '../../../shared/db/pg-error.ts';

/** Phần chung của một dòng nhật ký thao tác trong công ty. */
export function auditOf(caller: Caller, action: 'create' | 'update' | 'delete', entityType: string, entityId: string) {
  return { companyId: caller.companyId, actorId: caller.accountId, action, entityType, entityId };
}
