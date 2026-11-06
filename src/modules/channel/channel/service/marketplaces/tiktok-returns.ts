// Huỷ đơn và trả hàng TikTok Shop (#227): lý do huỷ, người bán huỷ, trả lời khách xin huỷ, kéo yêu cầu trả và lần huỷ.
// Gọi sàn qua `client.call` của `tiktok-client.ts`; nghiệp vụ yêu cầu trả (máy trạng thái) là của #202.
// Nguồn (docv2, tra 07/11/2026; bản mới nhất trên docv2 ngày đó, OAS cục bộ của skill `tts-openapi-guide` còn 202309):
// - Return, refund, and cancel API overview: https://partner.tiktokshop.com/docv2/page/return-refund-and-cancel-api-overview
// - Cancel reasons: https://partner.tiktokshop.com/docv2/page/cancel-reasons
// - get-aftersale-eligibility-202602, cancel-order-202602, search-cancellations-202602, search-returns-202602,
//   approve-cancellation-202309, reject-cancellation-202309, get-decision-eligibility-202601
// Dạng phản hồi đối chiếu gọi thật trên shop thử VN ngày 07/11/2026 (`npm run smoke:tiktok -- returns|cancellations|cancel-reasons`).
import {
  type MarketplaceAdapter,
  MarketplaceError,
  type RemoteAftersaleLine,
  type RemoteCancellation,
  type RemoteReturn,
  type RemoteReturnStatus,
} from './common.ts';
import type { TiktokClient } from './tiktok-client.ts';

type Row = Record<string, unknown>;

const ELIGIBILITY = (orderId: string) => `/return_refund/202602/orders/${encodeURIComponent(orderId)}/aftersale_eligibility`;
const CANCEL_ORDER = '/return_refund/202602/cancellations';
const SEARCH_CANCELLATIONS = '/return_refund/202602/cancellations/search';
const SEARCH_RETURNS = '/return_refund/202602/returns/search';
const DECISION_ELIGIBILITY = '/return_refund/202601/decision_eligibility';
const cancellationAction = (cancelId: string, action: 'approve' | 'reject') =>
  `/return_refund/202309/cancellations/${encodeURIComponent(cancelId)}/${action}`;

/** `page_size` tối đa 50 cho cả Search Returns (10–50) và Search Cancellations (1–50). */
const PAGE_SIZE = 50;

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const opt = (v: unknown) => str(v) || null;
const unixDate = (v: unknown) => new Date((Number(v) || 0) * 1000);

/**
 * Tên tiếng Việt cho lý do người bán huỷ (trang Cancel reasons chỉ có tên máy và câu tiếng Anh; Get Aftersale Eligibility
 * chỉ trả tên máy). Khớp theo phần lõi của tên, bỏ tiền tố `seller_cancel_[unpaid_|paid_]reason_` và hậu tố thị trường
 * (`_uk`). Tên lạ thì hiện nguyên tên máy.
 */
const CANCEL_REASON_LABELS: Readonly<Record<string, string>> = {
  out_of_stock: 'Hết hàng',
  wrong_price: 'Sai giá',
  unable_to_fulfill_order: 'Không thể giao đơn',
  address_not_deliver: 'Không giao được tới địa chỉ người mua',
  buyer_hasnt_paid_within_time_allowed: 'Người mua chưa thanh toán đúng hạn',
  buyer_requested_cancellation: 'Người mua yêu cầu huỷ',
};

export function tiktokCancelReasonLabel(name: string): string {
  const core = name.replace(/^seller_cancel_(?:unpaid_|paid_)?reason_/, '').replace(/_uk$/, '');
  return CANCEL_REASON_LABELS[core] ?? name;
}

const INITIATOR: Readonly<Record<string, RemoteReturn['initiator']>> = { BUYER: 'buyer', SELLER: 'seller', SYSTEM: 'platform', OPERATOR: 'platform' };

/**
 * `return_status` + `return_type` của Search Returns → trạng thái yêu cầu trả của app (Documents/25 §9, Documents/21 §20).
 * Bảng đầy đủ kèm lý do ở channel CLAUDE.md mục TikTok. App giữ phần hàng: hàng tới tay người bán thì cao nhất là
 * `received`; đóng sau khi kiểm hàng hoàn do app quyết, không theo sàn.
 */
