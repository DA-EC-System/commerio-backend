// Yêu cầu trả Lazada (#202): kéo đơn ngược, lý do từ chối, quyết định của người bán, báo đã nhận, lịch sử.
// Nguồn (open.lazada.com, mục Return and Refund API, đọc 12/11/2026): GetReverseOrdersForSeller
// (`/reverse/getreverseordersforseller`), GetReverseOrderReasonList (`/order/reverse/reason/list`), ReverseOrderReturnUpdate
// (`/order/reverse/return/update`, `action` ∈ instantRefund, agreeReturn, refuseReturn, agreeRefund, refuseRefund,
// confirmDelivery), GetReverseOrderHistoryList (`/order/reverse/return/history/list`), ReverseOrderOnlyRefundDecide
// (`/order/reverse/onlyrefund/seller/decide`, `action` agreeRefund, startDispute).
// Gọi thật 12/11/2026 trên shop thử (chỉ đọc): lọc `ReverseOrderLineModifiedTimeRangeStart` (ms) chạy, 26 yêu cầu sửa trong
// 60 ngày; lịch sử chỉ có `time` (ms), `operator`, `picture`; lý do có `reason_id`, `muti_language_text`, `text`.
// Chưa gọi thao tác ghi trên sàn thật (không chắc đơn nào của shop thử dùng chung là của nhóm).
import { logger } from '../../../../../shared/logger.ts';
import { type MarketplaceAdapter, MarketplaceError, type RemoteAftersaleLine, type RemoteReturn, type RemoteReturnStatus } from './common.ts';

type Row = Record<string, unknown>;
type Call = (apiPath: string, params: Record<string, string>) => Promise<Row>;

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const opt = (v: unknown) => str(v).trim() || null;
/** Trang 100 (gọi thật nhận; tài liệu chỉ ghi mặc định 10). */
const PAGE_SIZE = 100;

/** Thứ tự "còn phải làm": yêu cầu nhiều món lệch trạng thái thì lấy món ít tiến nhất. */
const RANK: readonly RemoteReturnStatus[] = ['requested', 'awaiting_return', 'received', 'refund_only', 'rejected', 'closed'];

const delivered = (ofc: string | null) => Boolean(ofc && ofc.includes('DELIVERED') && !ofc.includes('CANCEL'));

/**
 * Trạng thái app của một dòng đơn ngược (`reverse_status`, `ofc_status`). Đoán theo tên và các cặp gặp ở shop thử
 * (REQUEST_CANCEL, REFUND_REJECT, REFUND_SUCCESS kèm RETURN_CANCELED, REFUND_PENDING kèm INFO_ST_RETURN_RTM_DELIVERED);
 * tài liệu không liệt kê giá trị. Giá trị lạ → null (app chỉ cập nhật thông tin sàn).
 */
export function lazadaReturnLineStatus(
  reverseStatus: string,
  ofcStatus: string | null,
  kind: RemoteReturn['kind'],
): { status: RemoteReturnStatus; closeResult: 'buyer_cancelled' | null } | null {
  const s = (status: RemoteReturnStatus) => ({ status, closeResult: null });
  switch (reverseStatus) {
    case 'REQUEST_INITIATE':
      return s('requested');
    case 'REQUEST_REJECT':
    case 'REFUND_REJECT':
      return s('rejected');
    case 'REQUEST_CANCEL':
    case 'CANCEL_SUCCESS':
      return { status: 'closed', closeResult: 'buyer_cancelled' };
    case 'REFUND_PENDING':
      // Chỉ hoàn tiền: chờ người bán đồng ý hoàn; trả hàng: đã đồng ý, hàng đang về (về tới người bán vẫn chờ kho quét).
      if (kind === 'refund') return s('requested');
      return s(delivered(ofcStatus) ? 'received' : 'awaiting_return');
    case 'REFUND_SUCCESS':
      return s(kind === 'return' && delivered(ofcStatus) ? 'received' : 'refund_only');
    default:
      return null;
  }
}

const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))];

