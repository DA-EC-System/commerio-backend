// Dựng tổ hợp giá trị và cấp SKU cho biến thể (Documents/21 5.1, P7, P8; D8, D9; plan #12 B4, B5).
// Gọi trong `withCompany` sau `lockVariants`: khoá theo công ty làm tuần tự mọi lần cấp số.
import { renderSku, skuPatternError } from '../domain/sku.ts';
import { findValuesWithAttribute } from '../repository/attributes.ts';
import { setSkuNextSeq } from '../repository/categories.ts';
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

/**
 * SKU cho từng tổ hợp theo thứ tự, mỗi biến thể một số. SKU đã có trong công ty (kể cả biến thể ngừng bán, hay danh
 * mục khác cùng quy tắc) hoặc vừa sinh trong lần này thì bỏ số đó, lấy số kế tiếp (D9, như mock FE). Ghi lại
 * `sku_next_seq`, không đổi `version` danh mục (P7).
 */
export async function allocateSkus(
  category: { id: string; skuPattern: string; skuNextSeq: number },
  combos: readonly (readonly ComboValue[])[],
): Promise<string[]> {
  // Quy tắc thiếu {SEQ} (ghi thẳng DB, không qua API) sẽ sinh cùng một SKU mãi trong lúc giữ khoá công ty.
  if (skuPatternError(category.skuPattern)) throw new Error(`Quy tắc SKU của danh mục ${category.id} không hợp lệ`);
  let seq = category.skuNextSeq;
  const skus: string[] = [];
  for (const combo of combos) {
    const codes = combo.map((v) => v.code);
    let sku: string;
    do sku = renderSku(category.skuPattern, seq++, codes);
    while (skus.includes(sku) || (await skuTaken(sku)));
    skus.push(sku);
  }
  await setSkuNextSeq(category.id, seq);
  return skus;
}
