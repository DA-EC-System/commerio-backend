// Sửa hàng loạt có gợi ý (#242, Documents/21 §17.5; 25 §5.3; 27 US-SP-04). Gợi ý chỉ được tính và trả về; chỉ giá trị
// người dùng gửi lên mới được lưu. Mỗi dòng lưu trong giao dịch riêng: dòng lỗi huỷ riêng dòng đó, dòng khác vẫn ghi.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { BulkRowInput } from '../domain/bulk-row.ts';
import {
  productSuggestConfig,
  SALES_WINDOW_DAYS,
  type SiblingField,
  type SiblingValues,
  type Suggestion,
  suggestFromSiblings,
  suggestMinQty,
  suggestTargetPrice,
} from '../domain/suggestion.ts';
import { type BulkFilter, findBulkVariants, findSiblingVariants } from '../repository/bulk.ts';
import { touchProduct } from '../repository/products.ts';
import { findSettings } from '../repository/settings.ts';
import { findVariants } from '../repository/variants.ts';
import { type Caller, isUuid } from './errors.ts';
import { listedFieldErrors } from './listed-fields.ts';
import { toDong } from './products.ts';
import type { CatalogContext } from './usage.ts';
import { suggestOf } from './suggest-config.ts';
import { applyVariantUpdate } from './variants.ts';

/** Dữ liệu của module khác mà catalog (lớp dưới) cần; `src/modules/product/index.ts` và `src/wiring.ts` nối vào. */
export interface BulkEditPorts {
  /** Giá nhập trên đề nghị nhập đã duyệt gần nhất của từng SKU (purchasing). */
  lastCostsOf(ids: readonly string[]): Promise<Map<string, { requestNumber: string; supplierName: string | null; unitCost: string }>>;
  /** Ngưỡng tồn và `reorderVersion` (inventory). */
  reorderRulesOf(ids: readonly string[]): Promise<Map<string, { minQty: number | null; version: number }>>;
  /** Đặt ngưỡng trong giao dịch của bên gọi (inventory); `stale` khi sai `reorderVersion`. */
  applyReorderRule(
    actor: Caller,
    variantId: string,
    input: { minQty: number | null; version: number; label: string },
  ): Promise<'unchanged' | 'updated' | 'stale'>;
  /** Số món bán ra trong `days` ngày gần nhất (sales). */
  soldQtyOf(ids: readonly string[], days: number): Promise<Map<string, number>>;
}

/** `ctx` của catalog: cần thêm `listingPresenceOf` (chặn xoá trống trường bắt buộc của SKU còn listing). */
export interface BulkEditContext extends CatalogContext {
  readonly bulkEdit?: BulkEditPorts;
}

/** Người gọi kèm quyền: ẩn giá nhập khi thiếu `inventory.cost.view`, chặn ngưỡng khi thiếu `inventory.reorder.manage`. */
export interface BulkViewer extends Caller {
  readonly permissions: readonly string[];
}

const COST_VIEW = 'inventory.cost.view';
const REORDER_MANAGE = 'inventory.reorder.manage';

function portsOf(ctx: BulkEditContext): BulkEditPorts {
  if (!ctx.bulkEdit) throw new Error('Chưa nối bulkEdit cho catalog (src/modules/product/index.ts, src/wiring.ts)');
  return ctx.bulkEdit;
}

type Field = SiblingField | 'minQty';

export async function listBulkEdit(ctx: BulkEditContext, viewer: BulkViewer, filter: BulkFilter) {
  const ports = portsOf(ctx);
  const canCost = viewer.permissions.includes(COST_VIEW);
  return withCompany(viewer.companyId, async () => {
    const { total, rows } = await findBulkVariants(filter);
    const ids = rows.map((r) => r.id);
    const full = new Map((await findVariants({ ids })).map((v) => [v.id, v]));
    const siblingRows = await findSiblingVariants([...new Set(rows.map((r) => r.productId))]);
    const siblingsOf = Map.groupBy(siblingRows, (s) => s.productId);
    const [costs, reorder] = await Promise.all([ports.lastCostsOf(ids), ports.reorderRulesOf(ids)]);
    const noRule = ids.filter((id) => reorder.get(id)?.minQty == null);
    const sold = await ports.soldQtyOf(noRule, SALES_WINDOW_DAYS);
    const company = suggestOf(await findSettings(viewer.companyId));

    const items = rows.map((row) => {
      const v = full.get(row.id)!;
      const rule = reorder.get(row.id);
      const config = productSuggestConfig({ ...suggestOf(row), name: row.groupName }, company);
      const current = {
        standardPrice: toDong(v.standardPrice),
        targetNetPrice: toDong(v.targetNetPrice),
        minQty: rule?.minQty ?? null,
        weightG: v.weightG,
        lengthMm: v.lengthMm,
        widthMm: v.widthMm,
        heightMm: v.heightMm,
      };
      const siblings: SiblingValues[] = (siblingsOf.get(row.productId) ?? [])
        .filter((s) => s.id !== row.id)
        .map((s) => ({
          sku: s.sku,
          values: {
            standardPrice: toDong(s.standardPrice),
            targetNetPrice: toDong(s.targetNetPrice),
            weightG: s.weightG,
            lengthMm: s.lengthMm,
            widthMm: s.widthMm,
            heightMm: s.heightMm,
          },
        }));
      const cost = costs.get(row.id);
      const suggestions: Partial<Record<Field, Suggestion>> = {};
      const set = (field: Field, s: Suggestion | null) => {
        if (s) suggestions[field] = s;
      };
      for (const field of ['standardPrice', 'weightG', 'lengthMm', 'widthMm', 'heightMm'] as const) {
        if (current[field] === null) set(field, suggestFromSiblings(field, siblings));
      }
      if (current.targetNetPrice === null) {
        const margin = config.marginCoefficient;
        set(
          'targetNetPrice',
          cost && margin
            ? suggestTargetPrice(
                cost.unitCost,
                { marginCoefficient: margin.value, priceRounding: config.priceRounding?.value ?? null, source: margin.source },
                canCost,
              )
            : suggestFromSiblings('targetNetPrice', siblings),
        );
      }
      if (current.minQty === null) {
        set(
          'minQty',
          suggestMinQty({
            soldQty: sold.get(row.id) ?? 0,
            leadDays: config.reorderLeadDays,
            safetyQty: config.reorderSafetyQty,
            defaultQty: config.reorderDefaultQty,
          }),
        );
      }
      return {
        variantId: row.id,
        productId: row.productId,
        productName: row.productName,
        sku: row.sku,
        attributesLabel: v.attributes.map((a) => a.value).join(' / '),
        groupName: row.groupName,
        version: v.version,
        reorderVersion: rule && rule.version > 0 ? rule.version : null,
        current,
        source: cost
          ? { purchaseRequestNumber: cost.requestNumber, supplierName: cost.supplierName, lastCost: canCost ? toDong(cost.unitCost) : null }
          : null,
        suggestions,
      };
    });
    return { items, total, page: filter.page, pageSize: filter.pageSize };
  });
}

