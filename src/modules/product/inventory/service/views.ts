// Dựng dữ liệu trả về FE (Documents/21 mục 15.1): tên người, nhãn biến thể, ẩn giá theo quyền (K3).
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import type { VariantSummary } from '../../catalog/index.ts';
import { findAccountById } from '../../../core/index.ts';
import { availableQty, isBelowMin, stockValue, toDong } from '../domain/stock.ts';
import type { LevelRow } from '../repository/levels.ts';

/** Người gọi đã qua `ctx.authorize`, kèm quyền đổi dữ liệu trả về (đọc từ DB mỗi request, D1). */
export interface Viewer {
  readonly companyId: string;
  readonly accountId: string;
  /** `inventory.cost.view`: thấy giá vốn, giá trị tồn. */
  readonly canCost: boolean;
}

export const notFound = (what: string) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);

/** Tên đầy đủ của các tài khoản (một truy vấn mỗi người khác nhau, thường 1–3); không có người thì vắng. */
export async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const accounts = [];
  for (const id of unique) accounts.push(await findAccountById(id)); // chung kết nối của giao dịch
  return new Map(accounts.flatMap((a) => (a ? [[a.id, a.fullName] as const] : [])));
}

const attributesLabel = (v: VariantSummary) => v.attributes.map((a) => a.value).join(' / ');

/** Đang về theo biến thể, do purchasing tính (#108); inventory nhận qua `ctx` vì purchasing đã import inventory. */
export type IncomingLookup = (variantIds?: readonly string[]) => Promise<Map<string, number>>;

/** `ctx` của router inventory: `product/index.ts` tiêm `incomingOf` của purchasing. */
export interface InventoryContext extends ModuleContext {
  readonly incomingOf?: IncomingLookup;
}

/** Hàm đã tiêm; chưa tiêm là lỗi lắp ráp, báo 500 rõ ràng thay vì trả đang về 0. */
export function incomingLookupOf(ctx: InventoryContext): IncomingLookup {
  if (!ctx.incomingOf) throw new AppError(500, 'internal_error', 'Chưa nối số đang về của purchasing (src/modules/product/index.ts)');
  return ctx.incomingOf;
}

/**
 * Các con số của một SKU. `incoming` là đang về của đề nghị nhập (#108). Tạm khoá, đang thiếu tính từ phiếu chờ duyệt,
 * kiện thiếu hàng: các nguồn đó có ở issue vòng đời (Documents/21 mục 15–19), tới lúc đó bằng 0.
 */
export function toStockLevel(v: VariantSummary, level: LevelRow | undefined, viewer: Viewer, incoming: number) {
  const onHand = level?.onHand ?? 0;
  const reserved = level?.reserved ?? 0;
  const locked = 0;
  const available = availableQty(onHand, reserved, locked);
  const avgCost = level?.avgCost ?? '0';
  const minQty = level?.minQty ?? null;
  return {
    variantId: v.id,
    productId: v.productId,
    productName: v.productName,
    sku: v.sku,
    attributesLabel: attributesLabel(v),
    category: { id: v.categoryId, name: v.categoryName },
    onHand,
    reserved,
    locked,
    available,
    quarantine: level?.quarantine ?? 0,
    incoming,
    shortage: 0,
    negative: level?.invariantBroken ?? false,
    minQty,
    belowMin: isBelowMin(available, minQty),
    reorderVersion: level?.version ?? 0,
    avgCost: viewer.canCost ? toDong(avgCost) : null,
    stockValue: viewer.canCost ? stockValue(onHand, avgCost) : null,
  };
}
