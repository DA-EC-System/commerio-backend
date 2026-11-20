// Mã số thuế (Documents/21 mục 2.1, #459): bỏ khoảng trắng, dấu chấm, dấu gạch; còn 10 số (doanh nghiệp), 12 số (số định
// danh cá nhân của hộ, cá nhân kinh doanh từ 01/07/2025) hoặc 13 số (đơn vị phụ thuộc, lưu dạng `0123456789-001`).
// Lưu và so trùng bằng dạng chuẩn; CSDL ép unique (`companies_tax_code_unique`).

/** Dạng chuẩn để lưu và so trùng, hoặc `null` khi không phải mã số thuế hợp lệ. */
export function normalizeTaxCode(input: string): string | null {
  const digits = input.replace(/[\s.-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 10 || digits.length === 12) return digits;
  if (digits.length === 13) return `${digits.slice(0, 10)}-${digits.slice(10)}`;
  return null;
}

export const TAX_CODE_FORMAT_MESSAGE = 'Mã số thuế gồm 10 số, 12 số (số định danh cá nhân) hoặc dạng 0123456789-001';

export const TAX_CODE_TAKEN_MESSAGE =
  'Mã số thuế này đã có công ty đăng ký. Nếu đây là doanh nghiệp của bạn, liên hệ hỗ trợ.';
