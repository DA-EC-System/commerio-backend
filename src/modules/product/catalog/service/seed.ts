import { insertCompanyDefaults } from '../repository/seed.ts';

/**
 * Cài đặt sản phẩm, 12 nhóm hàng, "Màu sắc", "Kích cỡ" cho công ty vừa lập (Documents/21 mục 11.3). Chạy trong giao dịch
 * của bên gọi (`register`), lỗi thì công ty cũng không được tạo. core tiêm hàm này qua `ModuleContext` (src/wiring.ts).
 */
export async function seedCompanyDefaults(companyId: string): Promise<void> {
  await insertCompanyDefaults(companyId);
}
