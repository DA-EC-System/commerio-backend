// Thao tác đơn trên sàn cho `order` (#105 PR 2): `order` (lớp dưới) nhận các hàm này qua `ctx.marketplaceOrders`
// ở `src/wiring.ts`, không import channel. Gọi sàn ngoài giao dịch nghiệp vụ; lỗi sàn đổi sang mã app (§1.1 R8, R9).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { MarketplaceError, type SplitAttributes } from './marketplaces/common.ts';
import { onMarketplace, shopSession } from './shops.ts';

const unsupported = () => new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ huỷ đơn từ app');

async function session(companyId: string, shopId: string) {
  return withCompany(companyId, () => shopSession(shopId));
}

export async function marketplaceCancelReasons(
  companyId: string,
  shopId: string,
  externalOrderId: string,
  externalLineIds: readonly string[],
): Promise<{ id: string; label: string }[]> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.cancelReasons) throw unsupported();
  return onMarketplace(() => adapter.cancelReasons!(accessToken, externalOrderId, externalLineIds));
}

export async function marketplaceCancelOrder(
  companyId: string,
  shopId: string,
  externalOrderId: string,
  externalLineIds: readonly string[],
  reasonId: string,
): Promise<void> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.cancelOrder) throw unsupported();
  await onMarketplace(() => adapter.cancelOrder!(accessToken, externalOrderId, externalLineIds, reasonId));
}

export async function marketplaceDecideCancel(companyId: string, shopId: string, externalOrderId: string, accept: boolean): Promise<void> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.decideCancelRequest) throw unsupported();
  await onMarketplace(() => adapter.decideCancelRequest!(accessToken, externalOrderId, accept));
}

// Tách kiện, giao kiện trên sàn cho fulfillment (#221; tách kiện #205, RTS #239 gọi), tiêm qua `ctx.marketplacePackages`.
// Sàn từ chối tách thì 422 `split_not_supported` kèm câu của sàn (Documents/21 §19.2, US-DH-19 dòng 2).

const splitRefused = (message: string, details?: Record<string, unknown>) => new AppError(422, 'split_not_supported', message, details);

/** Như `onMarketplace`, riêng sàn từ chối (vd đơn `ON_HOLD`: 21001008) thành `split_not_supported` kèm câu của sàn. */
function onSplit<T>(fn: () => Promise<T>): Promise<T> {
  return onMarketplace(async () => {
    try {
      return await fn();
    } catch (err) {
      // `unexpected_response`: sàn nhận lệnh mà trả thiếu kiện, có thể đã tách; giữ 409 `marketplace_rejected`.
      if (err instanceof MarketplaceError && err.kind === 'rejected' && err.platformCode !== 'unexpected_response') {
        throw splitRefused(err.platformMessage ?? 'Sàn từ chối tách kiện', { platformCode: err.platformCode, platformMessage: err.platformMessage });
      }
      throw err;
    }
  });
}

/** Đơn tách kiện được không, có bị sàn bắt tách không (`mustSplitReasons`). Sàn không tách kiện qua API thì 422. */
export async function marketplaceSplitAttributes(companyId: string, shopId: string, externalOrderId: string): Promise<SplitAttributes> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.splitAttributes) throw splitRefused('Sàn này không tách kiện qua API');
  return onSplit(() => adapter.splitAttributes!(accessToken, externalOrderId));
}

/**
 * Nhóm món vượt giới hạn sàn bắt tách: `TOTAL_COUNT_LIMITATION` là số món tối đa mỗi kiện (món TikTok là một đơn vị).
 * Giới hạn theo danh mục (`CATEGORY_ITEM_LIMITATION`) cần danh mục của từng món, app không có: để sàn kiểm.
 */
export function splitGroupViolation(attrs: SplitAttributes, groups: readonly (readonly string[])[]): string | null {
  const limits = attrs.mustSplitReasons.filter((r) => r.type === 'TOTAL_COUNT_LIMITATION' && r.maxCount !== null).map((r) => r.maxCount!);
  if (limits.length === 0) return null;
  const max = Math.min(...limits);
  return groups.some((g) => g.length > max) ? `Sàn chỉ cho tối đa ${max} món mỗi kiện` : null;
}

/**
 * Tách đơn trên sàn trước khi tách trong app: mỗi nhóm là mã món sàn của một kiện mới; trả mã kiện sàn theo thứ tự nhóm.
 * Đọc thuộc tính tách trước: sàn không cho tách, hoặc nhóm vượt giới hạn sàn bắt tách, thì 422 và không gọi tách.
 */
export async function marketplaceSplitOrder(
  companyId: string,
  shopId: string,
  externalOrderId: string,
  groups: readonly (readonly string[])[],
): Promise<string[]> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.splitAttributes || !adapter.splitOrder) throw splitRefused('Sàn này không tách kiện qua API');
  const attrs = await onSplit(() => adapter.splitAttributes!(accessToken, externalOrderId));
  if (!attrs.canSplit) throw splitRefused(attrs.reason ?? 'Sàn không cho tách đơn này', { platformMessage: attrs.reason });
  const violation = splitGroupViolation(attrs, groups);
  if (violation) throw splitRefused(violation, { mustSplitReasons: attrs.mustSplitReasons });
  return onSplit(() => adapter.splitOrder!(accessToken, externalOrderId, groups));
}

/** Báo sàn kiện sẵn sàng giao. Trạng thái mới về qua lượt kéo đơn kế tiếp. */
export async function marketplaceShipPackage(
  companyId: string,
  shopId: string,
  packageCode: string,
  opts?: { handover?: 'pickup' | 'drop_off' },
): Promise<void> {
  const { adapter, accessToken } = await session(companyId, shopId);
  if (!adapter.shipPackage) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ báo sẵn sàng giao từ app');
  await onMarketplace(() => adapter.shipPackage!(accessToken, packageCode, opts));
}
