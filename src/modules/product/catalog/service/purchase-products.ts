// Sản phẩm mới từ đề nghị nhập (#108, #243; Documents/21 mục 16.3, 25 §3.2, §4.2, §5.4): purchasing kiểm khi lập, gửi
// duyệt, duyệt; tạo khi ghi sổ phiếu nhập kho có hàng về (đổi 22/11/2026). Mỗi dòng là một SKU thuộc sản phẩm cha có sẵn (`parentId`) hoặc cha mới (`parentName`); các dòng cùng tên cha
// mới gộp một cha. Chạy trong `withCompany` của bên gọi, không tự mở giao dịch (withCompany không lồng được).
import { recordAudit } from '../../../core/index.ts';
import { findGroups } from '../repository/groups.ts';
import { findProduct, findProductByName, insertProduct, productNameExists, touchProduct } from '../repository/products.ts';
import { findVariants, insertVariant, lockVariants } from '../repository/variants.ts';
import { type AxisInput, checkAxes, createAxes } from './axes.ts';
import { isUuid } from './errors.ts';
import { allocateSkus, productCodeFor, SKU_TOO_LONG } from './sku-allocation.ts';

/** Sản phẩm cha tối đa 2 trục; mỗi trục tối đa 50 giá trị trong một sản phẩm (Lazada, Documents/21 mục 5.2). */
const MAX_AXES = 2;
const MAX_AXIS_VALUES = 50;

export interface NewProductOption {
  axis: string;
  value: string;
}

export interface NewProductItem {
  /** Chỉ số dòng trong đề nghị (từ 0), cho câu "Trùng phân loại với dòng N". */
  line: number;
  parentId: string | null;
  parentName: string | null;
  groupId: string | null;
  /** Theo thứ tự trục người lập gửi. */
  options: readonly NewProductOption[];
}

type Field = 'parentId' | 'parentName' | 'groupId' | 'optionValues';

/**
 * Lỗi theo chỉ số mục (`field = null` là lỗi của cả dòng, vd SKU quá dài). `code` là `too_many_axes` khi có cha mới
 * gộp quá 2 trục (Documents/21 mục 16.4), còn lại `validation_failed`. Rỗng là hợp lệ.
 */
export interface NewProductErrors {
  /** `productId`: sản phẩm đang giữ tên, khi lỗi là tên cha mới vừa bị dùng lúc ghi sổ (`new_product_name_taken`). */
  errors: Map<number, { field: Field | null; message: string; productId?: string }>;
  code: 'validation_failed' | 'too_many_axes' | 'new_product_name_taken';
}

/** Tên cha, tên trục, giá trị: bỏ khoảng trắng hai đầu, gộp khoảng trắng giữa. */
export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ');
const key = (s: string) => normalizeName(s).toLowerCase();
/** Bỏ trùng theo chữ thường, giữ chữ của lần xuất hiện đầu. */
const firstOf = (list: string[]) => [...Map.groupBy(list, key).values()].map((same) => same[0]!);

interface PlannedLine {
  index: number;
  /** Giá trị theo thứ tự trục của cha. */
  values: string[];
}

type ParentPlan =
  | { kind: 'new'; name: string; groupId: string; groupName: string; axes: string[]; lines: PlannedLine[] }
  | { kind: 'existing'; productId: string; productName: string; axes: { attributeId: string; name: string }[]; lines: PlannedLine[] };

/**
 * Đọc (qua RLS) và kiểm mọi dòng; chỉ trả kế hoạch tạo khi không lỗi. `onReceipt` (ghi sổ phiếu nhập kho, đề nghị đã
 * đặt nên không trả về được, Documents/21 mục 16.3): tổ hợp đã là SKU của cha có sẵn thì dùng SKU đó (`reused`), tên cha
 * mới vừa bị dùng thì mã `new_product_name_taken`.
 */
