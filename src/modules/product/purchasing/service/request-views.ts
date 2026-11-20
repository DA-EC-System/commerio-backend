// Dựng đề nghị nhập trả FE (Documents/21 mục 16.2, FE `src/types/purchasing.ts`): tên người, nhãn biến thể, ẩn giá.
import { Decimal } from 'decimal.js';
import { findAccountById, getStatusHistory } from '../../../core/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { groupNames, getVariants, parentProducts, type VariantSummary } from '../../catalog/index.ts';
import { canSeeCost, outstanding, toDong } from '../domain/request.ts';
import { findLines, type LineRow, receiptsOf, type RequestRow } from '../repository/requests.ts';
import { findReturn } from '../repository/returns.ts';
import { findSupplier } from '../repository/suppliers.ts';

/** Người gọi đã qua `ctx.authorize`: công ty, tài khoản và quyền lấy nguyên từ `getAccess(res)`. */
export interface Actor {
  readonly companyId: string;
  readonly accountId: string;
  readonly permissions: readonly string[];
  readonly enabledModules: readonly string[];
}

export const notFound = (what: string) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);

/** 422 theo ô cho luật kiểm cần đọc DB, cùng dạng với `validate()`. */
export const invalid = (errors: Record<string, string>, code = 'validation_failed') =>
  new AppError(422, code, 'Dữ liệu gửi lên không hợp lệ', { errors });

/** Tên đầy đủ của các tài khoản (một truy vấn mỗi người, thường 1–3); không có người thì vắng. */
export async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set(ids)) {
    if (!id) continue;
    const account = await findAccountById(id); // chung kết nối của giao dịch: tuần tự
    if (account) names.set(id, account.fullName);
  }
  return names;
}

export const attributesLabel = (v: VariantSummary) => v.attributes.map((a) => a.value).join(' / ');

type ReceiptRef = Awaited<ReturnType<typeof receiptsOf>>[number];

interface Lookups {
  showCost: boolean;
  lines: Map<string, LineRow[]>;
  receipts: Map<string, ReceiptRef[]>;
  names: Map<string, string>;
}

async function lookupsOf(rows: readonly RequestRow[], actor: Actor): Promise<Lookups> {
  const ids = rows.map((r) => r.id);
  const lines = ids.length ? await findLines(ids) : [];
  const receipts = ids.length ? await receiptsOf(ids) : [];
  return {
    showCost: canSeeCost(actor),
    lines: Map.groupBy(lines, (l) => l.requestId),
    receipts: Map.groupBy(receipts, (r) => r.requestId),
    names: await namesOf(rows.map((r) => r.createdBy)),
  };
}

function summaryOf(row: RequestRow, supplier: { id: string; name: string }, look: Lookups) {
  const lines = look.lines.get(row.id) ?? [];
  const active = lines.filter((l) => !l.excluded);
  const cost = active.reduce((s, l) => s.plus(new Decimal(l.unitPrice).times(l.orderedQty)), new Decimal(0));
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    supplier,
    note: row.note ?? '',
    lineCount: active.length,
    totalQty: active.reduce((s, l) => s + l.orderedQty, 0),
    totalCost: look.showCost ? toDong(cost) : null,
    outstanding: lines.reduce((s, l) => s + outstanding(l), 0),
    supplierShort: (look.receipts.get(row.id) ?? []).some((r) => r.status === 'short'),
    createdBy: row.createdBy ? (look.names.get(row.createdBy) ?? '') : '',
    createdById: row.createdBy ?? '',
    createdAt: row.createdAt.toISOString(),
    expectedDeliveryDate: row.expectedDeliveryDate ?? null,
    supplierOrderCode: row.supplierOrderCode ?? null,
    version: row.version,
  };
}

/** Phiếu trả NCC mà đề nghị bù hàng (B4, #210). */
async function sourceReturnRef(id: string) {
  const ret = await findReturn(id);
  return ret ? { type: 'supplier_return' as const, id: ret.id, number: ret.number } : null;
}

