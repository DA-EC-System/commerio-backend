// Tồn và ngưỡng tồn (Documents/21 mục 15.1, 15.2; D10; plan #16 A2–A4, A15, A17).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../../core/index.ts';
import type { VariantSummary } from '../../catalog/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { toDong } from '../domain/stock.ts';
import { allLevels, findLevel, latestMoves, lockLevel, setMinQty } from '../repository/levels.ts';
import { type IncomingLookup, namesOf, notFound, toStockLevel, type Viewer } from './views.ts';

const MOVES_LIMIT = 100;

/**
 * Danh sách tồn: lọc và phân trang trong bộ nhớ sau `getVariants()` (D10). Gồm biến thể chưa lưu trữ và biến thể đã
 * lưu trữ còn hàng (A2); `summary` tính trên toàn bộ danh sách đó, `totalValue` là tổng các `stockValue` đã làm tròn (A4).
 */
export async function listStock(
  incomingOf: IncomingLookup,
  viewer: Viewer,
  q: {
    page: number;
    pageSize: number;
    search?: string | undefined;
    categoryId?: string | undefined;
    belowMin?: boolean | undefined;
    quarantine?: boolean | undefined;
  },
) {
  return withCompany(viewer.companyId, async () => {
    // Cùng một kết nối của giao dịch: đọc tuần tự (Promise.all không nhanh hơn, node-pg cảnh báo).
    const variants = await getVariants();
    const levels = await allLevels();
    const incoming = await incomingOf();
    const all = variants
      .filter((v) => !v.archived || (levels.get(v.id)?.onHand ?? 0) !== 0 || (levels.get(v.id)?.quarantine ?? 0) !== 0)
      .map((v) => toStockLevel(v, levels.get(v.id), viewer, incoming.get(v.id) ?? 0))
      .sort((a, b) => a.productName.localeCompare(b.productName, 'vi') || a.sku.localeCompare(b.sku, 'vi'));
    const search = q.search?.toLowerCase();
    const items = all.filter(
      (l) =>
        (!search || l.productName.toLowerCase().includes(search) || l.sku.toLowerCase().includes(search)) &&
        (!q.categoryId || l.category.id === q.categoryId) &&
        (!q.belowMin || l.belowMin) &&
        (!q.quarantine || l.quarantine > 0),
    );
    const start = (q.page - 1) * q.pageSize;
    return {
      items: items.slice(start, start + q.pageSize),
      total: items.length,
      page: q.page,
      pageSize: q.pageSize,
      summary: {
        variantCount: all.length,
        belowMinCount: all.filter((l) => l.belowMin).length,
        quarantineCount: all.filter((l) => l.quarantine > 0).length,
        negativeCount: all.filter((l) => l.negative).length,
        totalValue: viewer.canCost ? all.reduce((s, l) => s + l.stockValue!, 0) : null,
      },
    };
  });
}

/** Biến thể của công ty (kể cả đã lưu trữ); công ty khác hay id sai → 404 (C4, V6; `getVariants` bỏ id không phải uuid). */
async function ownVariant(variantId: string): Promise<VariantSummary> {
  const [variant] = await getVariants([variantId]);
  if (!variant) throw notFound('biến thể');
  return variant;
}

/** Tồn một biến thể và 100 dòng thẻ kho mới nhất. */
export async function getStock(incomingOf: IncomingLookup, viewer: Viewer, variantId: string) {
  return withCompany(viewer.companyId, async () => {
    const variant = await ownVariant(variantId);
    const incoming = (await incomingOf([variant.id])).get(variant.id) ?? 0;
    const level = toStockLevel(variant, (await findLevel(variant.id)) ?? undefined, viewer, incoming);
    const moves = await latestMoves(variant.id, MOVES_LIMIT);
    const names = await namesOf(moves.map((m) => m.doneBy));
    return {
      level,
      moves: moves.map((m) => ({
        id: String(m.id),
        area: m.bucket,
        qtyChange: m.qtyChange,
        balanceAfter: m.balanceAfter,
        document: { id: m.sourceId, type: m.sourceType },
        unitCost: viewer.canCost && m.unitCost !== null ? toDong(m.unitCost) : null,
        doneAt: m.doneAt.toISOString(),
        doneBy: m.doneBy ? (names.get(m.doneBy) ?? null) : null,
      })),
    };
  });
}

/**
 * Đặt hoặc bỏ ngưỡng. Khoá dòng tồn trước nên hai người đặt cùng lúc xếp hàng và người sau nhận 409. `version` là
 * `version` của dòng tồn (`reorderVersion`).
 */
export async function setReorderRule(
  incomingOf: IncomingLookup,
  viewer: Viewer,
  variantId: string,
  input: { minQty: number | null; version: number },
) {
  return withCompany(viewer.companyId, async () => {
    const variant = await ownVariant(variantId);
    const incoming = (await incomingOf([variant.id])).get(variant.id) ?? 0;
    // Chưa có dòng tồn thì `reorderVersion` là 0 (FE gửi 0); dòng vừa tạo để khoá mang `version` 1.
    const existed = (await findLevel(variant.id)) !== null;
    const level = await lockLevel(variant.id);
    const currentVersion = existed ? level.version : 0;
    if (currentVersion !== input.version) {
      throw new AppError(409, 'version_conflict', 'Ngưỡng tồn vừa được người khác sửa. Xem lại số mới rồi lưu lại', {
        current: toStockLevel(variant, level, viewer, incoming),
      });
    }
    if (level.minQty !== input.minQty) {
      await setMinQty(variant.id, input.minQty);
      await recordAudit({
        companyId: viewer.companyId,
        actorId: viewer.accountId,
        action: level.minQty === null ? 'create' : input.minQty === null ? 'delete' : 'update',
        entityType: 'product.stock_levels.min_qty',
        entityId: variant.id,
        before: level.minQty === null ? null : { minQty: level.minQty },
        after: input.minQty === null ? null : { minQty: input.minQty },
      });
    }
    return toStockLevel(variant, (await findLevel(variant.id)) ?? undefined, viewer, incoming);
  });
}