async function plan(
  items: readonly NewProductItem[],
  onReceipt = false,
): Promise<NewProductErrors & { parents: ParentPlan[]; reused: Map<number, string> }> {
  const errors: NewProductErrors['errors'] = new Map();
  const reused = new Map<number, string>();
  let tooManyAxes = false;
  let nameTaken = false;
  const fail = (i: number, field: Field | null, message: string) => {
    if (!errors.has(i)) errors.set(i, { field, message });
  };
  items.forEach((item, i) => {
    const axes = item.options.map((o) => key(o.axis));
    if (new Set(axes).size !== axes.length) fail(i, 'optionValues', 'Trục phân loại bị lặp');
  });
  const members = items.flatMap((item, i) => (errors.has(i) ? [] : [{ item, i }]));
  const byParent = Map.groupBy(members, ({ item }) => (item.parentId ? `id:${item.parentId}` : `new:${key(item.parentName!)}`));
  const groups = new Map((await findGroups()).map((g) => [g.id, g.name]));
  const parents: ParentPlan[] = [];

  // Trùng tổ hợp giữa các dòng, trần 50 giá trị mỗi trục; `taken` là tổ hợp đã là SKU của cha có sẵn.
  const checkCombos = (rows: typeof members, values: (string[] | null)[], taken = new Map<string, { message: string; variantId: string }>()) => {
    const seen = new Map<string, number>();
    const lines: PlannedLine[] = [];
    rows.forEach(({ i }, k) => {
      const v = values[k];
      if (!v) return;
      const combo = v.map(key).join('|');
      const existing = taken.get(combo);
      if (existing && onReceipt) return void reused.set(i, existing.variantId);
      if (existing) return fail(i, 'optionValues', existing.message);
      if (seen.has(combo)) return fail(i, 'optionValues', `Trùng phân loại với dòng ${items[seen.get(combo)!]!.line + 1}`);
      seen.set(combo, i);
      lines.push({ index: i, values: v });
    });
    return lines;
  };

  for (const [parentKey, rows] of byParent) {
    if (parentKey.startsWith('new:')) {
      const first = rows[0]!.item;
      const name = normalizeName(first.parentName!);
      // So với nhóm hợp lệ đầu tiên: dòng đầu sai nhóm thì chỉ dòng đó báo, dòng sau không bị kéo theo.
      const groupId = rows.map(({ item }) => item.groupId).find((g) => g && groups.has(g));
      for (const { item, i } of rows) {
        if (!item.groupId || !groups.has(item.groupId)) fail(i, 'groupId', 'Chọn nhóm hàng');
        else if (item.groupId !== groupId) fail(i, 'groupId', 'Các dòng cùng sản phẩm cha phải cùng nhóm hàng');
      }
      if (onReceipt) {
        // Người nhập kho thường không có quyền sửa sản phẩm: câu nói rõ sản phẩm nào giữ tên và ai đổi được (KB2 2.3).
        const holder = await findProductByName(name);
        if (holder) {
          nameTaken = true;
          const message = `Tên «${name}» đã là tên của sản phẩm ${holder.code ?? 'khác'}. Người có quyền sửa sản phẩm đổi tên sản phẩm đó, rồi nhập kho lại`;
          rows.forEach(({ i }) => errors.has(i) || errors.set(i, { field: 'parentName', message, productId: holder.id }));
        }
      } else if (await productNameExists(name)) {
        rows.forEach(({ i }) => fail(i, 'parentName', 'Đã có sản phẩm cùng tên'));
      }
      // Trục của cha mới: theo thứ tự xuất hiện, dòng đầu tiên trước (M1).
      const axes = firstOf(rows.flatMap(({ item }) => item.options.map((o) => normalizeName(o.axis))));
      if (axes.length > MAX_AXES) {
        // Mã `too_many_axes` chỉ khi có dòng thật sự báo lỗi trục (dòng đã có lỗi khác giữ lỗi đó).
        for (const { i } of rows) {
          if (errors.has(i)) continue;
          tooManyAxes = true;
          fail(i, 'optionValues', `Các dòng cùng sản phẩm cha có ${axes.length} trục phân loại; tối đa ${MAX_AXES}`);
        }
        continue;
      }
      const values = rows.map(({ item, i }) => {
        const v = axes.map((a) => item.options.find((o) => key(o.axis) === key(a))?.value);
        const missing = axes.filter((_, j) => v[j] === undefined);
        if (missing.length) {
          fail(i, 'optionValues', `Thiếu giá trị cho trục ${missing.join(', ')}`);
          return null;
        }
        return v.map((x) => normalizeName(x!));
      });
      const lines = checkCombos(rows, values);
      overflow(axes, lines, [], rows, fail);
      if (rows.every(({ i }) => !errors.has(i))) {
        parents.push({ kind: 'new', name, groupId: groupId!, groupName: groups.get(groupId!)!, axes, lines });
      }
      continue;
    }

    const parentId = rows[0]!.item.parentId!;
    // Khoá ngoại bỏ qua RLS: đọc cha qua RLS, cha của công ty khác như không tồn tại.
    const product = isUuid(parentId) ? await findProduct(parentId) : undefined;
    const variants = product ? await findVariants({ productId: parentId }) : [];
    if (!product || !variants.length) {
      rows.forEach(({ i }) => fail(i, 'parentId', 'Không tìm thấy sản phẩm cha'));
      continue;
    }
    // Lúc ghi sổ, hàng đã về: SKU mới vẫn vào cha dù mọi SKU cũ đã lưu trữ (cha suy trạng thái từ SKU, sẽ hết "lưu trữ").
    if (!onReceipt && variants.every((v) => v.businessStatus === 'archived')) {
      rows.forEach(({ i }) => fail(i, 'parentId', 'Sản phẩm cha đã lưu trữ'));
      continue;
    }
    // Thứ tự trục theo biến thể đầu tiên, như `addVariant` (S5).
    const axes = variants[0]!.attributes.map((a) => ({ attributeId: a.attributeId, name: a.attributeName }));
    const values = rows.map(({ item, i }) => {
      const sent = item.options.map((o) => key(o.axis));
      if (!axes.length && sent.length) {
        fail(i, 'optionValues', 'Sản phẩm cha không có phân loại, chọn SKU có sẵn');
        return null;
      }
      if (sent.length !== axes.length || axes.some((a) => !sent.includes(key(a.name)))) {
        fail(i, 'optionValues', `Sản phẩm cha có trục: ${axes.map((a) => a.name).join(', ')}`);
        return null;
      }
      return axes.map((a) => normalizeName(item.options.find((o) => key(o.axis) === key(a.name))!.value));
    });
    const taken = new Map(
      variants.map((v) => [
        v.attributes.map((a) => key(a.value)).join('|'),
        {
          variantId: v.id,
          message: v.businessStatus === 'archived' ? `Đã có SKU ${v.sku} (đã lưu trữ), khôi phục ở trang sản phẩm` : `Đã có SKU ${v.sku}, chọn SKU có sẵn`,
        },
      ]),
    );
    const lines = checkCombos(rows, values, taken);
    overflow(axes.map((a) => a.name), lines, variants.map((v) => v.attributes.map((a) => a.value)), rows, fail);
    if (rows.every(({ i }) => !errors.has(i)) && lines.length) {
      parents.push({ kind: 'existing', productId: parentId, productName: product.name, axes, lines });
    }
  }
  const code = nameTaken ? 'new_product_name_taken' : tooManyAxes ? 'too_many_axes' : 'validation_failed';
  return { errors, code, parents, reused };
}