export function tiktokReturnStatus(
  returnStatus: string,
  returnType: string,
): Pick<RemoteReturn, 'kind' | 'status' | 'closeResult'> {
  const kind: RemoteReturn['kind'] = returnType === 'REFUND' ? 'refund' : returnType === 'RETURN_AND_REFUND' ? 'return' : 'replacement';
  // Đổi hàng (`REPLACEMENT`, `EXCHANGE`): app chưa có luồng.
  if (kind === 'replacement') return { kind, status: null, closeResult: null };
  const status = ((): RemoteReturnStatus | 'buyer_cancelled' | null => {
    switch (returnStatus) {
      // AWAITING_BUYER_RESPONSE: người bán đề nghị cách khác (hoàn một phần), chờ khách trả lời: vẫn là yêu cầu chưa chốt.
      case 'RETURN_OR_REFUND_REQUEST_PENDING':
      case 'AWAITING_BUYER_RESPONSE':
        return 'requested';
      case 'REFUND_OR_RETURN_REQUEST_REJECT':
        return 'rejected';
      // BUYER_SHIPPED_ITEM: khách đã gửi, hàng đang về; app sang `received` khi kho quét nhận.
      case 'AWAITING_BUYER_SHIP':
      case 'BUYER_SHIPPED_ITEM':
        return kind === 'refund' ? null : 'awaiting_return';
      // Người bán kiểm hàng về rồi từ chối hoàn tiền: hàng đã ở kho.
      case 'REJECT_RECEIVE_PACKAGE':
        return kind === 'refund' ? null : 'received';
      case 'RETURN_OR_REFUND_REQUEST_SUCCESS':
      case 'RETURN_OR_REFUND_REQUEST_COMPLETE':
        return kind === 'refund' ? 'refund_only' : 'received';
      // Khách rút, quá hạn gửi hàng, hoặc sàn đóng (kể cả sau khi người bán thắng khiếu nại).
      case 'RETURN_OR_REFUND_REQUEST_CANCEL':
        return 'buyer_cancelled';
      default:
        return null;
    }
  })();
  if (status === 'buyer_cancelled') return { kind, status: 'closed', closeResult: 'buyer_cancelled' };
  return { kind, status, closeResult: null };
}

/**
 * `cancel_status` của Search Cancellations → trạng thái lần huỷ. Docv2 ghi cả `CANCELLATION_REQUEST_CANCEL` (bộ lọc) lẫn
 * `CANCELLATION_REQUEST_CANCELLED` (phản hồi) cho khách rút hay người bán từ chối: nhận cả hai.
 */
export function tiktokCancellationStatus(cancelStatus: string): RemoteCancellation['status'] {
  switch (cancelStatus) {
    case 'CANCELLATION_REQUEST_PENDING':
      return 'pending';
    case 'CANCELLATION_REQUEST_SUCCESS':
    case 'CANCELLATION_REQUEST_COMPLETE':
      return 'cancelled';
    case 'CANCELLATION_REQUEST_CANCEL':
    case 'CANCELLATION_REQUEST_CANCELLED':
      return 'withdrawn';
    default:
      return null;
  }
}

const refundTotal = (v: unknown) => opt((v as Row | undefined)?.refund_total);

function lineOf(l: Row): RemoteAftersaleLine {
  return { externalLineId: str(l.order_line_item_id), externalSkuId: opt(l.sku_id), sellerSku: opt(l.seller_sku), refundAmount: refundTotal(l.refund_amount) };
}

/** Hạn người bán phải trả lời: `deadline` nhỏ nhất của `seller_next_action_response`. */
function respondBy(r: Row): Date | null {
  const deadlines = ((r.seller_next_action_response ?? []) as Row[]).map((a) => Number(a.deadline)).filter((d) => d > 0);
  return deadlines.length ? new Date(Math.min(...deadlines) * 1000) : null;
}

export function toRemoteReturn(r: Row): RemoteReturn {
  const rawStatus = str(r.return_status);
  return {
    externalId: str(r.return_id),
    externalOrderId: str(r.order_id),
    rawStatus,
    ...tiktokReturnStatus(rawStatus, str(r.return_type)),
    initiator: INITIATOR[str(r.role)] ?? null,
    reasonCode: opt(r.return_reason),
    reason: opt(r.return_reason_text) ?? opt(r.return_reason),
    refundAmount: refundTotal(r.refund_amount),
    lines: ((r.return_line_items ?? []) as Row[]).map(lineOf),
    disputeInProgress: r.arbitration_status === 'IN_PROGRESS',
    returnTrackingCode: opt(r.return_tracking_number),
    respondBy: respondBy(r),
    createdAt: unixDate(r.create_time),
    updatedAt: unixDate(r.update_time),
  };
}

