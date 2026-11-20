// Dựng tổ hợp giá trị và cấp SKU cho biến thể (Documents/21 5.1, P7, P8; D8, D9; plan #12 B4, B5).
// Gọi trong `withCompany` sau `lockVariants`: khoá theo công ty làm tuần tự mọi lần cấp số.
import { renderSku, skuPatternError } from '../domain/sku.ts';
import { findValuesWithAttribute } from '../repository/attributes.ts';
import { productCodeTaken } from '../repository/products.ts';
import { findSettings, setSkuNextSeq } from '../repository/settings.ts';
import { skuTaken } from '../repository/variants.ts';
import { isUuid } from './errors.ts';

export interface ComboValue {
  id: string;
  code: string;
  attributeId: string;
}

/** Tổ hợp hợp lệ, đã sắp theo thứ tự thuộc tính `order`; hoặc câu lỗi cho người dùng. */
export type Combos = { ok: true; combos: ComboValue[][] } | { ok: false; message: string };

/**
 * Đọc giá trị (chỉ thấy của công ty mình, RLS) và kiểm: giá trị có thật, mỗi thuộc tính một giá trị, mọi tổ hợp
 * cùng bộ thuộc tính `order` (bỏ trống = theo tổ hợp đầu), không trùng nhau. Mỗi tổ hợp được sắp theo `order`
 * để `{VAL}` và `position` nhất quán trong một sản phẩm dù client gửi đảo.
 */
export async function resolveCombos(lists: readonly (readonly string[])[], order?: readonly string[]): Promise<Combos> {
  const ids = [...new Set(lists.flat())];
  const found = new Map((await findValuesWithAttribute(ids.filter(isUuid))).map((v) => [v.id, v]));
  const combos: ComboValue[][] = [];
  for (const list of lists) {
    const combo = list.map((id) => found.get(id));
    if (combo.some((v) => v === undefined)) return { ok: false, message: 'Biến thể có giá trị không hợp lệ' };
    const attrs = combo.map((v) => v!.attributeId);
    if (new Set(attrs).size !== attrs.length) return { ok: false, message: 'Mỗi thuộc tính chỉ chọn một giá trị' };
    combos.push(combo as ComboValue[]);
  }
  const attributeOrder = order ?? combos[0]?.map((v) => v.attributeId) ?? [];
  const sameSet = (combo: ComboValue[]) =>
    combo.length === attributeOrder.length && combo.every((v) => attributeOrder.includes(v.attributeId));
  if (!combos.every(sameSet)) return { ok: false, message: 'Mọi biến thể phải dùng cùng bộ thuộc tính' };
  const sorted = combos.map((combo) =>
    [...combo].sort((a, b) => attributeOrder.indexOf(a.attributeId) - attributeOrder.indexOf(b.attributeId)),
  );
  const keys = sorted.map((combo) => comboKey(combo.map((v) => v.id)));
  if (new Set(keys).size !== keys.length) return { ok: false, message: 'Có tổ hợp thuộc tính bị trùng' };
  return { ok: true, combos: sorted };
}

/** Khoá so sánh tổ hợp theo id giá trị, không phụ thuộc thứ tự. */
export const comboKey = (valueIds: readonly string[]) => [...valueIds].sort().join('|');

/** `seller_sku` của TikTok tối đa 50 ký tự (Documents/21 mục 5.2); CHECK `product_variants_sku_length` chặn cuối. */
export const MAX_SKU_LENGTH = 50;
export const SKU_TOO_LONG = `SKU sinh ra quá ${MAX_SKU_LENGTH} ký tự, sửa mẫu SKU ở Cài đặt sản phẩm`;

/** SKU cấp được kèm mẫu đã dùng (mã cha cần), hoặc chỉ số tổ hợp đầu tiên sinh SKU quá dài (chưa ghi gì). */
export type Allocation =
  | { ok: true; pattern: string; skus: { sku: string; seq: number }[] }
  | { ok: false; index: number };

/**
 * SKU cho từng tổ hợp theo mẫu của công ty (`company_product_settings`), mỗi biến thể một số. SKU đã có trong công ty
 * (kể cả biến thể ngừng bán, SKU sinh theo mẫu cũ) hoặc vừa sinh trong lần này thì bỏ số đó, lấy số kế tiếp (D9). Ghi
 * lại `sku_next_seq`, không đổi `version` cài đặt (P7). Trả kèm số `{SEQ}` của từng SKU (mã cha lấy số của SKU đầu).
 */
export async function allocateSkus(companyId: string, combos: readonly (readonly ComboValue[])[]): Promise<Allocation> {
  const { skuPattern, skuNextSeq } = await findSettings(companyId);
  // Mẫu thiếu {SEQ} (ghi thẳng DB, không qua API) sẽ sinh cùng một SKU mãi trong lúc giữ khoá công ty.
  if (skuPatternError(skuPattern)) throw new Error(`Mẫu SKU của công ty ${companyId} không hợp lệ`);
  let seq = skuNextSeq;
  const skus: { sku: string; seq: number }[] = [];
  for (const [index, combo] of combos.entries()) {
    const codes = combo.map((v) => v.code);
    let sku: string;
    do sku = renderSku(skuPattern, seq++, codes);
    while (skus.some((r) => r.sku === sku) || (await skuTaken(sku)));
    if (sku.length > MAX_SKU_LENGTH) return { ok: false, index };
    skus.push({ sku, seq: seq - 1 });
  }
  await setSkuNextSeq(companyId, seq);
  return { ok: true, pattern: skuPattern, skus };
}

/**
 * Mã cha (#204 D5): mẫu SKU với số của SKU đầu tiên, bỏ phần giá trị thuộc tính. Mã đã có trong công ty (sinh theo
 * mẫu cũ) thì thêm `-2`, `-3`… Gọi sau `lockVariants` như `allocateSkus`.
 */
export async function productCodeFor(pattern: string, firstSeq: number): Promise<string> {
  const base = renderSku(pattern, firstSeq, []);
  let code = base;
  for (let n = 2; await productCodeTaken(code); n++) code = `${base}-${n}`;
  return code;
}
