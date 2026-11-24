// Bỏ dấu, chữ thường cho tìm kiếm và so tên SKU sàn (#565, Documents/21 §18.12: "so trên chuỗi đã bỏ dấu, chữ thường").
// Một bảng ký tự dùng cho cả code (`foldVi`) và SQL (`translate(normalize(col, NFC), FOLD_FROM, FOLD_TO)`), để lọc trong
// CSDL và so trong Node ra cùng một chuỗi. Không dùng extension `unaccent` (cần quyền tạo extension trên Supabase) và không
// dùng `lower()` của Postgres (kết quả theo locale của CSDL; bảng này tự đổi chữ hoa).

/** Cặp ký tự (nguồn, đích): chữ Latin có dấu (U+00C0–U+024F, U+1E00–U+1EFF) → chữ không dấu thường; `Đ`, `đ` → `d`; A–Z → a–z. */
function buildPairs(): [string, string][] {
  const pairs: [string, string][] = [
    ["Đ", "d"],
    ["đ", "d"],
  ];
  for (let c = 65; c <= 90; c++)
    pairs.push([String.fromCharCode(c), String.fromCharCode(c + 32)]);
  for (const [from, to] of [
    [0x00c0, 0x024f],
    [0x1e00, 0x1eff],
  ] as const) {
    for (let c = from; c <= to; c++) {
      const ch = String.fromCodePoint(c);
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      if (base.length === 1 && /[A-Za-z]/.test(base) && base !== ch)
        pairs.push([ch, base.toLowerCase()]);
    }
  }
  return pairs;
}

const PAIRS = buildPairs();
/** Ký tự nguồn cho `translate()` của SQL. */
export const FOLD_FROM = PAIRS.map(([f]) => f).join("");
/** Ký tự đích, cùng vị trí với `FOLD_FROM`. */
export const FOLD_TO = PAIRS.map(([, t]) => t).join("");
const MAP = new Map(PAIRS);

/** Bỏ dấu, chữ thường: NFC rồi đổi từng ký tự theo bảng; ký tự ngoài bảng giữ nguyên (cùng kết quả với SQL `translate`). */
export function foldVi(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) out += MAP.get(ch) ?? ch;
  return out;
}
