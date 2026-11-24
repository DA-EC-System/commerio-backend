// Yêu cầu trả Lazada (#202): kéo đơn ngược, lý do từ chối, quyết định của người bán, báo đã nhận, lịch sử.
// Nguồn (open.lazada.com, mục Return and Refund API, đọc 12/11/2026): GetReverseOrdersForSeller
// (`/reverse/getreverseordersforseller`), GetReverseOrderReasonList (`/order/reverse/reason/list`), ReverseOrderReturnUpdate
// (`/order/reverse/return/update`, `action` ∈ instantRefund, agreeReturn, refuseReturn, agreeRefund, refuseRefund,
// confirmDelivery), GetReverseOrderHistoryList (`/order/reverse/return/history/list`), ReverseOrderOnlyRefundDecide
// (`/order/reverse/onlyrefund/seller/decide`, `action` agreeRefund, startDispute).
// ReverseOrderReturnUpdate đọc lại 24/11/2026: mã lỗi E0108 (từ chối cần lý do), E0109 (cần comment), E0110 (từ chối hoàn
// tiền cần ảnh), E0111 (không từ chối nhiều dòng một lần), E0114 (đơn ngược không nhận thao tác này); luồng người bán
// (docId 121061 §3.2.4–3.2.6): nhận hàng (`confirmDelivery`) → kiểm hàng → `agreeRefund` hoặc `refuseRefund` → sàn hoàn.
// Gọi thật 12/11/2026 trên shop thử (chỉ đọc): lọc `ReverseOrderLineModifiedTimeRangeStart` (ms) chạy, 26 yêu cầu sửa trong
// 60 ngày; lịch sử chỉ có `time` (ms), `operator`, `picture`; lý do có `reason_id`, `muti_language_text`, `text`.
// Chưa gọi thao tác ghi trên sàn thật (không chắc đơn nào của shop thử dùng chung là của nhóm).
import { Decimal } from 'decimal.js';
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
 * Trạng thái app của một dòng đơn ngược (`reverse_status`, `ofc_status`). Tài liệu Lazada (GetReverseOrdersForSeller,
 * GetReverseOrderDetail, đọc 20/11/2026) không liệt kê giá trị của hai trường này: ánh xạ dựa trên các cặp gặp thật ở shop
 * thử (bảng ở commerio-backend#436, ca test 18/11/2026). Giá trị lạ → null; `toLazadaReturn` ghi cảnh báo.
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
    // SELLER_REJECT_RETURN: người bán từ chối trên Seller Center (#436).
    case 'REQUEST_REJECT':
    case 'REFUND_REJECT':
    case 'SELLER_REJECT_RETURN':
      return s('rejected');
    // Người bán đã đồng ý trả (trong app hay trên Seller Center), chờ khách gửi hàng (#436).
    case 'SELLER_AGREE_RETURN':
      return s('awaiting_return');
    // Khách đã gửi hàng: về tới người bán vẫn chờ kho quét (#436). Chiều về bị huỷ (`RETURN_CANCELED`): chưa quan sát được
    // ai huỷ nên chưa ánh xạ (null, cần người xem Seller Center); khi thấy dữ liệu thật mà người mua huỷ thì sang
    // `closed`/`buyer_cancelled`.
    case 'BUYER_RETURN_ITEM':
      if (ofcStatus?.includes('CANCEL')) return null;
      return s(delivered(ofcStatus) ? 'received' : 'awaiting_return');
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

/**
 * Sàn xác nhận hoàn tiền sau khi hàng về người bán (#437): yêu cầu trả hàng, mọi món `REFUND_PENDING` (người bán đồng ý
 * hoàn) hoặc `REFUND_SUCCESS`, chiều về đã giao tới người bán. Hoàn ngay khi hàng còn đang về (`instantRefund`) không tính:
 * đó là bước `refund_only`.
 */
function refundConfirmedOf(lines: readonly Row[], kind: RemoteReturn['kind']): boolean {
  if (kind !== 'return' || !lines.length) return false;
  return lines.every((l) => (l.reverse_status === 'REFUND_PENDING' || l.reverse_status === 'REFUND_SUCCESS') && delivered(opt(l.ofc_status)));
}

/** Hạn người bán phải trả lời: `sla` (ms) sớm nhất của các dòng, chỉ khi yêu cầu còn chờ người bán (#436). */
function respondByOf(lines: readonly Row[], status: RemoteReturnStatus | null): Date | null {
  if (status !== 'requested') return null;
  const slas = lines.map((l) => Number(l.sla)).filter((n) => Number.isFinite(n) && n > 0);
  return slas.length ? new Date(Math.min(...slas)) : null;
}

const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))];

