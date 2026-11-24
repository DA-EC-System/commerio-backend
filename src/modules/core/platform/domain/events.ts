import { z } from 'zod';

// Danh mục sự kiện giữa các module (plan chuẩn bị 4.4, Documents/21 D4). Tiền tố của type là module phát.
// Tiền trong payload là chuỗi thập phân ("150000.00") để không mất chính xác. Đổi danh mục là sửa file
// dùng chung: làm bằng PR riêng, báo các bên nghe.

const id = z.uuid();
const money = z.string().regex(/^-?\d+(\.\d+)?$/, 'Tiền là chuỗi thập phân');
const timestamp = z.iso.datetime({ offset: true });
const fulfillmentStatus = z.enum([
  'pending_confirmation',
  'confirmed',
  'picking',
  'packing',
  'issued',
  'in_transit',
  'delivered',
  'delivery_failed',
  'cancelled',
]);

const orderStatus = z.enum(['unpaid', 'processing', 'completed', 'cancelled']);
const packageStatus = z.enum([
  'backordered',
  'reserved',
  'packed',
  'awaiting_pickup',
  'self_delivering',
  'in_transit',
  'delivered',
  'delivery_failed',
  'returning',
  'returned',
  'lost',
  'cancelled',
]);
/** Trạng thái kinh doanh của SKU (Documents/21 §17.1). */
const businessStatus = z.enum(['selling', 'paused', 'discontinued', 'archived']);
// Chép từ RETURN_STATUSES (sales/domain/return.ts) và enum của channel (channel/repository/schema.ts): platform ở lớp
// thấp nhất, không import ngược; test events.test.ts so khớp (#216 AC12).
const returnStatus = z.enum(['requested', 'rejected', 'refund_only', 'awaiting_return', 'received', 'closed']);
const shopStatus = z.enum(['connecting', 'active', 'needs_reauth', 'disconnected']);
const listingStatus = z.enum(['pushing', 'push_failed', 'under_review', 'rejected', 'live', 'hidden', 'platform_hold', 'delisted']);
const syncState = z.enum(['synced', 'pending', 'error']);