/** Một đơn ngược của `/reverse/getreverseordersforseller` → `RemoteReturn`. Loại `CANCEL` là huỷ đơn, bên gọi bỏ. */
export function toLazadaReturn(item: Row): RemoteReturn {
  const lines = ((item.reverse_order_lines ?? []) as Row[]).filter((l) => l && typeof l === 'object');
  const kind: RemoteReturn['kind'] = str(item.request_type) === 'ONLY_REFUND' ? 'refund' : 'return';
  const statuses = lines.map((l) => lazadaReturnLineStatus(str(l.reverse_status), opt(l.ofc_status), kind));
  const known = statuses.filter((x) => x !== null);
  const pick = known.sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status))[0] ?? null;
  // Có món còn trạng thái lạ thì không đổi trạng thái app (chưa hiểu hết).
  const status = statuses.includes(null) ? null : pick;
  const refunds = lines.map((l) => (l.refund_amount === undefined || l.refund_amount === null ? null : Number(l.refund_amount)));
  const times = (key: string) => lines.map((l) => Number(l[key]) || 0);
  const returnToType = str(item.return_to_type);
  return {
    externalId: str(item.reverse_order_id),
    externalOrderId: str(item.trade_order_id),
    rawStatus: unique(lines.map((l) => opt(l.reverse_status))).join(','),
    ofcStatus: unique(lines.map((l) => opt(l.ofc_status))).join(',') || null,
    initiator: 'buyer',
    reasonCode: opt(lines[0]?.reason_code),
    reason: opt(lines[0]?.reason_text),
    refundAmount: refunds.every((r) => r === null || Number.isNaN(r)) ? null : String(refunds.reduce<number>((s, r) => s + (r && !Number.isNaN(r) ? r : 0), 0)),
    lines: lines.map(
      (l): RemoteAftersaleLine => ({
        externalLineId: str(l.trade_order_line_id),
        externalReturnLineId: opt(l.reverse_order_line_id),
        externalSkuId: opt(l.platform_sku_id),
        sellerSku: opt(l.seller_sku_id),
        refundAmount: opt(l.refund_amount),
        quantity: 1,
      }),
    ),
    createdAt: new Date(Math.min(...times('return_order_line_gmt_create')) * 1000),
    updatedAt: new Date(Math.max(...times('return_order_line_gmt_modified'), ...times('return_order_line_gmt_create')) * 1000),
    kind,
    status: status?.status ?? null,
    closeResult: status?.closeResult ?? null,
    disputeInProgress: lines.some((l) => l.is_dispute === true),
    returnTrackingCode: unique(lines.map((l) => opt(l.tracking_number)))[0] ?? null,
    respondBy: null,
    returnTo: returnToType === 'RTW' ? 'warehouse' : returnToType === 'RTM' ? 'merchant' : item.is_rtm === true ? 'merchant' : item.is_rtm === false ? 'warehouse' : null,
  };
}

const idList = (ids: readonly string[]) => `[${ids.join(',')}]`;

