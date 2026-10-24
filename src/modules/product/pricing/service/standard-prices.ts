// Khung của #14 (Khang): chữ ký đã chốt (plan chuẩn bị A12, R3), #14 viết thân ở file này, không sửa pricing/index.ts.
import type { Decimal } from 'decimal.js';
import { notImplemented } from '../../../../shared/errors/app-error.ts';


/**
 * Giá trong bảng giá chuẩn của công ty đang chọn; biến thể chưa có giá thì `null`.
 * Catalog dùng qua hàm tiêm ở src/modules/product/index.ts (V22), không import pricing.
 */
export async function getStandardPrices(_variantIds: readonly string[]): Promise<Map<string, Decimal | null>> {
  throw notImplemented('getStandardPrices', '#14');
}

/** Tạo bảng giá chuẩn cho công ty mới, trong giao dịch đăng ký của identity (V13, G2). */
export async function createStandardPricelist(_companyId: string): Promise<void> {
  throw notImplemented('createStandardPricelist', '#14');
}
