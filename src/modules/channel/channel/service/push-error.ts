// Lỗi của lượt đẩy ghi lên `pushError` (#567, Documents/21 §18.6.4 "Dịch lỗi đẩy của sàn"): mã app có loại và chỗ sửa;
// lỗi sàn dịch bằng `errorMap` của adapter, mã chưa có trong bảng thì ghi log `push_error_unmapped` và đếm metric.
import client from 'prom-client';
import { withCompany } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { metricsRegistry } from '../../../../shared/observability/metrics.ts';
import type { BlockerTarget } from '../domain/blocker.ts';
import { appPushError, type PushErrorContext, type PushErrorKind, translatePlatformError } from '../domain/platform-error.ts';
import { leafAttributesOf } from '../repository/platform-categories.ts';
import { findSpec } from '../repository/product-specs.ts';
import type { Marketplace, SyncError } from '../repository/schema.ts';
import type { MarketplaceAdapter, MarketplaceError } from './marketplaces/index.ts';

const unmapped = new client.Counter({
  name: 'channel_push_error_unmapped_total',
  help: 'Số lỗi của sàn chưa có trong bảng dịch của adapter, theo sàn và thao tác (bổ sung errorMap)',
  labelNames: ['platform', 'op'] as const,
  registers: [metricsRegistry],
});

/** Mã lỗi đẩy do app đặt (mã chặn kiểm lại ở việc nền, lỗi kết nối…): loại và chỗ sửa theo mã. */
export const errorOf = (code: string, message: string, extra: Partial<Omit<SyncError, 'code' | 'message' | 'at'>> = {}): SyncError => ({
  code,
  message,
  ...appPushError(code),
  ...extra,
  at: new Date().toISOString(),
});

/** Sản phẩm của lượt đẩy, để điền nhãn attribute và suy chỗ sửa; null khi chưa biết (lỗi trước khi đọc spec). */
export interface PushErrorSubject {
  companyId: string;
  platform: Marketplace;
  productId: string | null;
  externalCategoryId: string | null;
  variantId?: string | null;
}

async function contextOf(adapter: MarketplaceAdapter, s: PushErrorSubject): Promise<PushErrorContext> {
  // Category của lượt đẩy; không có thì category của spec.
  const [attributes, spec] = await withCompany(s.companyId, async () => {
    const found = s.productId ? await findSpec(s.productId, s.platform) : undefined;
    const category = s.externalCategoryId ?? found?.externalCategoryId ?? null;
    return [category ? await leafAttributesOf(s.platform, category) : [], found] as const;
  });
  const labels = new Map(attributes.map((a) => [a.code, a.label]));
  // `axisMap`: id thuộc tính biến thể → mã sales attribute của sàn (`__custom` là tên tự đặt, không phải mã sàn).
  const axes = new Map(Object.entries(spec?.axisMap ?? {}).flatMap(([attributeId, code]) => (code === '__custom' ? [] : [[code, attributeId] as const])));
  return {
    platformName: adapter.name,
    attributeLabel: (code) => labels.get(code) ?? null,
    axisAttributeId: (code) => axes.get(code) ?? null,
  };
}

/**
 * `pushError` của một lỗi sàn. `final`: lần thử cuối của lỗi tạm. Mất uỷ quyền không tới đây (bên gọi `HoldJob`).
 * Đọc leaf và spec chỉ khi sàn từ chối (một lần mỗi lượt lỗi).
 */
export async function marketplacePushError(adapter: MarketplaceAdapter, err: MarketplaceError, s: PushErrorSubject, final = false): Promise<SyncError> {
  const raw = { platformCode: err.platformCode, platformMessage: err.platformMessage, requestId: err.requestId, variantId: s.variantId ?? null };
  if (err.kind === 'unavailable' || err.kind === 'unauthorized') {
    const message = final ? `${adapter.name} lỗi tạm, app đã thử nhiều lần không được; bấm Đăng lại sau` : `${adapter.name} đang lỗi tạm, app tự thử lại`;
    return errorOf('marketplace_unavailable', message, raw);
  }
  if (err.kind === 'unsupported') return errorOf('marketplace_rejected', `${adapter.name} chưa hỗ trợ đăng bán sản phẩm`, raw);
  const ctx = await contextOf(adapter, s);
  const out = translatePlatformError(adapter.errorMap ?? [], { platformCode: err.platformCode, platformMessage: err.platformMessage, details: err.details }, ctx);
  if (!out.mapped) {
    unmapped.inc({ platform: s.platform, op: 'push' });
    logger.warn(
      { platform: s.platform, op: 'push', platformCode: out.platformCode, platformMessage: out.platformMessage, requestId: err.requestId },
      'push_error_unmapped',
    );
  }
  return errorOf(out.code, out.message, {
    ...raw,
    kind: out.kind,
    target: out.target,
    platformCode: out.platformCode,
    platformMessage: out.platformMessage,
  });
}