/** Bản tóm tắt cho danh sách; `rows` đã kèm tên NCC. */
export async function toSummaries(rows: readonly (RequestRow & { supplierName: string | null })[], actor: Actor) {
  const look = await lookupsOf(rows, actor);
  return rows.map((r) => summaryOf(r, { id: r.supplierId ?? '', name: r.supplierName ?? '' }, look));
}

/**
 * `newProduct` của dòng sản phẩm mới (Documents/21 mục 16.3): `name`, `groupId`, `groupName` là của cha (cha có sẵn đọc
 * theo sản phẩm); sau duyệt `parentId` là cha của SKU đã sinh. Dòng không phải sản phẩm mới: `null`.
 */
function newProductView(
  l: LineRow,
  v: VariantSummary | undefined,
  groups: Map<string, string>,
  parents: Map<string, { name: string; groupId: string; groupName: string }>,
) {
  if (!l.newParentProductId && !l.newParentName) return null;
  const parent = l.newParentProductId ? parents.get(l.newParentProductId) : undefined;
  return {
    parentId: l.newParentProductId ?? v?.productId ?? null,
    parentName: l.newParentName,
    groupId: parent?.groupId ?? l.newGroupId ?? '',
    optionValues: Object.fromEntries((l.newOptionValues ?? []).map((o) => [o.axis, o.value])),
    name: parent?.name ?? l.newParentName ?? '',
    groupName: parent?.groupName ?? groups.get(l.newGroupId ?? '') ?? '',
  };
}

/** Bản chi tiết (R7): dòng, phiếu nhận, lịch sử trạng thái. */
export async function toDetail(row: RequestRow, actor: Actor) {
  const look = await lookupsOf([row], actor);
  const supplier = row.supplierId ? await findSupplier(row.supplierId) : undefined;
  const lines = look.lines.get(row.id) ?? [];
  const variants = new Map(
    (await getVariants(lines.flatMap((l) => (l.variantId ? [l.variantId] : [])))).map((v) => [v.id, v]),
  );
  const groups = await groupNames(lines.flatMap((l) => (l.newGroupId ? [l.newGroupId] : [])));
  const parents = await parentProducts(lines.flatMap((l) => (l.newParentProductId ? [l.newParentProductId] : [])));
  const receipts = look.receipts.get(row.id) ?? [];
  const history = await getStatusHistory('purchase_requests', row.id);
  return {
    ...summaryOf(row, { id: supplier?.id ?? '', name: supplier?.name ?? '' }, look),
    lines: lines.map((l) => {
      const v = l.variantId ? variants.get(l.variantId) : undefined;
      const np = newProductView(l, v, groups, parents);
      return {
        id: l.id,
        variantId: l.variantId,
        sku: v?.sku ?? null,
        productName: v?.productName ?? np?.name ?? '',
        attributesLabel: v ? attributesLabel(v) : (l.newOptionValues ?? []).map((o) => o.value).join(' / '),
        newProduct: np,
        quantity: l.orderedQty,
        unitCost: look.showCost ? toDong(l.unitPrice) : null,
        excluded: l.excluded,
        excludedReason: l.excludedReason ?? null,
        received: l.receivedQty,
        defective: l.defectiveQty,
        closedShort: l.closedShortQty,
        outstanding: outstanding(l),
      };
    }),
    receipts: receipts.map((r) => ({ type: 'goods_receipt' as const, id: r.id, number: r.number, status: r.status })),
    sourceReturn: row.sourceReturnId ? await sourceReturnRef(row.sourceReturnId) : null,
    countingReceipts: receipts.filter((r) => r.status === 'counting').length,
    statusHistory: history.map((h) => ({ ...h, at: h.at.toISOString() })),
  };
}

export type PurchaseRequestView = Awaited<ReturnType<typeof toDetail>>;
