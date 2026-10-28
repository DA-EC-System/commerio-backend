// Quy tắc SKU của danh mục (QT-11, Documents/21 5.1, mục 9). Chép đúng hành vi `FE src/utils/sku.ts` (D9):
// bản xem trước của FE và SKU thật phải trùng từng ký tự. Đổi ở đây thì đổi cả FE và bảng mục 9.

const TOKEN = /\{(SEQ(?::(\d))?|VAL)\}/g;
const LITERAL = /^[A-Z0-9_-]*$/;

/** Mã giá trị mặc định: bỏ dấu, viết hoa, chỉ A-Z0-9, tối đa 6 ký tự ("Xanh navy" → "XANHNA"). */
export function valueCode(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/** Câu lỗi của quy tắc (bảng 9.3), `null` nếu hợp lệ. Độ dài tính sau `trim`. */
export function skuPatternError(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return 'Nhập quy tắc SKU';
  if (p.length > 40) return 'Quy tắc tối đa 40 ký tự';
  const seq = p.match(/\{SEQ(?::\d)?\}/g) ?? [];
  if (seq.length !== 1) return 'Quy tắc phải có đúng một {SEQ} để SKU không trùng';
  if ((p.match(/\{VAL\}/g) ?? []).length > 1) return 'Chỉ dùng {VAL} một lần';
  const literal = p.replace(TOKEN, '');
  if (/\{|\}/.test(literal)) return 'Chỉ dùng {SEQ}, {SEQ:n} (n từ 1 đến 9) và {VAL}';
  if (!LITERAL.test(literal)) return 'Phần chữ cố định chỉ gồm A-Z, 0-9, "-" và "_"';
  if (/\{SEQ:0\}/.test(p)) return 'Số chữ số của {SEQ} từ 1 đến 9';
  return null;
}

/** SKU của một biến thể; `codes` là mã giá trị theo thứ tự thuộc tính của sản phẩm (bảng 9.1). */
export function renderSku(pattern: string, seq: number, codes: readonly string[]): string {
  const val = codes.filter(Boolean).join('-');
  return (
    pattern
      .trim()
      .replace(TOKEN, (_, token: string, width?: string) =>
        token === 'VAL' ? val : String(seq).padStart(Number(width ?? 4), '0'),
      )
      // Biến thể không có thuộc tính: bỏ dấu nối thừa quanh {VAL}
      .replace(/([-_]){2,}/g, '$1')
      .replace(/^[-_]+|[-_]+$/g, '')
  );
}
