// Đơn và kiện TikTok Shop (#221): liệt kê đơn theo cửa sổ `update_time`, chi tiết đơn theo lô, tách kiện, giao kiện.
// Nguồn (docv2, tra 07/11/2026; bản mới nhất trên docv2 ngày đó, OAS cục bộ của skill `tts-openapi-guide` trùng):
// - get-order-list-202309: `POST /order/202309/orders/search`, `page_size` 1–100, `sort_field` `update_time`,
//   `update_time_ge` (Unix giây, lấy cả mốc), `order_status` một giá trị.
// - get-order-detail-202507: `GET /order/202507/orders?ids=` (phẩy, tối đa 50). `line_items` không có số lượng: mỗi
//   phần tử một đơn vị (gọi thật 07/11/2026: đơn 2 SKU ra 2 phần tử).
// - get-order-split-attributes-202309, confirm-order-split-202309, ship-package-202309.
// Kết quả gọi thật ở Documents/tich-hop-san/tiktok.md và mục TikTok của channel CLAUDE.md.
import {
  type MarketplaceAdapter,
  MarketplaceError,
  type RemoteAddress,
  type RemoteLineInfo,
  type RemoteLineStatus,
  type RemoteOrder,
  type RemoteOrderRef,
  type SplitAttributes,
} from './common.ts';
import { downloadDocument } from './image-source.ts';
import type { TiktokClient } from './tiktok-client.ts';

type Row = Record<string, unknown>;

const ORDER_PAGE = 100;
const DETAIL_BATCH = 50;
/**
 * Đơn chưa xong cho lượt kéo đơn còn mở (#198), theo thứ tự vòng đời để đơn đổi trạng thái giữa lượt vẫn gặp lại ở
 * trạng thái sau. Không lấy `DELIVERED`: hàng đã rời kho, như Lazada dừng ở `shipping`.
 */
export const TIKTOK_OPEN_STATUSES = ['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT'] as const;

/** `display_status` của món (hay `status` của đơn) → trạng thái kiện của app. */
const DISPLAY_STATUS: Readonly<Record<string, RemoteLineStatus>> = {
  UNPAID: 'pending',
  ON_HOLD: 'pending',
  AWAITING_SHIPMENT: 'pending',
  AWAITING_COLLECTION: 'awaiting_pickup',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  // Hết hạn trả (returnWindow `platform_status`): kiện vẫn là đã giao, app đọc `rawStatus` = COMPLETED.
  COMPLETED: 'delivered',
  CANCELLED: 'cancelled',
};
/** `package_status` của món, chỉ dùng khi `display_status` không quyết được (đơn `PARTIALLY_SHIPPING`, thiếu trường). */
const PACKAGE_STATUS: Readonly<Record<string, RemoteLineStatus>> = {
  TO_FULFILL: 'pending',
  PROCESSING: 'awaiting_pickup',
  FULFILLING: 'in_transit',
  COMPLETED: 'delivered',
};

/**
 * Trạng thái gốc của món: `display_status`, thiếu hay lạ thì `status` của đơn (gọi thật 07/11/2026: đơn `ON_HOLD` có món
 * `display_status: UNKNOWN`).
 */
export const tiktokLineRawStatus = (displayStatus: string, orderStatus: string) => (DISPLAY_STATUS[displayStatus] ? displayStatus : orderStatus || displayStatus);

/**
 * Trạng thái một món theo `tiktokLineRawStatus`. Món chờ giao (`AWAITING_SHIPMENT`) mà kiện đã `PROCESSING` (người bán đã
 * gọi giao, chờ hãng lấy) thì là `awaiting_pickup`. `package_status` `CANCELLED` không đủ để suy (docs: "thường do thất
 * lạc, hư hỏng"; gọi thật có đơn `COMPLETED` mang kiện `CANCELLED`) nên không dùng riêng.
 */
