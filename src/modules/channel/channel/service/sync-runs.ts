// Kết quả lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ", thiết kế
// `.claude/issues/trang-san-pham-tab/design/v2.html` Màn 2). Việc `channel.listing_sync` nhận lượt `queued` lúc bắt đầu,
// `pushDue` cộng kết quả theo lô, xong thì ghi `done` hoặc `failed`.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { STALE_PUSH_MS } from '../domain/listing.ts';
import type { SyncError, SyncRunErrorRow } from '../repository/schema.ts';
import { findSyncRun, latestSyncRun, type SyncRunRow } from '../repository/sync-runs.ts';
import type { ListingVariant } from './product-port.ts';
import { type Actor, ownShop } from './shops.ts';

/** Lượt `queued`, `running` quá ngưỡng này (việc mất, worker chết) đọc ra `failed` `run_stale`. */
export const SYNC_RUN_STALE_MS = STALE_PUSH_MS;

export interface SyncRunView {
  id: string;
  shopId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { processed: number; total: number | null };
  succeeded: number;
  failed: number;
  errors: SyncRunErrorRow[];
  error: { code: string; message: string } | null;
}

export function toSyncRunView(row: SyncRunRow, now = Date.now()): SyncRunView {
  const open = row.status === 'queued' || row.status === 'running';
  const stale = open && (row.startedAt ?? row.requestedAt).getTime() < now - SYNC_RUN_STALE_MS;
  return {
    id: row.id,
    shopId: row.shopId,
    status: stale ? 'failed' : row.status,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    progress: { processed: row.processed, total: row.total },
    succeeded: row.succeeded,
    failed: row.failed,
    errors: row.errors,
    error: stale ? { code: 'run_stale', message: 'Quá 30 phút chưa có kết quả, bấm Đồng bộ lại' } : (row.error ?? null),
  };
}

export async function getSyncRun(actor: Actor, shopId: string, runId: string): Promise<SyncRunView> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const row = isUuid(runId) ? await findSyncRun(shop.id, runId) : undefined;
    if (!row) throw new AppError(404, 'not_found', 'Không tìm thấy lượt đồng bộ');
    return toSyncRunView(row);
  });
}

export async function getLatestSyncRun(actor: Actor, shopId: string): Promise<SyncRunView | null> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const row = await latestSyncRun(shop.id);
    return row ? toSyncRunView(row) : null;
  });
}

/** Chỗ sửa của mã lỗi (21 §18 `SyncFix`). */
export function syncFixOf(code: string): SyncRunErrorRow['fix'] {
  if (code === 'price_missing') return 'variant_price';
  if (code === 'stock_not_counted') return 'stocktake';
  if (code === 'promotion_locked') return 'platform';
  return null;
}

/** Câu cho người bán của lỗi do app giữ (lỗi của sàn thì bên gọi tự đặt câu và `platformMessage`). */
const APP_MESSAGES: Record<string, string> = {
  price_missing: 'Chưa có giá bán: chưa có giá chuẩn hay giá muốn thực nhận',
};

/** Một dòng lỗi của lượt từ lỗi của listing. `platform` là lỗi sàn trả: câu tiếng Việt của app, câu sàn ở `platformMessage`. */
export function syncRunErrorOf(
  row: { id: string; variantId: string | null; sellerSku: string | null },
  variant: Pick<ListingVariant, 'productId' | 'productName' | 'attributesLabel'> | undefined,
  error: SyncError,
  platform: { what: 'tồn' | 'giá' } | null = null,
): SyncRunErrorRow {
  return {
    listingId: row.id,
    variantId: row.variantId,
    productId: variant?.productId ?? null,
    productName: variant?.productName ?? null,
    attributesLabel: variant?.attributesLabel || null,
    sku: row.sellerSku,
    code: error.code,
    message: platform
      ? error.code === 'no_result'
        ? 'Sàn không trả kết quả cho SKU này'
        : `Sàn từ chối cập nhật ${platform.what}`
      : (APP_MESSAGES[error.code] ?? error.message),
    platformMessage: platform ? error.message : null,
    at: error.at,
    fix: syncFixOf(error.code),
  };
}

/** Lỗi cả lượt từ lỗi của việc đồng bộ. */
export function syncRunFailureOf(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) {
    if (err.code === 'marketplace_unauthorized') return { code: err.code, message: 'Gian hàng mất uỷ quyền, kết nối lại gian hàng rồi đồng bộ lại' };
    return { code: err.code, message: err.message };
  }
  return { code: 'internal_error', message: 'Lỗi hệ thống khi đồng bộ, thử lại sau' };
}
