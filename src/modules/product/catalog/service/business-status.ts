// Đổi trạng thái kinh doanh của SKU (#204, Documents/21 §17.2, §17.3, 25 §5.1). Mỗi SKU đổi ghi lịch sử, nhật ký và
// phát `catalog.variant_status_changed` cùng giao dịch: channel ẩn, hiện, gỡ listing; inventory xét lại ngưỡng.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { assertTransition, publishEvent, recordAudit, recordTransition } from '../../../core/index.ts';
import { type BusinessAction, type BusinessStatus, businessStatusMachine } from '../domain/business-status.ts';
import { touchProduct } from '../repository/products.ts';
import { findVariants, lockVariants, restoreArchivedRows, setBusinessStatus } from '../repository/variants.ts';
import { archiveBlocked, auditOf, invalid, invalidTransition, productArchived } from './errors.ts';
import { findOwnProduct, type ProductDetail, productDetail } from './products.ts';
import { archiveBlockersOf, type CatalogContext } from './usage.ts';

/** Người làm, lấy nguyên từ `getAuth`, `getAccess` của request. */
export interface BusinessActor {
  readonly accountId: string;
  readonly companyId: string;
  readonly permissions: readonly string[];
  readonly enabledModules: readonly string[];
}

export interface BusinessStatusInput {
  action: BusinessAction;
  /** Bỏ trống: mọi SKU của sản phẩm. */
  variantIds?: string[] | undefined;
}

export interface SkippedVariant {
  variantId: string;
  sku: string;
  code: 'invalid_transition' | 'archive_blocked';
  reasons: string[];
}

export interface BusinessStatusResult {
  product: ProductDetail;
  applied: string[];
  skipped: SkippedVariant[];
}

/** Tên bảng ở lịch sử chuyển trạng thái; nhật ký thao tác dùng `<schema>.<bảng>`. */
const HISTORY_ENTITY = 'product_variants';
const AUDIT_ENTITY = 'product.product_variants';

const skippable = (err: unknown): err is AppError =>
  err instanceof AppError && (err.code === 'invalid_transition' || err.code === 'archive_blocked');

/**
 * Áp một thao tác cho các SKU của sản phẩm. SKU không làm được (sai trạng thái, bị chặn lưu trữ) vào `skipped`; riêng
 * khi gửi đúng một `variantIds` thì ném lỗi như máy trạng thái khác (`invalid_transition` kèm `current`,
 * `archive_blocked` kèm `reasons`). Khoá theo thứ tự: khoá công ty (`lockVariants`) → dòng tồn (nguồn inventory, khi
 * lưu trữ) → dòng SKU.
 */
export async function changeBusinessStatus(
  ctx: CatalogContext,
  actor: BusinessActor,
  productId: string,
  input: BusinessStatusInput,
): Promise<BusinessStatusResult> {
  return withCompany(actor.companyId, async () => {
    await lockVariants(actor.companyId);
    const product = await findOwnProduct(productId);
    if (product.archivedAt) throw productArchived();
    const variants = await findVariants({ productId });
    const byId = new Map(variants.map((v) => [v.id, v]));
    if (input.variantIds?.some((id) => !byId.has(id))) throw invalid({ variantIds: 'Có SKU không thuộc sản phẩm này' });
    // Theo id tăng dần: khoá dòng SKU cùng thứ tự với hệ thống tự khôi phục (`restoreArchivedRows`), không khoá chéo.
    const targets = (input.variantIds ? input.variantIds.map((id) => byId.get(id)!) : [...variants]).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const single = input.variantIds?.length === 1;

    const candidates = input.action === 'archive' ? targets.filter((v) => v.businessStatus === 'discontinued') : [];
    const blockers = await archiveBlockersOf(ctx, candidates.map((v) => v.id), { lock: true });

    const applied: string[] = [];
    const skipped: SkippedVariant[] = [];
    for (const v of targets) {
      const reasons = blockers.get(v.id) ?? [];
      let to: BusinessStatus;
      try {
        ({ to } = assertTransition(businessStatusMachine, v.businessStatus, input.action, { actor, record: { archiveBlockers: reasons } }));
      } catch (err) {
        if (!skippable(err)) throw err;
        if (single) throw err.code === 'archive_blocked' ? archiveBlocked(v.sku, reasons) : invalidTransition(await productDetail(ctx, product, variants));
        skipped.push({ variantId: v.id, sku: v.sku, code: err.code as SkippedVariant['code'], reasons: err.code === 'archive_blocked' ? reasons : [] });
        continue;
      }
      // Khoá công ty chặn thao tác của người khác; hệ thống tự khôi phục không lấy khoá này nên vẫn có thể vừa đổi.
      const updated = await setBusinessStatus(v.id, v.businessStatus, to);
      if (!updated) {
        if (single) throw invalidTransition(await productDetail(ctx, await findOwnProduct(productId)));
        skipped.push({ variantId: v.id, sku: v.sku, code: 'invalid_transition', reasons: [] });
        continue;
      }
      await recordTransition({
        entityType: HISTORY_ENTITY,
        entityId: v.id,
        from: v.businessStatus,
        to,
        action: input.action,
        actorId: actor.accountId,
        source: 'user',
      });
      await recordAudit({
        ...auditOf(actor, 'update', AUDIT_ENTITY, v.id),
        before: { businessStatus: v.businessStatus },
        after: { businessStatus: to },
      });
      await publishEvent({
        type: 'catalog.variant_status_changed',
        aggregateId: v.id,
        payload: { variantId: v.id, productId: product.id, from: v.businessStatus, to, changedAt: updated.updatedAt.toISOString() },
      });
      applied.push(v.id);
    }
    if (applied.length) await touchProduct(product.id);
    return { product: await productDetail(ctx, await findOwnProduct(productId)), applied, skipped };
  });
}

/**
 * Hệ thống tự khôi phục (Documents/21 §17.3 dòng "(hệ thống)", US-SP-07 dòng 4): SKU đang `archived` trong `variantIds`
 * về `discontinued`, ghi lịch sử nguồn hệ thống (người làm trống), phát `catalog.variant_status_changed`. SKU khác bỏ
 * qua. Inventory gọi trong giao dịch ghi sổ khi tồn thực hoặc chờ xử lý tăng.
 *
 * Không lấy `lockVariants`: dòng tồn đã khoá, lấy khoá công ty ở đây ngược thứ tự với luồng lưu trữ (khoá công ty → dòng
 * tồn → SKU) và bắt mọi lần ghi sổ của công ty xếp hàng (spec 204 mục 5.2). Không bật cờ Cần xử lý (D6), không ghi nhật
 * ký thao tác (không có người làm).
 */
export async function restoreArchivedBySystem(variantIds: readonly string[]): Promise<void> {
  for (const row of await restoreArchivedRows([...new Set(variantIds)])) {
    await recordTransition({
      entityType: HISTORY_ENTITY,
      entityId: row.id,
      from: 'archived',
      to: 'discontinued',
      action: 'restore',
      actorId: null,
      source: 'system',
    });
    await publishEvent({
      type: 'catalog.variant_status_changed',
      aggregateId: row.id,
      payload: { variantId: row.id, productId: row.productId, from: 'archived', to: 'discontinued', changedAt: row.updatedAt.toISOString() },
    });
  }
}