export function tiktokLineStatus(displayStatus: string, packageStatus: string, orderStatus: string): RemoteLineStatus | null {
  const display = tiktokLineRawStatus(displayStatus, orderStatus);
  if (display === 'AWAITING_SHIPMENT' && packageStatus === 'PROCESSING') return 'awaiting_pickup';
  return DISPLAY_STATUS[display] ?? PACKAGE_STATUS[packageStatus] ?? null;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const opt = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
const unix = (v: unknown) => (Number(v) > 0 ? new Date(Number(v) * 1000) : null);
/** Mốc bắt buộc (`create_time`, `update_time`): thiếu là phản hồi lạ, không đoán. */
function unixRequired(v: unknown): Date {
  const d = unix(v);
  if (!d) throw new MarketplaceError('rejected', 'unexpected_response', 'Đơn TikTok thiếu mốc thời gian');
  return d;
}

const CANCEL_BY: Readonly<Record<string, RemoteLineInfo['cancelInitiator']>> = {
  BUYER: 'buyer',
  SELLER: 'seller',
  OPERATOR: 'platform',
  SYSTEM: 'platform',
};

/**
 * Địa chỉ nhận: TikTok che tên, SĐT, số nhà khi sàn giao (gọi thật: `a***-vn2`, `(+86)123******43`), giữ nguyên như
 * sàn trả. `district_info` L1 tỉnh, L2 quận, L3 phường; phường để ở `ward`, không lặp trong `address`. Đơn `UNPAID`,
 * `ON_HOLD` chưa có địa chỉ (chuỗi rỗng) thì null.
 */
function tiktokAddress(a: Row | null): RemoteAddress | null {
  if (!a) return null;
  const levels = new Map(((a.district_info ?? []) as Row[]).map((d) => [str(d.address_level), str(d.address_name)]));
  const name = str(a.name) || `${str(a.first_name)} ${str(a.last_name)}`.trim();
  const detail = str(a.address_detail) || [a.address_line1, a.address_line2, a.address_line3, a.address_line4].map(str).filter(Boolean).join(', ');
  const address = [detail, levels.get('L2'), levels.get('L1')].filter(Boolean).join(', ');
  if (!name && !address) return null;
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) if (typeof v === 'string' && v) raw[k] = v;
  for (const [level, value] of levels) if (value) raw[`district_${level}`] = value;
  return { name, phone: str(a.phone_number), address, ward: levels.get('L3') || null, postCode: opt(a.postal_code), raw };
}

/** Tổng hai khoản tiền chuỗi thập phân (VND, sàn trả số nguyên); thiếu cả hai thì null. */
function addMoney(a: unknown, b: unknown): string | null {
  if (opt(a) === null && opt(b) === null) return null;
  const n = Number(str(a) || 0) + Number(str(b) || 0);
  return Number.isFinite(n) ? String(n) : null;
}

/** Đơn chi tiết (`GET /order/202507/orders`) → đơn chuẩn hoá. */
export function toTiktokOrder(o: Row): RemoteOrder {
  const status = str(o.status);
  const pay = (o.payment ?? {}) as Row;
  const items = (o.line_items ?? []) as Row[];
  const taxes = (i: Row) => ((i.item_tax ?? []) as Row[]).map((t) => str(t.tax_amount)).filter(Boolean);
  return {
    externalOrderId: str(o.id),
    rawStatus: status,
    paid: status !== 'UNPAID',
    isCod: o.is_cod === true,
    placedAt: unixRequired(o.create_time),
    updatedAt: unixRequired(o.update_time),
    // Hạn giao hàng cho hãng của sàn (`rts_sla_time`, "latest shipping time specified by the platform").
    shipBy: unix(o.rts_sla_time),
    deliveredAt: unix(o.delivery_time),
    shippingAddress: tiktokAddress((o.recipient_address ?? null) as Row | null),
    // Phí ship khách trả (`shipping_fee` = gốc − giảm của người bán − giảm của sàn).
    shippingFee: str(pay.shipping_fee ?? 0) || '0',
    // Docs: "True when the buyer has a pending cancellation request"; gọi thật: sàn bỏ trường khi false.
    cancelRequested: o.is_buyer_request_cancel === true,
    info: {
      platformPaymentMethod: opt(o.payment_method_name),
      buyerNote: opt(o.buyer_message),
      shippingFeeOriginal: opt(pay.original_shipping_fee),
      // Người bán chịu cả khoản giảm thường và khoản giảm đồng tài trợ (`cofunded`, sàn hoàn sau khi giao).
      shippingFeeDiscountSeller: addMoney(pay.shipping_fee_seller_discount, pay.shipping_fee_cofunded_discount),
      shippingFeeDiscountPlatform: opt(pay.shipping_fee_platform_discount),
    },
    lines: items.map((i) => {
      const cancelUser = str(i.cancel_user);
      const tax = taxes(i);
      return {
        externalLineId: str(i.id),
        sellerSku: str(i.seller_sku),
        productName: str(i.product_name),
        // Giá trước giảm; app tính thành tiền = giá − giảm người bán − giảm sàn.
        unitPrice: str(i.original_price ?? 0) || '0',
        sellerDiscount: str(i.seller_discount ?? 0) || '0',
        platformDiscount: str(i.platform_discount ?? 0) || '0',
        packageCode: opt(i.package_id),
        trackingCode: opt(i.tracking_number),
        rawStatus: tiktokLineRawStatus(str(i.display_status), status),
        status: tiktokLineStatus(str(i.display_status), str(i.package_status), status),
        info: {
          thumbnailUrl: opt(i.sku_image),
          attributesLabel: opt(i.sku_name),
          externalSkuId: opt(i.sku_id),
          externalShopSku: null,
          externalProductId: opt(i.product_id),
          paidPrice: opt(i.sale_price),
          taxAmount: tax.length ? String(tax.reduce((s, t) => s + Number(t), 0)) : null,
          shippingAmount: null,
          walletCredits: null,
          cancelReason: opt(i.cancel_reason),
          cancelReasonDetail: null,
          cancelInitiator: CANCEL_BY[cancelUser] ?? null,
          cancelKind: cancelUser || str(i.display_status) === 'CANCELLED' ? 'cancellation' : null,
          // Trả hàng, hoàn tiền đọc ở API return_refund (#227), không có trong chi tiết đơn.
          reverseOrderId: null,
          returnStatus: null,
        },
        shipping: {
          shipmentProvider: opt(i.shipping_provider_name) ?? opt(o.shipping_provider),
          shippingProviderType: null,
          // `TIKTOK` (sàn giao) hay `SELLER` (người bán tự giao).
          shippingType: opt(o.shipping_type),
          promisedShippingAt: unix(o.rts_sla_time),
        },
      };
    }),
  };
}