/** Trục nào của cha có quá 50 giá trị (giá trị của SKU có sẵn cộng dòng mới) thì lỗi ở mọi dòng của cha. */
function overflow(
  axes: string[],
  lines: PlannedLine[],
  existing: string[][],
  rows: { i: number }[],
  fail: (i: number, field: Field, message: string) => void,
) {
  axes.forEach((axis, j) => {
    const count = new Set([...existing, ...lines.map((l) => l.values)].map((v) => key(v[j]!))).size;
    if (count > MAX_AXIS_VALUES) rows.forEach(({ i }) => fail(i, 'optionValues', `Trục ${axis} quá ${MAX_AXIS_VALUES} giá trị trong một sản phẩm`));
  });
}

/** Kiểm lúc lập, sửa, gửi duyệt và duyệt đề nghị (không tạo gì). */
export async function validateNewProducts(items: readonly NewProductItem[]): Promise<NewProductErrors> {
  const { errors, code } = await plan(items);
  return { errors, code };
}

/**
 * Tạo khi ghi sổ phiếu nhập kho (Documents/21 mục 16.3 "Dòng sản phẩm mới khi ghi sổ phiếu nhận"). Khoá công ty của
 * catalog rồi kiểm lại (cha có sẵn có thể đã thêm SKU, đổi trục; tên cha mới có thể vừa bị dùng). Tổ hợp đã là SKU của
 * cha có sẵn thì dùng SKU đó (`reused`: chỉ số mục, bên gọi ghi nhật ký). Mỗi cha: thuộc tính, giá trị chưa có thì tạo;
 * cấp SKU một lần cho mọi dòng của cha; cha mới sinh mã cha riêng. Mỗi SKU ghi `source_request_line_id` là dòng sinh ra
 * nó. Trả `variantIds`, `productIds` (cha của SKU) theo chỉ số mục; lỗi thì không trả gì, bên gọi ném lỗi để rollback
 * cả phần đã ghi.
 */