export function toRemoteCancellation(c: Row): RemoteCancellation {
  const rawStatus = str(c.cancel_status);
  return {
    externalId: str(c.cancel_id),
    externalOrderId: str(c.order_id),
    rawStatus,
    status: tiktokCancellationStatus(rawStatus),
    buyerRequest: c.cancel_type === 'BUYER_CANCEL',
    initiator: INITIATOR[str(c.role)] ?? null,
    reasonCode: opt(c.cancel_reason),
    reason: opt(c.cancel_reason_text) ?? opt(c.cancel_reason),
    refundAmount: refundTotal(c.refund_amount),
    lines: ((c.cancel_line_items ?? []) as Row[]).map(lineOf),
    respondBy: respondBy(c),
    createdAt: unixDate(c.create_time),
    updatedAt: unixDate(c.update_time),
  };
}

export function tiktokReturnMethods(
  client: TiktokClient,
): Pick<
  MarketplaceAdapter,
  'cancelReasons' | 'cancelOrder' | 'decideCancelRequest' | 'cancelRequestRejectReasons' | 'listReturns' | 'listCancellations'
> {
  /**
   * Người bán huỷ được những món nào và với lý do gì (Get Aftersale Eligibility, `SELLER`, `CANCEL`). Trả mọi món huỷ được
   * của đơn kèm lý do chung; món được hỏi mà sàn chặn thì `rejected` kèm câu của sàn (vd 25011050 "seller can't cancel
   * non-cod order after shipped", gọi thật 07/11/2026).
   */
  async function cancelEligibility(token: string, orderId: string, lineIds: readonly string[]) {
    const data = await client.call<{ sku_eligibility?: Row[] }>('GET', ELIGIBILITY(orderId), {
      token,
      query: { initiate_aftersale_user: 'SELLER', request_types: 'CANCEL' },
    });
    const entries = (data?.sku_eligibility ?? []).flatMap((s) => (s.line_item_eligibility ?? []) as Row[]).filter((e) => e.request_type === 'CANCEL');
    const linesOf = (e: Row) => ((e.order_line_items_ids ?? []) as unknown[]).map(str);
    const wanted = new Set(lineIds);
    const asked = (e: Row) => wanted.size === 0 || linesOf(e).some((id) => wanted.has(id));
    const blocked = entries.find((e) => e.eligible !== true && asked(e));
    if (blocked) throw new MarketplaceError('rejected', str(blocked.ineligible_code) || 'not_cancellable', opt(blocked.ineligible_reason));
    const eligible = entries.filter((e) => e.eligible === true);
    // Lý do dùng được cho mọi món được hỏi: giao các danh sách (sàn trả trùng tên trong một danh sách, gọi thật 07/11/2026).
    const reasonSets = eligible.filter(asked).map((e) => new Set(((e.available_reason_names ?? []) as unknown[]).map(str).filter(Boolean)));
    const reasons = reasonSets.length ? [...reasonSets[0]!].filter((n) => reasonSets.every((s) => s.has(n))) : [];
    return { reasons, cancellableLines: new Set(eligible.flatMap(linesOf)) };
  }

  /** Lần huỷ đang chờ người bán của khách trên đơn (Search Cancellations theo `order_ids`). */
  async function pendingBuyerCancel(token: string, orderId: string): Promise<string> {
    const data = await client.call<{ cancellations?: Row[] }>('POST', SEARCH_CANCELLATIONS, {
      token,
      query: { page_size: PAGE_SIZE },
      body: { order_ids: [orderId], cancel_types: ['BUYER_CANCEL'], cancel_status: ['CANCELLATION_REQUEST_PENDING'] },
    });
    const id = str((data?.cancellations ?? []).find((c) => c.cancel_type === 'BUYER_CANCEL' && tiktokCancellationStatus(str(c.cancel_status)) === 'pending')?.cancel_id);
    if (!id) throw new MarketplaceError('rejected', 'cancel_request_not_found', 'Sàn không còn yêu cầu huỷ của đơn này');
    return id;
  }

  /** Lật một API search của return_refund theo `update_time` tăng dần, từ `updatedAfter` (tính cả mốc). */
  async function searchPage(path: string, listKey: string, token: string, updatedAfter: Date, cursor: string | null) {
    const data = await client.call<Row>('POST', path, {
      token,
      query: { page_size: PAGE_SIZE, sort_field: 'update_time', sort_order: 'ASC', page_token: cursor ?? undefined },
      body: { update_time_ge: Math.floor(updatedAfter.getTime() / 1000) },
    });
    const rows = (data?.[listKey] ?? []) as Row[];
    // Sàn trả `next_page_token` khác rỗng cả khi trang này đã đủ (gọi thật 07/11/2026: total_count 1 vẫn có token, trang sau
    // rỗng với token rỗng); dừng khi token rỗng hoặc lặp lại.
    const next = str(data?.next_page_token);
    return { rows, nextCursor: next && next !== cursor ? next : null };
  }

  return {
    async cancelReasons(accessToken, externalOrderId, externalLineIds) {
      const { reasons } = await cancelEligibility(accessToken, externalOrderId, externalLineIds);
      if (!reasons.length) throw new MarketplaceError('rejected', 'not_cancellable', 'Sàn không cho người bán huỷ đơn này lúc này');
      return reasons.map((id) => ({ id, label: tiktokCancelReasonLabel(id) }));
    },
    async cancelOrder(accessToken, externalOrderId, externalLineIds, reasonId) {
      // Huỷ từng món chỉ có ở US, UK (Cancel Order 202602); TikTok VN huỷ cả đơn. Kiểm lại trước khi huỷ để không huỷ cả
      // đơn khi bên gọi chỉ muốn huỷ một phần.
      const { reasons, cancellableLines } = await cancelEligibility(accessToken, externalOrderId, externalLineIds);
      if (externalLineIds.length && [...cancellableLines].some((id) => !externalLineIds.includes(id))) {
        throw new MarketplaceError('rejected', 'partial_cancel_unsupported', 'TikTok chỉ cho người bán huỷ cả đơn, không huỷ từng món');
      }
      if (!reasons.includes(reasonId)) throw new MarketplaceError('rejected', 'cancel_reason_invalid', 'Lý do huỷ không có trong danh sách sàn cho phép');
      await client.call('POST', CANCEL_ORDER, { token: accessToken, body: { order_id: externalOrderId, cancel_reason: reasonId } });
    },
    async decideCancelRequest(accessToken, externalOrderId, accept, rejectReasonId) {
      // Từ chối bắt buộc `reject_reason` (Reject Cancellation 202309): kiểm trước khi gọi để không tốn lượt.
      if (!accept && !rejectReasonId) {
        throw new MarketplaceError('rejected', 'reject_reason_required', 'TikTok bắt buộc chọn lý do khi từ chối yêu cầu huỷ');
      }
      const cancelId = await pendingBuyerCancel(accessToken, externalOrderId);
      await client.call('POST', cancellationAction(cancelId, accept ? 'approve' : 'reject'), {
        token: accessToken,
        // Thử lại cùng quyết định thì sàn nhận là một lần (idempotency_key theo lần huỷ và quyết định). Approve không có body.
        query: { idempotency_key: `commerio-${cancelId}-${accept ? 'approve' : `reject-${rejectReasonId}`}` },
        ...(accept ? {} : { body: { reject_reason: rejectReasonId } }),
      });
    },
    async cancelRequestRejectReasons(accessToken, externalOrderId) {
      const cancelId = await pendingBuyerCancel(accessToken, externalOrderId);
      const data = await client.call<{ decisions?: Row[] }>('GET', DECISION_ELIGIBILITY, {
        token: accessToken,
        query: { return_or_cancel_id: cancelId, check_decisions: 'REJECT_REQUEST_CANCEL', locale: 'vi-VN' },
      });
      const d = (data?.decisions ?? []).find((x) => x.decision === 'REJECT_REQUEST_CANCEL');
      if (!d || d.eligible !== true) {
        throw new MarketplaceError('rejected', str(d?.ineligible_code) || 'not_rejectable', opt(d?.ineligible_reason) ?? 'Sàn không cho từ chối yêu cầu huỷ này');
      }
      return ((d.available_reject_reasons ?? []) as Row[]).map((r) => ({ id: str(r.name), label: str(r.text) || str(r.name) })).filter((r) => r.id);
    },
    async listReturns(accessToken, updatedAfter, cursor) {
      const { rows, nextCursor } = await searchPage(SEARCH_RETURNS, 'return_orders', accessToken, updatedAfter, cursor);
      return { items: rows.map(toRemoteReturn), nextCursor };
    },
    async listCancellations(accessToken, updatedAfter, cursor) {
      const { rows, nextCursor } = await searchPage(SEARCH_CANCELLATIONS, 'cancellations', accessToken, updatedAfter, cursor);
      return { items: rows.map(toRemoteCancellation), nextCursor };
    },
  };
}