export function lazadaReturnMethods(
  call: Call,
): Pick<Required<MarketplaceAdapter>, 'listReturns' | 'returnReasons' | 'decideReturn' | 'confirmReturnReceived' | 'returnHistory'> {
  /** Mã dòng đơn ngược đầu của yêu cầu (lý do, lịch sử theo dòng). */
  async function firstLineId(accessToken: string, reverseOrderId: string): Promise<string> {
    const body = await call('/reverse/getreverseordersforseller', { access_token: accessToken, reverse_order_id: reverseOrderId, page_no: '1', page_size: '10' });
    const item = ((body.result as { items?: Row[] } | undefined)?.items ?? []).find((i) => str(i.reverse_order_id) === reverseOrderId);
    const id = str(((item?.reverse_order_lines ?? []) as Row[])[0]?.reverse_order_line_id);
    if (!id) throw new MarketplaceError('rejected', 'return_not_found', 'Sàn không còn yêu cầu trả này');
    return id;
  }

  async function update(accessToken: string, action: string, reverseOrderId: string, lineIds: readonly string[], extra: Record<string, string> = {}) {
    if (!lineIds.length) throw new MarketplaceError('rejected', 'return_lines_missing', 'Yêu cầu trả chưa có mã dòng của sàn');
    await call('/order/reverse/return/update', {
      access_token: accessToken,
      action,
      reverse_order_id: reverseOrderId,
      reverse_order_item_ids: idList(lineIds),
      ...extra,
    });
  }

  /**
   * Yêu cầu chỉ hoàn tiền (ReverseOrderOnlyRefundDecide, `/order/reverse/onlyrefund/seller/decide`, đọc 12/11/2026):
   * `action` agreeRefund hoặc startDispute; `reverse_order_item_ids` mỗi lần một dòng; startDispute bắt buộc `comment` và
   * `image_info_list` (E0109, E0110). App chưa lưu ảnh (#212) nên chưa gửi ảnh: sàn sẽ từ chối tới khi có.
   */
  async function decideOnlyRefund(accessToken: string, reverseOrderId: string, lineIds: readonly string[], decision: 'accept' | 'reject' | 'refund', comment?: string) {
    if (decision === 'accept') throw new MarketplaceError('rejected', 'refund_only_request', 'Yêu cầu chỉ hoàn tiền không có bước đồng ý trả hàng');
    if (!lineIds.length) throw new MarketplaceError('rejected', 'return_lines_missing', 'Yêu cầu trả chưa có mã dòng của sàn');
    const action = decision === 'refund' ? 'agreeRefund' : 'startDispute';
    for (const lineId of lineIds) {
      await call('/order/reverse/onlyrefund/seller/decide', {
        access_token: accessToken,
        action,
        reverse_order_id: reverseOrderId,
        reverse_order_item_ids: idList([lineId]),
        ...(action === 'startDispute' && { comment: comment || 'Người bán không đồng ý hoàn tiền' }),
      });
    }
  }

  return {
    async listReturns(accessToken, updatedAfter, cursor) {
      const page = Number(cursor ?? '1');
      const body = await call('/reverse/getreverseordersforseller', {
        access_token: accessToken,
        page_no: String(page),
        page_size: String(PAGE_SIZE),
        ReverseOrderLineModifiedTimeRangeStart: String(updatedAfter.getTime()),
      });
      const items = (body.result as { items?: Row[] } | undefined)?.items ?? [];
      // Đơn ngược không có dòng (không thấy ở shop thử, phòng sàn trả thiếu): không có món, không có mốc thời gian, bỏ qua.
      const empty = items.filter((i) => !Array.isArray(i.reverse_order_lines) || !i.reverse_order_lines.length);
      if (empty.length) logger.warn({ reverseOrderIds: empty.map((i) => str(i.reverse_order_id)) }, 'Lazada trả đơn ngược không có dòng, bỏ qua');
      return {
        items: items.filter((i) => str(i.request_type) !== 'CANCEL' && !empty.includes(i)).map(toLazadaReturn),
        nextCursor: items.length < PAGE_SIZE ? null : String(page + 1),
      };
    },
    async returnReasons(accessToken, externalReturnId, action) {
      const lineId = await firstLineId(accessToken, externalReturnId);
      const body = await call('/order/reverse/reason/list', { access_token: accessToken, reverse_order_line_id: lineId });
      return ((body.data ?? []) as Row[]).map((r) => ({
        id: str(r.reason_id),
        label: opt(r.muti_language_text) ?? str(r.text),
        // E0110: từ chối hoàn tiền bắt buộc ảnh.
        requiresImage: action === 'refuse-refund',
      }));
    },
    async decideReturn(accessToken, externalReturnId, externalLineIds, decision, opts) {
      if (opts.kind === 'refund') return decideOnlyRefund(accessToken, externalReturnId, externalLineIds, decision, opts.comment);
      if (decision === 'accept') return update(accessToken, 'agreeReturn', externalReturnId, externalLineIds);
      if (decision === 'refund') return update(accessToken, 'instantRefund', externalReturnId, externalLineIds);
      if (!opts.reasonId) throw new MarketplaceError('rejected', 'reject_reason_required', 'Từ chối cần lý do của sàn');
      // E0109 bắt buộc `comment`; E0111 không từ chối nhiều dòng một lần.
      const extra = { reason_id: opts.reasonId, comment: opts.comment || 'Người bán từ chối yêu cầu trả' };
      for (const lineId of externalLineIds) await update(accessToken, 'refuseReturn', externalReturnId, [lineId], extra);
    },
    async confirmReturnReceived(accessToken, externalReturnId, externalLineIds) {
      await update(accessToken, 'confirmDelivery', externalReturnId, externalLineIds);
    },
    async returnHistory(accessToken, externalReturnId, externalLineIds) {
      const lineId = externalLineIds[0] ?? (await firstLineId(accessToken, externalReturnId));
      const body = await call('/order/reverse/return/history/list', { access_token: accessToken, reverse_order_line_id: lineId, page_size: '50', page_number: '1' });
      const list = ((body.data as { list?: Row[] } | undefined)?.list ?? []) as Row[];
      // Sàn không trả trạng thái trong lịch sử: `reverseStatus` rỗng, `note` là người thao tác và số ảnh đính kèm.
      return list
        .map((h) => {
          const pictures = Array.isArray(h.picture) ? h.picture.length : 0;
          return {
            at: new Date(Number(h.time) || 0),
            reverseStatus: '',
            ofcStatus: null,
            note: [opt(h.operator), pictures ? `${pictures} ảnh` : null].filter(Boolean).join(' · ') || null,
          };
        })
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    },
  };
}