export async function createPurchaseProducts(
  caller: { companyId: string; accountId: string },
  items: readonly (NewProductItem & { lineId: string })[],
  /** Số phiếu nhập kho sinh ra sản phẩm; chỉ ghi vào nhật ký (`after.fromReceipt`), không vào mô tả (KB2 2.5: mô tả lên sàn). */
  receiptNumber: string,
): Promise<{ ok: true; variantIds: string[]; productIds: string[]; reused: number[] } | ({ ok: false } & NewProductErrors)> {
  await lockVariants(caller.companyId);
  const planned = await plan(items, true);
  if (planned.errors.size) return { ok: false, errors: planned.errors, code: planned.code };
  const variantIds: string[] = [];
  const productIds: string[] = [];
  for (const [i, variantId] of planned.reused) {
    variantIds[i] = variantId;
    productIds[i] = items[i]!.parentId!;
  }
  for (const parent of planned.parents) {
    const axisInputs: AxisInput[] = parent.axes.map((axis, j) => {
      const values = firstOf(parent.lines.map((l) => l.values[j]!)).map((value) => ({ value }));
      return typeof axis === 'string' ? { name: axis, values } : { attributeId: axis.attributeId, values };
    });
    const checked = await checkAxes(axisInputs);
    const axisError = Object.values(checked.errors)[0];
    if (axisError) {
      return { ok: false, code: 'validation_failed', errors: new Map(parent.lines.map((l) => [l.index, { field: 'optionValues', message: axisError }])) };
    }
    const resolved = await createAxes(caller.companyId, axisInputs, checked.found);
    const combos = parent.lines.map((l) => l.values.map((v, j) => resolved[j]!.values.get(v.trim().toLowerCase())!));
    const allocation = await allocateSkus(caller.companyId, combos);
    if (!allocation.ok) {
      return { ok: false, code: 'validation_failed', errors: new Map([[parent.lines[allocation.index]!.index, { field: null, message: SKU_TOO_LONG }]]) };
    }
    const skus = allocation.skus.map((s) => s.sku);
    let productId: string;
    if (parent.kind === 'new') {
      const code = await productCodeFor(allocation.pattern, allocation.skus[0]!.seq);
      productId = await insertProduct(caller.companyId, parent.groupId, parent.name, '', code);
      await recordAudit({
        companyId: caller.companyId,
        actorId: caller.accountId,
        action: 'create',
        entityType: 'product.products',
        entityId: productId,
        label: parent.name,
        before: null,
        after: { name: parent.name, code, group: parent.groupName, description: '', imageFileIds: [], variants: skus, fromReceipt: receiptNumber },
      });
    } else {
      productId = parent.productId;
      await touchProduct(productId);
    }
    for (const [k, line] of parent.lines.entries()) {
      const id = await insertVariant(caller.companyId, productId, skus[k]!, combos[k]!.map((v) => v.id), k, items[line.index]!.lineId);
      variantIds[line.index] = id;
      productIds[line.index] = productId;
      if (parent.kind === 'existing') {
        await recordAudit({
          companyId: caller.companyId,
          actorId: caller.accountId,
          action: 'create',
          entityType: 'product.product_variants',
          entityId: id,
          label: `${parent.productName} · ${skus[k]}`,
          before: null,
          after: { product: parent.productName, sku: skus[k], attributes: line.values },
        });
      }
    }
  }
  return { ok: true, variantIds, productIds, reused: [...planned.reused.keys()] };
}

/** Tên nhóm hàng theo id (chỉ của công ty mình). */
export async function groupNames(ids: readonly string[]): Promise<Map<string, string>> {
  const all = new Map((await findGroups()).map((g) => [g.id, g.name]));
  return new Map(ids.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
}

/** Tên, nhóm hàng của sản phẩm cha theo id (qua RLS; không thấy thì vắng), cho bản xem dòng đề nghị. */
export async function parentProducts(ids: readonly string[]): Promise<Map<string, { name: string; groupId: string; groupName: string }>> {
  const result = new Map<string, { name: string; groupId: string; groupName: string }>();
  for (const id of new Set(ids)) {
    const p = isUuid(id) ? await findProduct(id) : undefined;
    if (p) result.set(id, { name: p.name, groupId: p.groupId, groupName: p.groupName });
  }
  return result;
}
