// Trục phân loại khai ngay trong form tạo sản phẩm (Documents/21 mục 5.2, #447): thuộc tính, giá trị chưa có thì tạo
// cùng giao dịch với sản phẩm. Luật hình dạng (15/20/50 ký tự, trùng trong trục, `options` khớp trục) đã kiểm ở Zod.
import { uniqueValueCode } from '../domain/sku.ts';
import { ensureAttribute, findAttributeIdByName, findAttributes, insertValues } from '../repository/attributes.ts';
import { isUuid } from './errors.ts';
import type { ComboValue } from './sku-allocation.ts';

export interface AxisInput {
  attributeId?: string | undefined;
  name?: string | undefined;
  values: { id?: string | undefined; value: string }[];
}

/** Trục đã có thuộc tính thật: giá trị theo `lower(value)` gửi lên → giá trị trong DB. */
export interface ResolvedAxis {
  attributeId: string;
  name: string;
  values: Map<string, ComboValue & { value: string }>;
}

type AttributeRow = Awaited<ReturnType<typeof findAttributes>>[number];

const key = (value: string) => value.trim().toLowerCase();

async function attributeOf(id: string): Promise<AttributeRow | undefined> {
  return isUuid(id) ? (await findAttributes(id))[0] : undefined;
}

/**
 * Bước đọc (không ghi): thuộc tính theo id hoặc tên (đọc qua RLS, khoá ngoại bỏ qua RLS), giá trị gửi kèm `id` phải
 * thuộc đúng thuộc tính đó, hai trục khác thuộc tính. Trả lỗi theo ô hoặc thuộc tính có sẵn của từng trục (`null` là
 * tên mới, sẽ tạo).
 */
export async function checkAxes(axes: readonly AxisInput[]): Promise<{ errors: Record<string, string>; found: (AttributeRow | null)[] }> {
  const errors: Record<string, string> = {};
  const found: (AttributeRow | null)[] = [];
  for (const [i, axis] of axes.entries()) {
    let attr: AttributeRow | undefined;
    if (axis.attributeId !== undefined) {
      attr = await attributeOf(axis.attributeId);
      if (!attr) errors[`axes.${i}.name`] = 'Không tìm thấy thuộc tính';
    } else {
      const id = await findAttributeIdByName(axis.name!);
      attr = id ? await attributeOf(id) : undefined;
    }
    found.push(attr ?? null);
    for (const [j, v] of axis.values.entries()) {
      if (v.id !== undefined && !attr?.values.some((x) => x.id === v.id)) {
        errors[`axes.${i}.values.${j}.value`] = 'Giá trị không thuộc thuộc tính này';
      }
    }
  }
  const ids = found.flatMap((a) => (a ? [a.id] : []));
  if (new Set(ids).size !== ids.length) errors.axes = 'Hai trục phải là hai thuộc tính khác nhau';
  return { errors, found };
}

/**
 * Bước ghi, sau `checkAxes` không lỗi và trong cùng giao dịch: tạo thuộc tính tên mới, giá trị mới (giá trị trùng
 * `lower(value)` với giá trị có sẵn thì dùng lại), mã giá trị không trùng mã đang có (`uniqueValueCode`, B1).
 */
export async function createAxes(companyId: string, axes: readonly AxisInput[], found: readonly (AttributeRow | null)[]): Promise<ResolvedAxis[]> {
  const result: ResolvedAxis[] = [];
  for (const [i, axis] of axes.entries()) {
    const attr = found[i] ?? (await attributeOf(await ensureAttribute(companyId, axis.name!)))!;
    const existing = new Map(attr.values.map((v) => [key(v.value), v]));
    const codes = new Set(attr.values.map((v) => v.code));
    const fresh: { value: string; code: string }[] = [];
    for (const v of axis.values) {
      if (v.id !== undefined || existing.has(key(v.value))) continue;
      const code = uniqueValueCode(v.value, codes);
      codes.add(code);
      fresh.push({ value: v.value.trim(), code });
    }
    for (const row of await insertValues(companyId, attr.id, fresh)) existing.set(key(row.value), { ...row, inUse: false });
    const byId = new Map(attr.values.map((v) => [v.id, v]));
    const values = new Map(
      axis.values.map((v) => {
        const row = v.id !== undefined ? byId.get(v.id)! : existing.get(key(v.value))!;
        return [key(v.value), { id: row.id, code: row.code, value: row.value, attributeId: attr.id }] as const;
      }),
    );
    result.push({ attributeId: attr.id, name: attr.name, values });
  }
  return result;
}
