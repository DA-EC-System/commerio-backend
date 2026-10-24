// Tồn và ngưỡng tồn (UC-IN-01, UC-IN-02; Documents/21 7.1, K1, K3, K7, V29–V33; D10; plan #16 A2–A4, A9, A15, A17).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../../core/index.ts';
import type { VariantSummary } from '../../catalog/index.ts';
import { getVariants } from '../../catalog/index.ts';
import { toDong } from '../domain/stock.ts';
import {
  allLevels,
  allRules,
  deleteRule,
  findLevel,
  findRule,
  latestMoves,
  type LevelRow,
  lockLevels,
  saveRule,
} from '../repository/levels.ts';
import { syncThreshold } from './posting.ts';
import { namesOf, notFound, toStockLevel, type Viewer } from './views.ts';

const MOVES_LIMIT = 100;

/**
 * Danh sách tồn: lọc và phân trang trong bộ nhớ sau `getVariants()` (D10). Gồm biến thể đang bán và biến thể ngừng bán
 * còn hàng (A2); `summary` tính trên toàn bộ danh sách đó, `totalValue` là tổng các `stockValue` đã làm tròn (A4).
 */
export async function listStock(
  viewer: Viewer,
  q: { page: number; pageSize: number; search?: string | undefined; categoryId?: string | undefined; belowMin?: boolean | undefined },
) {
  return withCompany(viewer.companyId, async () => {
    // Cùng một kết nối của giao dịch: đọc tuần tự (Promise.all không nhanh hơn, node-pg cảnh báo).
    const variants = await getVariants();
    const levels = await allLevels();
    const rules = await allRules();
    const all = variants
      .filter((v) => !v.archived || (levels.get(v.id)?.onHand ?? 0) !== 0)
      .map((v) => toStockLevel(v, levels.get(v.id), rules.get(v.id), viewer))
      .sort((a, b) => a.productName.localeCompare(b.productName, 'vi') || a.sku.localeCompare(b.sku, 'vi'));
    const search = q.search?.toLowerCase();
    const items = all.filter(
      (l) =>
        (!search || l.productName.toLowerCase().includes(search) || l.sku.toLowerCase().includes(search)) &&
        (!q.categoryId || l.category.id === q.categoryId) &&
        (!q.belowMin || l.belowMin),
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
        totalValue: viewer.canCost ? all.reduce((s, l) => s + l.stockValue!, 0) : null,
      },
    };
  });
}

/** Biến thể của công ty (kể cả đã ngừng bán); công ty khác hay id sai → 404 (C4, V6; `getVariants` bỏ id không phải uuid). */
async function ownVariant(variantId: string): Promise<VariantSummary> {
  const [variant] = await getVariants([variantId]);
  if (!variant) throw notFound('biến thể');
  return variant;
}

/** `level` đã đọc (vd đang khoá) thì dùng lại, không đọc lần nữa. */
async function levelView(variant: VariantSummary, viewer: Viewer, level?: LevelRow) {
  const row = level ?? (await findLevel(variant.id));
  return toStockLevel(variant, row ?? undefined, (await findRule(variant.id)) ?? undefined, viewer);
}

/** Tồn một biến thể và 100 dòng thẻ kho mới nhất (AC-3). */
export async function getStock(viewer: Viewer, variantId: string) {
  return withCompany(viewer.companyId, async () => {
    const variant = await ownVariant(variantId);
    const level = await levelView(variant, viewer);
    const moves = await latestMoves(variant.id, MOVES_LIMIT);
    const names = await namesOf(moves.map((m) => m.done_by));
    return {
      level,
      moves: moves.map((m) => ({
        id: m.id,
        qtyChange: m.qty_change,
        onHandAfter: m.on_hand_after,
        document: { id: m.doc_id, number: m.doc_number, type: m.doc_type, kind: m.doc_kind },
        unitCost: viewer.canCost && m.unit_cost !== null ? toDong(m.unit_cost) : null,
        doneAt: new Date(m.done_at).toISOString(),
        doneBy: m.done_by ? (names.get(m.done_by) ?? null) : null,
      })),
    };
  });
}

/**
 * Đặt hoặc bỏ ngưỡng (UC-IN-02, V33). Khoá dòng tồn trước (thứ tự khoá chung A6) nên hai người đặt cùng lúc xếp hàng
 * và người sau nhận 409; đặt ngưỡng khi đã dưới ngưỡng thì phát cảnh báo ngay (V31).
 */
export async function setReorderRule(viewer: Viewer, variantId: string, input: { minQty: number | null; version: number }) {
  return withCompany(viewer.companyId, async () => {
    const variant = await ownVariant(variantId);
    const level = (await lockLevels([variant.id], true)).get(variant.id)!;
    const rule = (await findRule(variant.id)) ?? undefined;
    if ((rule?.version ?? 0) !== input.version) {
      throw new AppError(409, 'version_conflict', 'Ngưỡng tồn vừa được người khác sửa. Xem lại số mới rồi lưu lại', {
        current: await levelView(variant, viewer, level),
      });
    }
    const before = rule ? { minQty: rule.minQty } : null;
    if (input.minQty === null) {
      if (rule) await deleteRule(rule.id);
    } else {
      await saveRule(variant.id, input.minQty, rule);
      await syncThreshold(variant.id, level.onHand - level.reserved);
    }
    const after = input.minQty === null ? null : { minQty: input.minQty };
    if (before?.minQty !== after?.minQty) {
      await recordAudit({
        companyId: viewer.companyId,
        actorId: viewer.accountId,
        action: !before ? 'create' : !after ? 'delete' : 'update',
        entityType: 'inventory.reorder_rules',
        entityId: variant.id,
        before,
        after,
      });
    }
    return levelView(variant, viewer, level);
  });
}
