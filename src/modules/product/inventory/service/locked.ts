// Tạm khoá của SKU (Documents/21 mục 15.1): phần giảm của phiếu kho đang chờ duyệt (#208, Documents/25 §7.1). File
// riêng để `port.ts`, lõi ghi sổ và ngưỡng cùng import mà không thành vòng (spec #206 mục 5.2).
import { pendingLocks } from '../repository/documents.ts';

/** Tạm khoá theo biến thể; không truyền `variantIds` là mọi SKU đang bị khoá. SKU không bị khoá thì vắng trong Map. */
export const lockedOf = (variantIds?: readonly string[]): Promise<Map<string, number>> => pendingLocks(variantIds);