/**
 * Bộ đọc số tiền Lazada (`lazadaAmount` ở `lazada.ts`, #349), truyền vào vì `lazada.ts` import file này (không vòng).
 * Ném `MarketplaceError` khi không đọc được; vắng thì `"0"`.
 */
export type LazadaAmountReader = (raw: unknown, where: string) => string;

/** Một đơn ngược của `/reverse/getreverseordersforseller` → `RemoteReturn`. Loại `CANCEL` là huỷ đơn, bên gọi bỏ. */
export function toLazadaReturn(item: Row, amount: LazadaAmountReader): RemoteReturn {
  const lines = ((item.reverse_order_lines ?? []) as Row[]).filter((l) => l && typeof l === 'object');
  const kind: RemoteReturn['kind'] = str(item.request_type) === 'ONLY_REFUND' ? 'refund' : 'return';
  const statuses = lines.map((l) => lazadaReturnLineStatus(str(l.reverse_status), opt(l.ofc_status), kind));
  const known = statuses.filter((x) => x !== null);
  const pick = known.sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status))[0] ?? null;
  // Có món còn trạng thái lạ thì không đổi trạng thái app (chưa hiểu hết).
  const status = statuses.includes(null) ? null : pick;
  if (statuses.includes(null)) {
    const unknown = unique(lines.filter((_, i) => statuses[i] === null).map((l) => opt(l.reverse_status)));
    logger.warn({ reverseOrderId: str(item.reverse_order_id), reverseStatus: unknown }, 'Lazada: reverse_status chưa có trong ánh xạ (#436)');
  }
  // `refund_amount` có thể là số JSON hay chuỗi có dấu phẩy nghìn: đọc như tiền quyết toán. Món không đọc được thì tổng
  // null (app giữ số tính từ dòng) và trả chuỗi gốc để yêu cầu bật Cần xử lý, không ghi 0.
  const unreadable: string[] = [];
  const refunds = lines.map((l) => {
    if (l.refund_amount === undefined || l.refund_amount === null || l.refund_amount === '') return null;
    try {
      return amount(l.refund_amount, `refund_amount đơn ngược ${str(item.reverse_order_id)}`);
    } catch {
      unreadable.push(String(l.refund_amount));
      return null;
    }
  });
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
    refundAmount: unreadable.length || refunds.every((r) => r === null) ? null : refunds.reduce((s, r) => s.plus(r ?? 0), new Decimal(0)).toString(),
    refundAmountUnreadable: unreadable.length ? unique(unreadable).join(', ') : null,
    lines: lines.map(
      (l, i): RemoteAftersaleLine => ({
        externalLineId: str(l.trade_order_line_id),
        externalReturnLineId: opt(l.reverse_order_line_id),
        externalSkuId: opt(l.platform_sku_id),
        sellerSku: opt(l.seller_sku_id),
        refundAmount: refunds[i] ?? null,
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
    respondBy: respondByOf(lines, status?.status ?? null),
    refundConfirmed: refundConfirmedOf(lines, kind),
    returnTo: returnToType === 'RTW' ? 'warehouse' : returnToType === 'RTM' ? 'merchant' : item.is_rtm === true ? 'merchant' : item.is_rtm === false ? 'warehouse' : null,
  };
}

const idList = (ids: readonly string[]) => `[${ids.join(',')}]`;

/** Đơn ngược đã qua bước quyết hoàn tiền: gọi `agreeRefund` lại thì sàn từ chối, không phải lỗi. */
/** Dòng đã được đồng ý hoàn tiền (người bán làm trên Seller Center, hay lệnh trước đã tới sàn). */
const REFUND_AGREED = new Set(['REFUND_PENDING', 'REFUND_SUCCESS']);
/** Dòng đã bị từ chối hoàn tiền hoặc huỷ trên sàn: app không coi là đã đồng ý (review #583). */
const REFUND_STOPPED = new Set(['REFUND_REJECT', 'REQUEST_CANCEL', 'CANCEL_SUCCESS']);

/** E0114 "this reverse does not support this action" (bảng mã của ReverseOrderReturnUpdate). Dạng mã trần `114` chưa đo, nhận phòng khi sàn bỏ tiền tố. */
const isE0114 = (err: MarketplaceError) => err.platformCode === '114' || err.platformCode === 'E0114' || Boolean(err.platformMessage?.includes('E0114'));

/**
 * Lỗi của `/order/reverse/return/update` cho người dùng (#437, LZ-TRA-U05). Mã 6 ("Unexpected internal error", ngoài bảng
 * mã của API này) khi từ chối là sàn không nhận lệnh, không phải lỗi tạm: báo `rejected`, không bảo thử lại. Mã 6 của API
 * khác vẫn là lỗi tạm (`TRANSIENT_CODES` ở `lazada.ts`). E0114: yêu cầu đã được xử lý trên sàn.
 */
function returnUpdateError(err: MarketplaceError, action: string, withImages: boolean): MarketplaceError {
  const refuse = action === 'refuseReturn' || action === 'refuseRefund';
  let message: string | null = null;
  if (refuse && err.platformCode === '6') {
    message = withImages
      ? 'Lazada không nhận lệnh từ chối (mã 6). Kiểm yêu cầu trên Seller Center trước khi thử lại'
      : 'Lazada không nhận lệnh từ chối, cần ít nhất 1 ảnh bằng chứng';
  } else if (isE0114(err)) {
    message = 'Yêu cầu này đã được xử lý trên Lazada. Tải lại để xem trạng thái mới';
  }
  if (!message) return err;
  const out = new MarketplaceError('rejected', err.platformCode, err.platformMessage);
  out.requestId = err.requestId;
  out.details = err.details;
  out.userMessage = message;
  return out;
}

type Image = { name: string; url: string };

export function lazadaReturnMethods(
  call: Call,
  amount: LazadaAmountReader,
): Pick<
  Required<MarketplaceAdapter>,
  'listReturns' | 'returnReasons' | 'decideReturn' | 'confirmReturnReceived' | 'approveReturnRefund' | 'returnHistory'
> {
  /** Mã dòng đơn ngược đầu của yêu cầu (lý do, lịch sử theo dòng). */
  async function firstLineId(accessToken: string, reverseOrderId: string): Promise<string> {
    const item = await reverseOrder(accessToken, reverseOrderId);
    const id = str(((item?.reverse_order_lines ?? []) as Row[])[0]?.reverse_order_line_id);
    if (!id) throw new MarketplaceError('rejected', 'return_not_found', 'Sàn không còn yêu cầu trả này');
    return id;
  }

  /** Đơn ngược theo mã (`reverse_order_id`); không còn thì null. */
  async function reverseOrder(accessToken: string, reverseOrderId: string): Promise<Row | null> {
    const body = await call('/reverse/getreverseordersforseller', { access_token: accessToken, reverse_order_id: reverseOrderId, page_no: '1', page_size: '10' });
    return ((body.result as { items?: Row[] } | undefined)?.items ?? []).find((i) => str(i.reverse_order_id) === reverseOrderId) ?? null;
  }

  async function update(accessToken: string, action: string, reverseOrderId: string, lineIds: readonly string[], extra: Record<string, string> = {}) {
    if (!lineIds.length) throw new MarketplaceError('rejected', 'return_lines_missing', 'Yêu cầu trả chưa có mã dòng của sàn');
    try {
      await call('/order/reverse/return/update', {
        access_token: accessToken,
        action,
        reverse_order_id: reverseOrderId,
        reverse_order_item_ids: idList(lineIds),
        ...extra,
      });
    } catch (err) {
      throw err instanceof MarketplaceError ? returnUpdateError(err, action, Boolean(extra.image_info)) : err;
    }
  }

  /**
   * Yêu cầu chỉ hoàn tiền (ReverseOrderOnlyRefundDecide, `/order/reverse/onlyrefund/seller/decide`, đọc 12/11/2026):
   * `action` agreeRefund hoặc startDispute; `reverse_order_item_ids` mỗi lần một dòng; startDispute bắt buộc `comment` và
   * `image_info_list` (E0109, E0110), mẫu `[{"file_url","file_name"}]` (đọc 20/11/2026). Ảnh là URL trên Lazada
   * (`/image/migrate`, #437).
   */
  async function decideOnlyRefund(
    accessToken: string,
    reverseOrderId: string,
    lineIds: readonly string[],
    decision: 'accept' | 'reject' | 'refund',
    comment?: string,
    images: readonly Image[] = [],
  ) {
    if (decision === 'accept') throw new MarketplaceError('rejected', 'refund_only_request', 'Yêu cầu chỉ hoàn tiền không có bước đồng ý trả hàng');
    if (!lineIds.length) throw new MarketplaceError('rejected', 'return_lines_missing', 'Yêu cầu trả chưa có mã dòng của sàn');
    const action = decision === 'refund' ? 'agreeRefund' : 'startDispute';
    for (const lineId of lineIds) {
      await call('/order/reverse/onlyrefund/seller/decide', {
        access_token: accessToken,
        action,
        reverse_order_id: reverseOrderId,
        reverse_order_item_ids: idList([lineId]),
        ...(action === 'startDispute' && {
          comment: comment || 'Người bán không đồng ý hoàn tiền',
          ...(images.length && { image_info_list: JSON.stringify(images.map((i) => ({ file_url: i.url, file_name: i.name }))) }),
        }),
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
        items: items.filter((i) => str(i.request_type) !== 'CANCEL' && !empty.includes(i)).map((i) => toLazadaReturn(i, amount)),
        nextCursor: items.length < PAGE_SIZE ? null : String(page + 1),
      };
    },
    async returnReasons(accessToken, externalReturnId, _action) {
      const lineId = await firstLineId(accessToken, externalReturnId);
      const body = await call('/order/reverse/reason/list', { access_token: accessToken, reverse_order_line_id: lineId });
      return ((body.data ?? []) as Row[]).map((r) => ({
        id: str(r.reason_id),
        label: opt(r.muti_language_text) ?? str(r.text),
        // E0110: từ chối hoàn tiền bắt buộc ảnh. Từ chối trả hàng: tài liệu ghi ảnh tuỳ chọn, nhưng gọi thật 18/11/2026
        // (YCT-000032, LZ-TRA-B03) không ảnh thì sàn trả mã 6, kèm ảnh thì nhận (#437, LZ-TRA-U06).
        requiresImage: true,
      }));
    },
    async decideReturn(accessToken, externalReturnId, externalLineIds, decision, opts) {
      if (opts.kind === 'refund') return decideOnlyRefund(accessToken, externalReturnId, externalLineIds, decision, opts.comment, opts.images);
      if (decision === 'accept') return update(accessToken, 'agreeReturn', externalReturnId, externalLineIds);
      if (decision === 'refund') return update(accessToken, 'instantRefund', externalReturnId, externalLineIds);
      if (!opts.reasonId) throw new MarketplaceError('rejected', 'reject_reason_required', 'Từ chối cần lý do của sàn');
      // E0109 bắt buộc `comment`; E0111 không từ chối nhiều dòng một lần.
      // `image_info` mẫu `[{"name","url"}]` (đọc 20/11/2026), URL trên Lazada (`/image/migrate`, #437).
      const extra = {
        reason_id: opts.reasonId,
        comment: opts.comment || 'Người bán từ chối yêu cầu trả',
        ...(opts.images?.length && { image_info: JSON.stringify(opts.images.map((i) => ({ name: i.name, url: i.url }))) }),
      };
      for (const lineId of externalLineIds) await update(accessToken, 'refuseReturn', externalReturnId, [lineId], extra);
    },
    async confirmReturnReceived(accessToken, externalReturnId, externalLineIds) {
      await update(accessToken, 'confirmDelivery', externalReturnId, externalLineIds);
    },
    async approveReturnRefund(accessToken, externalReturnId, externalLineIds) {
      // Sau phiếu kiểm hàng hoàn ghi sổ (#437): người bán đồng ý hoàn tiền mọi món của yêu cầu. Sàn từ chối vì đơn ngược đã
      // qua bước này thì đọc lại: mọi dòng đã đồng ý hoàn tiền là xong; dòng bị từ chối, huỷ thì báo lỗi để yêu cầu bật Cần xử lý.
      try {
        await update(accessToken, 'agreeRefund', externalReturnId, externalLineIds);
      } catch (err) {
        if (!(err instanceof MarketplaceError) || err.kind !== 'rejected') throw err;
        const item = await reverseOrder(accessToken, externalReturnId).catch(() => null);
        const lines = ((item?.reverse_order_lines ?? []) as Row[]).filter((l) => l && typeof l === 'object');
        if (lines.length && lines.every((l) => REFUND_AGREED.has(str(l.reverse_status)))) return;
        if (lines.some((l) => REFUND_STOPPED.has(str(l.reverse_status)))) {
          const stopped = new MarketplaceError('rejected', err.platformCode ?? 'refund_stopped', err.platformMessage ?? 'refund rejected or cancelled');
          stopped.userMessage = 'Lazada đã từ chối hoặc huỷ hoàn tiền yêu cầu này, kiểm trên Seller Center';
          throw stopped;
        }
        throw err;
      }
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
