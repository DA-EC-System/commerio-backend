// Dựng dữ liệu trả về FE (Documents/21 7.1): tên người, nhãn biến thể, ẩn giá theo quyền (K3, plan #16 A1, A12, A14).
import { AppError } from '../../../../shared/errors/app-error.ts';
import { getVariants, type VariantSummary } from '../../catalog/index.ts';
import { findAccountById } from '../../../core/index.ts';
import { isBelowMin, stockValue, toDong } from '../domain/stock.ts';
import { type DocListRow, type DocRow, docLines } from '../repository/documents.ts';
import type { LevelRow, RuleRow } from '../repository/levels.ts';

/** Người gọi đã qua `ctx.authorize`, kèm hai quyền đổi dữ liệu trả về (đọc từ DB mỗi request, D1). */
export interface Viewer {
  readonly companyId: string;
  readonly accountId: string;
  /** `inventory.cost.view`: thấy giá vốn, giá trị tồn. */
  readonly canCost: boolean;
  /** `inventory.receipt.create`: thấy giá nhập trên phiếu nhập tay. */
  readonly canCreate: boolean;
}

export const notFound = (what: string) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);
export const invalid = (errors: Record<string, string>) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });

/** Tên đầy đủ của các tài khoản (một truy vấn mỗi người khác nhau, thường 1–3); không có người thì `null`. */
export async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const accounts = [];
  for (const id of unique) accounts.push(await findAccountById(id)); // chung kết nối của giao dịch
  return new Map(accounts.flatMap((a) => (a ? [[a.id, a.fullName] as const] : [])));
}

export async function variantsById(ids: readonly string[]): Promise<Map<string, VariantSummary>> {
  return new Map((await getVariants([...new Set(ids)])).map((v) => [v.id, v]));
}

const attributesLabel = (v: VariantSummary) => v.attributes.map((a) => a.value).join(' / ');

export function toStockLevel(v: VariantSummary, level: LevelRow | undefined, rule: RuleRow | undefined, viewer: Viewer) {
  const onHand = level?.onHand ?? 0;
  const reserved = level?.reserved ?? 0;
  const available = onHand - reserved;
  const avgCost = level?.avgCost ?? '0';
  const minQty = rule?.minQty ?? null;
  return {
    variantId: v.id,
    productId: v.productId,
    productName: v.productName,
    sku: v.sku,
    attributesLabel: attributesLabel(v),
    category: { id: v.categoryId, name: v.categoryName },
    onHand,
    reserved,
    available,
    minQty,
    belowMin: isBelowMin(available, minQty),
    reorderVersion: rule?.version ?? 0,
    avgCost: viewer.canCost ? toDong(avgCost) : null,
    stockValue: viewer.canCost ? stockValue(onHand, avgCost) : null,
  };
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/** Dòng danh sách phiếu. */
export function toDocSummary(doc: DocListRow, names: Map<string, string>) {
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    id: doc.id,
    number: doc.number,
    type: doc.type,
    kind: doc.kind,
    status: doc.status,
    note: doc.note ?? '',
    reference: doc.reference,
    lineCount: doc.lineCount,
    totalQty: doc.totalQty,
    createdBy: name(doc.createdBy),
    createdAt: iso(doc.createdAt)!,
    postedBy: name(doc.postedBy),
    postedAt: iso(doc.postedAt),
    version: doc.version,
  };
}

/** Phiếu kèm dòng; giá trên dòng: có `cost.view` thấy mọi phiếu, chỉ có `receipt.create` thấy phiếu nhập tay (A14). */
export async function toStockDoc(doc: DocRow, viewer: Viewer) {
  const lines = await docLines(doc.type, doc.id);
  const variants = await variantsById(lines.map((l) => l.variantId));
  const names = await namesOf([doc.createdBy, doc.postedBy]);
  const showCost = viewer.canCost || (doc.type === 'receipt' && doc.kind === 'manual' && viewer.canCreate);
  return {
    ...toDocSummary({ ...doc, lineCount: lines.length, totalQty: lines.reduce((s, l) => s + l.quantity, 0) }, names),
    lines: lines.map((l) => {
      const v = variants.get(l.variantId);
      return {
        variantId: l.variantId,
        sku: v?.sku ?? '',
        productName: v?.productName ?? '',
        attributesLabel: v ? attributesLabel(v) : '',
        quantity: l.quantity,
        unitCost: showCost && l.unitCost !== null ? toDong(l.unitCost) : null,
      };
    }),
  };
}