/** Một phần hỏng (tồn hoặc giá) của kết quả `updatePriceQuantity`: `code` là mã gốc của sàn hoặc mã app `marketplace_*`, `no_result`. */
export interface SyncFailure {
  code: string;
  message: string;
  requestId?: string | null;
}

/**
 * Lỗi đồng bộ tồn, giá (`stockSyncError`, `priceSyncError`, #571, Documents/21 §18.6.4) cùng hình `pushError`: mã sàn dịch bằng
 * `errorMap` của adapter theo thao tác `op`; mã chưa có thì `marketplace_rejected` kèm câu sàn, ghi log và đếm metric như lượt đẩy.
 * Không đọc leaf, spec (lỗi tồn, giá không chỉ tới attribute).
 */
export function syncErrorOf(
  adapter: Pick<MarketplaceAdapter, 'name' | 'errorMap'>,
  platform: Marketplace,
  part: SyncFailure,
  op: 'stock' | 'price',
  variantId: string | null,
  at: Date,
): SyncError {
  const raw = { variantId, requestId: part.requestId ?? null };
  const app = (code: string, message: string, platformMessage: string | null): SyncError => ({
    ...errorOf(code, message, { ...raw, platformCode: null, platformMessage }),
    at: at.toISOString(),
  });
  const said = part.message || null;
  if (part.code === 'marketplace_unavailable') return app('marketplace_unavailable', `${adapter.name} đang lỗi tạm, lượt đồng bộ sau app gửi lại`, said);
  if (part.code === 'marketplace_unauthorized') return app('shop_not_connected', `${adapter.name} không nhận uỷ quyền của gian hàng; kết nối lại gian hàng`, said);
  if (part.code === 'no_result') return app('marketplace_rejected', `${adapter.name} không trả kết quả cho SKU này; lượt đồng bộ sau app gửi lại`, null);
  // Mã app khác (`marketplace_rejected` không kèm mã sàn, `unknown` của TikTok) không phải mã sàn: không đưa vào `platformCode`.
  const platformCode = part.code.startsWith('marketplace_') || part.code === 'unknown' ? null : part.code;
  const ctx: PushErrorContext = { platformName: adapter.name, attributeLabel: () => null, axisAttributeId: () => null };
  const out = translatePlatformError(adapter.errorMap ?? [], { platformCode, platformMessage: said, details: [] }, ctx, op);
  if (!out.mapped && out.platformCode) {
    unmapped.inc({ platform, op });
    logger.warn({ platform, op, platformCode: out.platformCode, platformMessage: out.platformMessage, requestId: raw.requestId }, 'push_error_unmapped');
  }
  return {
    ...errorOf(out.code, out.message, { ...raw, kind: out.kind, target: out.target, platformCode: out.platformCode, platformMessage: out.platformMessage }),
    at: at.toISOString(),
  };
}

/** `pushError` trả ra API (21 §18.6.4): bản ghi trước #567 không có các trường mới thì `null`. */
export interface PushErrorView {
  code: string;
  kind: PushErrorKind | null;
  message: string;
  target: BlockerTarget | null;
  variantId: string | null;
  platformCode: string | null;
  platformMessage: string | null;
  requestId: string | null;
  at: string;
}

export const pushErrorView = (e: SyncError | null): PushErrorView | null =>
  e && {
    code: e.code,
    kind: e.kind ?? null,
    message: e.message,
    target: e.target ?? null,
    variantId: e.variantId ?? null,
    platformCode: e.platformCode ?? null,
    platformMessage: e.platformMessage ?? null,
    requestId: e.requestId ?? null,
    at: e.at,
  };