export const EVENT_SCHEMAS = {
  'inventory.stock_changed': z.object({ variantId: id, onHand: z.int(), reserved: z.int(), available: z.int() }),
  'inventory.below_threshold': z.object({ variantId: id, available: z.int(), minQty: z.int() }),
  'inventory.receipt_posted': z.object({
    receiptId: id,
    number: z.string(),
    kind: z.enum(['purchase', 'manual', 'delivery_return']),
    lines: z.array(z.object({ variantId: id, quantity: z.int().positive() })),
  }),
  // Phiếu kiểm kê ghi sổ (#208, Documents/21 mục 11.2); nguồn `shop_setup` là kiểm kê đầu kỳ của gian hàng (#245).
  // `countedAt` là thời điểm đếm, khác `postedAt` là lúc ghi sổ (thêm 06/11/2026); channel đặt lại mốc kéo đơn theo nó (#198).
  'inventory.stocktake_posted': z.object({
    documentId: id,
    number: z.string(),
    source: z.object({ type: z.literal('shop_setup'), shopId: id }).nullable(),
    postedAt: timestamp,
    countedAt: timestamp,
    lines: z.array(z.object({ variantId: id, countedQty: z.int().nonnegative(), delta: z.int() })),
  }),
  // Phiếu kiểm hàng hoàn nguồn yêu cầu trả ghi sổ (#208, mục 11.2); kiện hoàn không phát. `shopId` không null theo
  // Documents/21 §11.2 (yêu cầu trả chỉ có ở đơn sàn); sổ tiền ghi `cogs_reversal` theo gian hàng (#228, #308).
  'inventory.return_inspected': z.object({
    inspectionId: id,
    orderId: id,
    shopId: id,
    inspectedAt: timestamp,
    lines: z.array(z.object({ variantId: id, resellable: z.int().nonnegative(), unitCost: money.nullable() })),
  }),
  'inventory.issue_posted': z.object({
    issueId: id,
    number: z.string(),
    kind: z.enum(['manual', 'order']),
    orderId: id.nullable(),
    postedAt: timestamp,
  }),
  'sales.order_created': z.object({
    orderId: id,
    code: z.string(),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    total: money,
  }),
  // Đơn, kiện theo mô hình vòng đời (Documents/21 §13.2 "Sự kiện của mô hình mới", #105). `from` null khi mới tạo.
  'sales.order_status_changed': z.object({
    orderId: id,
    code: z.string(),
    from: orderStatus.nullable(),
    to: orderStatus,
    flags: z.array(z.string()),
  }),
  'sales.order_cancelled': z.object({
    orderId: id,
    code: z.string(),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    /** `platform`: sàn huỷ; `seller`: người bán huỷ trong app. */
    by: z.enum(['platform', 'seller']),
  }),
  // Tiền hoàn cho khách (`refund_only` duyệt, hoặc đã nhận hàng trả; #202, Documents/21 mục 11.2). Sổ tiền nghe (#228).
  'sales.return_refunded': z.object({
    returnRequestId: id,
    orderId: id,
    shopId: id,
    refundAmount: money,
    refundedAt: timestamp,
  }),
  // Yêu cầu trả đổi trạng thái, hoặc `from = to` khi cờ Cần xử lý, thông tin sàn hiện trên màn đổi (Documents/21 §13.2, #216).
  'sales.return_status_changed': z.object({ returnId: id, orderId: id, from: returnStatus.nullable(), to: returnStatus }),
  'fulfillment.package_status_changed': z.object({
    packageId: id,
    orderId: id,
    from: packageStatus.nullable(),
    to: packageStatus,
  }),
  // Sáu sự kiện kiện của Documents/21 §11.2 (#199, #238). Tiền là chuỗi thập phân, số lượng nguyên dương.
  'fulfillment.package_shipped': z.object({
    packageId: id,
    orderId: id,
    lines: z.array(z.object({ variantId: id, quantity: z.int().positive(), unitCost: money })),
  }),
  /** Các biến thể vừa được phân bổ lại tồn (#223 nghe để đẩy tồn lên sàn). */
  'fulfillment.allocation_done': z.object({
    variantIds: z.array(id),
    /**
     * Chỉ có ở lượt phân hàng do phiếu kiểm kê đầu kỳ ghi sổ (Documents#95, quyết định 1). Lượt đó luôn phát, kể cả
     * `variantIds` rỗng; channel thoát chờ phân hàng khi `cause.documentId` trùng phiếu. Lượt khác không có trường này.
     */
    cause: z.object({ type: z.literal('stocktake'), documentId: id }).optional(),
  }),
  'fulfillment.package_delivered': z.object({
    packageId: id,
    orderId: id,
    shopId: id,
    deliveredAt: timestamp,
    lines: z.array(
      z.object({
        /** Null khi dòng kiện chưa ghép SKU lúc bàn giao (ghép sau, #199c); `unitCost` kèm theo là null. */
        variantId: id.nullable(),
        quantity: z.int().positive(),
        unitPrice: money,
        /** Null khi dòng kiện không có giá vốn (kiện bàn giao trước thời điểm bắt đầu lấy đơn, không qua `ship`; 21 §11.2). Không thay bằng giá vốn bình quân lúc giao. */
        unitCost: money.nullable(),
      }),
    ),
    platformSubsidy: money,
    shippingIncome: money,
    shippingCost: money,
  }),
  'fulfillment.package_delivery_failed': z.object({
    packageId: id,
    orderId: id,
    reason: z.string(),
  }),
  'fulfillment.package_returned': z.object({
    packageId: id,
    orderId: id,
    shopId: id,
    returnedAt: timestamp,
  }),
  'fulfillment.package_lost': z.object({
    packageId: id,
    orderId: id,
    claimCode: z.string().nullable(),
  }),
  'fulfillment.order_status_changed': z.object({
    orderId: id,
    from: fulfillmentStatus.nullable(),
    to: fulfillmentStatus,
    isShortStock: z.boolean(),
  }),
  'payment.succeeded': z.object({
    orderId: id,
    paymentTransactionId: id,
    gateway: z.enum(['vnpay', 'momo', 'zalopay', 'vietqr']),
    amount: money,
  }),
  'finance.invoice_posted': z.object({
    invoiceId: id,
    orderId: id,
    total: money,
    issuedAt: timestamp,
    reversalOf: id.nullable(),
  }),
  'finance.receipt_posted': z.object({
    receiptId: id,
    orderId: id.nullable(),
    amount: money,
    source: z.enum(['gateway', 'cod', 'settlement', 'unmatched_assignment']),
    postedAt: timestamp,
    reversalOf: id.nullable(),
  }),
  'finance.voucher_posted': z.object({
    voucherId: id,
    purpose: z.enum(['supplier_payment', 'customer_refund', 'unmatched_refund']),
    orderId: id.nullable(),
    amount: money,
    paidOn: z.iso.date(),
    reversalOf: id.nullable(),
  }),
  // Phiên bản cấu hình tiền vừa có hiệu lực (#118, Documents/21 §21.4). C2 nghe `fee`, `min_margin` để tính lại giá
  // trên sàn; sổ tiền chọn phiên bản theo ngày kiện giao nên không cần nghe. `supersededId`: bản vừa hết hiệu lực.
  'finance.fee_config_activated': z.object({
    configVersionId: id,
    kind: z.enum(['fee', 'tax_regime', 'tax_rules', 'mismatch_threshold', 'min_margin', 'account_map']),
    shopId: id.nullable(),
    effectiveFrom: z.iso.date(),
    supersededId: id.nullable(),
  }),
  // Đề nghị nhập gửi (hoặc gửi lại) CEO duyệt (#108).
  'purchasing.request_submitted': z.object({ requestId: id, number: z.string() }),
  // NCC hoàn tiền phiếu trả (#210, Documents/21 mục 11.2); sổ tiền ghi dòng `supplier_refund` chờ khớp ngân hàng (#228).
  'purchasing.supplier_return_refunded': z.object({ supplierReturnId: id, supplierId: id, refundAmount: money, recordedAt: timestamp }),
  // Phiếu nhận đã ghi sổ (#109, Documents/21 mục 11.2): số đạt vào tồn thực, số lỗi vào chờ xử lý. Sổ tiền ghi khoản
  // trả NCC = (đạt + lỗi giữ lại) × `unitPrice` (giá dòng đề nghị); `replacement`: phiếu của đề nghị bù hàng, không sinh
  // khoản trả (#357).
  'purchasing.goods_receipt_posted': z.object({
    receiptId: id,
    requestId: id,
    supplierId: id,
    postedAt: timestamp,
    replacement: z.boolean(),
    lines: z.array(z.object({ variantId: id, accepted: z.int().nonnegative(), defective: z.int().nonnegative(), unitPrice: money })),
  }),
  // Trạng thái kinh doanh của SKU đổi (#204, Documents/21 §11.2). Channel ẩn, hiện listing; inventory xét lại ngưỡng.
  'catalog.variant_status_changed': z.object({
    variantId: id,
    productId: id,
    from: businessStatus,
    to: businessStatus,
    changedAt: timestamp,
  }),
  // Giá muốn bán (`target_net_price`) đổi (#204, #242). `to` null là đã xoá giá. Channel chạy lại bộ lọc giá (#225).
  'catalog.variant_price_changed': z.object({
    variantId: id,
    productId: id,
    from: money.nullable(),
    to: money.nullable(),
    changedAt: timestamp,
  }),
  // Thông số sản phẩm (#510, Documents/21 mục 5.5): channel xoá dòng ánh xạ tương ứng (bảng ánh xạ không khoá ngoại sang
  // catalog), lúc đọc cũng bỏ qua dòng mồ côi.
  'catalog.spec_field_deleted': z.object({ fieldId: id }),
  'catalog.spec_option_deleted': z.object({ fieldId: id, optionIds: z.array(id).min(1) }),
  'catalog.attribute_deleted': z.object({ attributeId: id }),
  // Người được mời xin mã OTP (#7 [C]). Không mang email, họ tên hay mã: consumer đọc dòng lời mời, sinh mã trong
  // worker. `requestedAt` (mili giây) trùng `otp_requested_at` của dòng; khác thì sự kiện đã cũ, bỏ qua.
  'staff.invitation_otp_requested': z.object({ invitationId: id, requestedAt: timestamp }),
  // Người được mời nộp yêu cầu (`pending`, Documents/21 mục 3.1): worker gửi thư báo người có quyền duyệt. Không mang
  // email, họ tên: consumer đọc dòng lời mời, bỏ qua khi không còn `pending`.
  'staff.invitation_submitted': z.object({ invitationId: id }),
  // Admin duyệt hoặc từ chối: worker gửi thư báo kết quả tới email của yêu cầu; bỏ qua khi trạng thái dòng khác `decision`.
  'staff.invitation_decided': z.object({ invitationId: id, decision: z.enum(['approved', 'rejected']) }),
  // Thư báo gian hàng sắp hết hoặc đã mất uỷ quyền vừa xếp (#312). Không mang email, token: consumer đọc dòng
  // `channel.shop_reauth_mails` và danh sách CEO, Admin lúc gửi.
  'channel.shop_reauth_mail': z.object({ mailId: id, shopId: id }),
  // Gian hàng đổi trạng thái; listing đổi `status`, `stockSync` hay `priceSync`, mang giá trị sau khi đổi (Documents/21 §13.2, #216).
  'channel.shop_status_changed': z.object({ shopId: id, from: shopStatus.nullable(), to: shopStatus }),
  'channel.listing_sync_changed': z.object({ shopId: id, listingId: id, stockSync: syncState, priceSync: syncState, status: listingStatus }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];