/**
 * Con trỏ lật đơn. Mỗi trang gọi lại `update_time_ge = a`, xếp `update_time` tăng, không dùng `page_token` (nếu token
 * là offset bên trong thì đơn đổi giữa hai trang làm sót đơn, #218). `seen`: đơn đã trả có `update_time` = `a`, để bỏ
 * trùng. Cả trang cùng một giây thì cửa sổ không tiến: chuyển sang lật nhóm giây đó (`g`) bằng `page_token` với
 * `[s, s+1)`; xong nhóm thì sang `s+1`. Nhóm thu được ít mã hơn `total_count` lần đầu (đơn trong nhóm đổi giữa lúc lật)
 * thì báo `safeUntil = s`.
 */
interface OrderCursor {
  a: number;
  seen: Record<string, number>;
  g?: { s: number; token: string; total: number; ids: string[] };
}

interface OpenCursor {
  st: number;
  c: OrderCursor;
}

const fresh = (a: number): OrderCursor => ({ a, seen: {} });

type SearchData = { orders?: Row[]; next_page_token?: unknown; total_count?: unknown };

export interface TiktokOrderDeps {
  download?: (url: string) => Promise<Uint8Array>;
}

export function tiktokOrderMethods(
  client: TiktokClient,
  { download = downloadDocument }: TiktokOrderDeps = {},
): Pick<MarketplaceAdapter, 'listOrders' | 'listOpenOrders' | 'getOrder' | 'getOrders' | 'splitAttributes' | 'splitOrder' | 'shipPackage' | 'readyToShip' | 'shippingDocuments'> {
  // TikTok giao (shipping_type TIKTOK); tự giao (self_shipment) chưa dùng.
  const shipPackage: NonNullable<MarketplaceAdapter['shipPackage']> = async (accessToken, packageCode, opts) => {
    const handover = opts?.handover === 'pickup' ? 'PICKUP' : opts?.handover === 'drop_off' ? 'DROP_OFF' : undefined;
    try {
      await client.call('POST', `/fulfillment/202309/packages/${encodeURIComponent(packageCode)}/ship`, {
        token: accessToken,
        body: handover ? { handover_method: handover } : {},
      });
    } catch (err) {
      // 11006021: kiện đã được báo giao (docv2 ship-package-202309; gọi thật 07/11/2026).
      if (!(err instanceof MarketplaceError && err.platformCode === '11006021')) throw err;
    }
  };

  async function shippingDocument(token: string, code: string): Promise<Uint8Array> {
    try {
      const data = await client.call<{ doc_url?: unknown }>('GET', `/fulfillment/202309/packages/${encodeURIComponent(code)}/shipping_documents`, {
        token,
        query: { document_type: 'SHIPPING_LABEL', document_size: 'A6', document_format: 'PDF' },
      });
      if (typeof data?.doc_url !== 'string' || !data.doc_url) {
        throw new MarketplaceError('unavailable', 'document_download_failed', 'Sàn trả tệp vận đơn hỏng, thử lại sau');
      }
      return await download(data.doc_url);
    } catch (err) {
      if (err instanceof MarketplaceError && err.kind === 'rejected') {
        throw new MarketplaceError(err.kind, err.platformCode, `Kiện ${code}: ${err.platformMessage ?? 'Sàn từ chối in vận đơn'}`);
      }
      throw err;
    }
  }
  const search = (token: string, filter: Row, pageToken?: string) =>
    client.call<SearchData>('POST', '/order/202309/orders/search', {
      token,
      query: { page_size: ORDER_PAGE, sort_field: 'update_time', sort_order: 'ASC', page_token: pageToken },
      body: filter,
    });

  const refOf = (o: Row): RemoteOrderRef => ({ externalOrderId: str(o.id), placedAt: unixRequired(o.create_time), updatedAt: unixRequired(o.update_time) });
  const byTime = (a: RemoteOrderRef, b: RemoteOrderRef) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.externalOrderId.localeCompare(b.externalOrderId);
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);

  /** Một trang theo con trỏ; `extra` là bộ lọc thêm (`order_status` cho đơn còn mở). */
  async function page(token: string, state: OrderCursor, extra: Row) {
    if (state.g) {
      const g = state.g;
      const data = await search(token, { ...extra, update_time_ge: g.s, update_time_lt: g.s + 1 }, g.token || undefined);
      const total = g.token ? g.total : Number(data?.total_count ?? 0);
      const known = new Set(g.ids);
      const all = (data?.orders ?? []).map(refOf);
      // Docs: `update_time` trả về có thể vượt khoảng lọc (dữ liệu đổi trong lúc tìm). Đơn đã sang giây sau bỏ ở đây,
      // cửa sổ `s+1` sẽ gặp lại, để thứ tự `updatedAt` không giảm.
      const refs = all.filter((r) => sec(r.updatedAt) === g.s).sort(byTime);
      const orders = refs.filter((r) => !known.has(r.externalOrderId) && state.seen[r.externalOrderId] !== g.s);
      const ids = [...known, ...refs.map((r) => r.externalOrderId).filter((id) => !known.has(id))];
      const next = typeof data?.next_page_token === 'string' ? data.next_page_token : '';
      if (next && all.length > 0 && next !== g.token) return { orders, next: { ...state, g: { s: g.s, token: next, total, ids } } as OrderCursor, safeUntil: null };
      return { orders, next: fresh(g.s + 1), safeUntil: new Set(ids).size < total ? new Date(g.s * 1000) : null };
    }
    const data = await search(token, { ...extra, ...(state.a > 0 && { update_time_ge: state.a }) });
    const refs = (data?.orders ?? []).map(refOf).sort(byTime);
    const orders = refs.filter((r) => state.seen[r.externalOrderId] !== sec(r.updatedAt));
    const last = refs.at(-1);
    const more = typeof data?.next_page_token === 'string' && data.next_page_token !== '' && refs.length >= ORDER_PAGE;
    if (!last || !more) return { orders, next: null, safeUntil: null };
    const s = sec(last.updatedAt);
    if (sec(refs[0]!.updatedAt) === s) {
      // Cả trang một giây: lật nhóm giây đó (trang đầu của nhóm gọi lại, đơn đã trả bỏ nhờ `seen`).
      const seen = Object.fromEntries(refs.map((r) => [r.externalOrderId, s]));
      return { orders, next: { a: s, seen: { ...state.seen, ...seen }, g: { s, token: '', total: 0, ids: [] } } as OrderCursor, safeUntil: null };
    }
    const seen = Object.fromEntries(refs.filter((r) => sec(r.updatedAt) === s).map((r) => [r.externalOrderId, s]));
    return { orders, next: { a: s, seen }, safeUntil: null };
  }

  async function details(token: string, ids: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += DETAIL_BATCH) {
      const batch = unique.slice(i, i + DETAIL_BATCH);
      const data = await client.call<{ orders?: Row[] }>('GET', '/order/202507/orders', { token, query: { ids: batch.join(',') } });
      for (const o of data?.orders ?? []) out.set(str(o.id), o);
    }
    return out;
  }

  const missing = (id: string) => new MarketplaceError('rejected', 'order_not_found', `Sàn không trả đơn ${id}`);

  return {
    async listOrders(accessToken, updatedAfter, cursor) {
      const state: OrderCursor = cursor ? (JSON.parse(cursor) as OrderCursor) : fresh(sec(updatedAfter));
      const p = await page(accessToken, state, {});
      return { orders: p.orders, nextCursor: p.next && JSON.stringify(p.next), safeUntil: p.safeUntil };
    },
    // Mỗi trạng thái mở lật như `listOrders` từ đầu lịch sử gian hàng (bỏ `update_time_ge`), hết thì sang trạng thái sau.
    async listOpenOrders(accessToken, cursor) {
      const state: OpenCursor = cursor ? (JSON.parse(cursor) as OpenCursor) : { st: 0, c: fresh(0) };
      const p = await page(accessToken, state.c, { order_status: TIKTOK_OPEN_STATUSES[state.st] });
      const next: OpenCursor | null = p.next
        ? { st: state.st, c: p.next }
        : state.st + 1 < TIKTOK_OPEN_STATUSES.length
          ? { st: state.st + 1, c: fresh(0) }
          : null;
      return { orders: p.orders, nextCursor: next && JSON.stringify(next), safeUntil: p.safeUntil };
    },
    async getOrder(accessToken, externalOrderId) {
      const o = (await details(accessToken, [externalOrderId])).get(externalOrderId);
      if (!o) throw missing(externalOrderId);
      return toTiktokOrder(o);
    },
    // Lô 50 mã (docs Get Order Detail); `detail` của ref không dùng vì trang liệt kê là bản 202309, khác bản chi tiết.
    async getOrders(accessToken, refs) {
      const found = await details(accessToken, refs.map((r) => r.externalOrderId));
      return refs.map((r) => {
        const o = found.get(r.externalOrderId);
        if (!o) throw missing(r.externalOrderId);
        return toTiktokOrder(o);
      });
    },
    async splitAttributes(accessToken, externalOrderId): Promise<SplitAttributes> {
      const data = await client.call<{ split_attributes?: Row[] }>('GET', '/fulfillment/202309/orders/split_attributes', {
        token: accessToken,
        query: { order_ids: externalOrderId },
      });
      const a = (data?.split_attributes ?? []).find((s) => str(s.order_id) === externalOrderId);
      if (!a) throw missing(externalOrderId);
      return {
        canSplit: a.can_split === true,
        mustSplit: a.must_split === true,
        reason: opt(a.reason),
        mustSplitReasons: ((a.must_split_reasons ?? []) as Row[]).map((r) => ({
          type: str(r.type),
          externalCategoryId: opt(r.category_id),
          maxCount: opt(r.max_count) === null ? null : Number(r.max_count),
        })),
      };
    },
    // `splittable_groups[].id` do mình đặt, phải là chuỗi số ("must be convertible to Int64", gọi thật 03/11/2026):
    // dùng số thứ tự nhóm từ 1, kiện mới trả theo `splittable_group_id`.
    async splitOrder(accessToken, externalOrderId, groups) {
      if (groups.length < 2 || groups.some((g) => g.length === 0)) {
        throw new MarketplaceError('rejected', 'invalid_split', 'Tách kiện cần ít nhất hai nhóm, mỗi nhóm có món');
      }
      const data = await client.call<{ packages?: Row[] }>('POST', `/fulfillment/202309/orders/${encodeURIComponent(externalOrderId)}/split`, {
        token: accessToken,
        body: { splittable_groups: groups.map((ids, i) => ({ id: String(i + 1), order_line_item_ids: [...ids] })) },
      });
      const byGroup = new Map((data?.packages ?? []).map((p) => [str(p.splittable_group_id), str(p.id)]));
      return groups.map((_, i) => {
        const id = byGroup.get(String(i + 1));
        if (!id) throw new MarketplaceError('rejected', 'unexpected_response', 'Sàn không trả kiện cho một nhóm tách');
        return id;
      });
    },
    shipPackage,
    async readyToShip(token, codes) {
      for (const code of codes) await shipPackage(token, code);
    },
    async shippingDocuments(token, codes) {
      const files: Uint8Array[] = [];
      for (let offset = 0; offset < codes.length; offset += 5) {
        const batch = await Promise.all(codes.slice(offset, offset + 5).map((code) => shippingDocument(token, code)));
        files.push(...batch);
      }
      return files;
    },
  };
}
