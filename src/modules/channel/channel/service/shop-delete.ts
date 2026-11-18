// Xoá gian hàng đã ngắt (#398, issue mục "API", "Xoá gì"). Channel (lớp 5) điều phối, mỗi module xoá bảng của mình qua
// `index.ts`; insight cùng lớp và đã import channel nên tiêm qua `ctx` (`src/wiring.ts`).
import { dropHeld, recordAudit } from '../../../core/index.ts';
import { type FinanceDataCounts, hasFinanceData, purgeShopFinance, shopFinanceData } from '../../../finance/index.ts';
import { purgeOrderPackages, purgeShopOrders, shopOrderRefs } from '../../../order/index.ts';
import { detachShopStockDocuments } from '../../../product/index.ts';
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { purgeShopInbox } from '../../inbox/index.ts';
import { deleteShopRow, purgeShopRows } from '../repository/shops.ts';
import { stopShopJobs } from './shop-jobs.ts';
import { type Actor, lockShopOr404, notFound, shopView, versionConflict } from './shops.ts';

/** `ctx` của router channel: hàm của insight (lớp cùng cấp, đã import channel) do `src/wiring.ts` tiêm. */
export interface ChannelContext extends ModuleContext {
  readonly deleteShopSummaries?: (shopId: string) => Promise<number>;
}

export interface ShopDeleteOutcome {
  deleted: {
    orders: number;
    orderLines: number;
    returnRequests: number;
    returnRequestLines: number;
    packages: number;
    packageLines: number;
    returnParcels: number;
    listings: number;
    priceCalculations: number;
    rawOrders: number;
    remoteSkus: number;
    stockDocuments: number;
    configVersions: number;
    orderSettlements: number;
    reportRows: number;
    messageChannels: number;
  };
  detached: { stockDocuments: number };
}

/** Chờ khoá phiên của việc nền gian hàng tối đa chừng này; quá thì 409 `shop_busy`. */
const BUSY_WAIT_MS = 3000;

const hasFinance = (counts: FinanceDataCounts) =>
  new AppError(409, 'shop_has_finance_data', 'Gian hàng đã có dữ liệu tiền (sổ tiền, đối soát, chứng từ), không xoá được', {
    financeData: counts,
  });

/**
 * Xoá hẳn gian hàng `disconnected` không có dữ liệu tiền cùng đơn, kiện, yêu cầu trả, listing, đơn gốc, SKU sàn của nó,
 * trong một giao dịch dưới khoá phiên việc nền của gian hàng (`channel.token`, `channel.remote_skus`) và khoá dòng gian
 * hàng. Thứ tự lỗi: 404 → 409 `shop_not_disconnected` → 409 `version_conflict` → 409 `shop_has_finance_data`; khoá bận
 * 409 `shop_busy`. Không xoá `state_transitions`, `audit_logs`, thẻ kho, phiếu kho đã ghi sổ (chỉ cắt `shop_id`).
 */
export async function deleteShop(ctx: ChannelContext, actor: Actor, id: string, input: { version: number }): Promise<ShopDeleteOutcome> {
  if (!isUuid(id)) throw notFound();
  const deleteSummaries = ctx.deleteShopSummaries;
  // Quên tiêm là lỗi lắp ráp: không im lặng bỏ số liệu của gian hàng lại.
  if (!deleteSummaries) throw new Error('Thiếu ctx.deleteShopSummaries (src/wiring.ts)');

  const outcome = await withSessionLock(
    `channel.token:${id}`,
    () =>
      withCompany(actor.companyId, async (): Promise<ShopDeleteOutcome> => {
        const row = await lockShopOr404(id);
        if (row.status !== 'disconnected') {
          throw new AppError(409, 'shop_not_disconnected', 'Chỉ xoá được gian hàng đã ngắt kết nối', { current: await shopView(row) });
        }
        if (row.version !== input.version) throw await versionConflict(row);
        const refs = await shopOrderRefs(id);
        const counts = await shopFinanceData(id, refs.orderIds);
        if (hasFinanceData(counts)) throw hasFinance(counts);

        // Kiện trước đơn, cùng giao dịch: trigger kiểm bằng của dòng kiện hoãn tới commit.
        const packages = await purgeOrderPackages(refs);
        const documents = await detachShopStockDocuments({
          shopId: id,
          shopName: row.shopName,
          orderIds: refs.orderIds,
          packageIds: packages.packageIds,
          returnRequestIds: refs.returnRequestIds,
          parcelIds: packages.parcelIds,
        });
        const orders = await purgeShopOrders(refs);
        const finance = await purgeShopFinance(id, refs.orderIds);
        const reportRows = await deleteSummaries(id);
        const messageChannels = await purgeShopInbox(id);
        const channel = await purgeShopRows(id);
        await deleteShopRow(id);

        const result: ShopDeleteOutcome = {
          deleted: {
            ...orders,
            packages: packages.packages,
            packageLines: packages.packageLines,
            returnParcels: packages.returnParcels,
            ...channel,
            stockDocuments: documents.deleted,
            ...finance,
            reportRows,
            messageChannels,
          },
          detached: { stockDocuments: documents.detached },
        };
        await recordAudit({
          companyId: actor.companyId,
          actorId: actor.accountId,
          action: 'delete',
          entityType: 'channel.shops',
          entityId: id,
          label: row.shopName,
          before: { shopName: row.shopName, platform: row.platform, externalShopId: row.externalShopId, status: row.status },
          after: { ...result },
        });
        return result;
      }),
    { additionalKeys: [`channel.remote_skus:${id}`], waitMs: BUSY_WAIT_MS },
  );
  if (outcome === 'busy') throw new AppError(409, 'shop_busy', 'Gian hàng đang có việc nền chạy, thử lại sau ít phút');

  // Ngắt đã bỏ lịch và việc đang giữ; dọn lại phòng còn sót. Gian hàng đã xoá nên việc còn chờ tự bỏ qua khi chạy.
  try {
    await stopShopJobs(id);
    await dropHeld(id);
  } catch (err) {
    logger.warn({ err, shopId: id }, 'xoá gian hàng: không dọn được lịch, việc đang giữ của gian hàng đã xoá');
  }
  logger.info({ shopId: id, companyId: actor.companyId, deleted: outcome.deleted, detached: outcome.detached }, 'đã xoá gian hàng');
  return outcome;
}