/**
 * `product_archived` giữ trong hợp đồng (`Documents/21` §17.5) nhưng không còn sinh ra: #204 bỏ lưu trữ sản phẩm cha.
 * `listing_field_required`: dòng xoá trống giá muốn bán, cân nặng, kích thước của SKU còn listing chưa gỡ, kèm `errors`.
 */
export type BulkFailureCode = 'validation_failed' | 'version_conflict' | 'not_found' | 'product_archived' | 'listing_field_required';
export interface BulkFailure {
  variantId: string;
  code: BulkFailureCode;
  message: string;
  errors?: Record<string, string>;
}

/** Lỗi của một dòng: ném trong giao dịch của dòng để huỷ mọi thứ đã ghi cho dòng đó. */
class RowFailure extends Error {
  readonly code: BulkFailureCode;
  readonly errors: Record<string, string> | undefined;
  constructor(code: BulkFailureCode, message: string, errors?: Record<string, string>) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}

export const BULK_MAX_ROWS = 200;

export async function saveBulkEdit(ctx: BulkEditContext, viewer: BulkViewer, rawRows: readonly unknown[]) {
  if (rawRows.length > BULK_MAX_ROWS) throw new AppError(400, 'too_many_rows', `Tối đa ${BULK_MAX_ROWS} dòng mỗi lần lưu`);
  const ports = portsOf(ctx);
  const saved: { variantId: string; version: number }[] = [];
  const failed: BulkFailure[] = [];
  const seen = new Set<string>();
  for (const raw of rawRows) {
    const variantId = typeof (raw as { variantId?: unknown } | null)?.variantId === 'string' ? (raw as { variantId: string }).variantId : '';
    try {
      const parsed = BulkRowInput.safeParse(raw);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? 'row')] ??= issue.message;
        throw new RowFailure('validation_failed', 'Dữ liệu dòng không hợp lệ', errors);
      }
      const row = parsed.data;
      if (seen.has(row.variantId)) throw new RowFailure('validation_failed', 'SKU xuất hiện hai lần trong lần lưu này', { variantId: 'SKU bị lặp' });
      seen.add(row.variantId);
      if (row.minQty !== undefined && !viewer.permissions.includes(REORDER_MANAGE)) {
        throw new RowFailure('validation_failed', 'Không có quyền đặt ngưỡng tồn', { minQty: 'Bạn không có quyền đặt ngưỡng tồn' });
      }
      const version = await withCompany(viewer.companyId, async () => {
        const [current] = isUuid(row.variantId) ? await findVariants({ ids: [row.variantId] }) : [];
        if (!current) throw new RowFailure('not_found', 'Không tìm thấy SKU');
        const listed = await listedFieldErrors(ctx, current, row);
        if (listed) throw new RowFailure('listing_field_required', listed.detail, listed.errors);
        const outcome = await applyVariantUpdate(viewer, current, row);
        if (outcome === 'stale') throw new RowFailure('version_conflict', `SKU ${current.sku} vừa được người khác sửa`);
        if (outcome === 'updated') await touchProduct(current.productId);
        if (row.minQty !== undefined) {
          const rule = await ports.applyReorderRule(viewer, current.id, {
            minQty: row.minQty,
            version: row.reorderVersion ?? 0,
            label: `${current.productName} · ${current.sku}`,
          });
          if (rule === 'stale') {
            throw new RowFailure('version_conflict', 'Ngưỡng tồn vừa được người khác sửa', { minQty: 'Ngưỡng tồn vừa được người khác sửa' });
          }
        }
        return outcome === 'updated' ? current.version + 1 : current.version;
      });
      saved.push({ variantId: row.variantId, version });
    } catch (err) {
      if (!(err instanceof RowFailure)) throw err;
      failed.push({ variantId, code: err.code, message: err.message, ...(err.errors && { errors: err.errors }) });
    }
  }
  return { saved, failed };
}
