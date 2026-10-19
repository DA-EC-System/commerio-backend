// Tạo mã QR/link thanh toán và đọc trạng thái tiền của đơn (UC-PF-01; Documents/21 §12.3, §12.8, §12.9, T9, T10, T13;
// plan #23 A7, A9, A12, A13). PaymentService của docs/16 #9: chọn cổng qua GatewayFactory.
import { env } from '../../../shared/config/env.ts';
import { withCompany } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { getOrderForPayment, type OrderForPayment } from '../../sales/index.ts';
import { bankNameOf } from '../domain/banks.ts';
import type { Credentials, Gateway } from '../domain/gateways.ts';
import { gatewayBlockReason, orderBlockReason } from '../domain/link-rules.ts';
import { initialPaymentStatus } from '../domain/order-payment.ts';
import { newPaymentCode } from '../domain/payment-code.ts';
import { parseVietQr } from '../domain/vietqr.ts';
import { findOrderPayment, insertOrderPaymentIfMissing, type OrderPaymentRow } from '../repository/order-payments.ts';
import {
  expireStaleActiveLinks,
  findActiveLink,
  findLinksOfOrder,
  insertPaymentLink,
  type PaymentLinkRow,
} from '../repository/payment-links.ts';
import { GatewayFactory } from './gateways/index.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { isCredentialsUnreadable } from './credentials-cipher.ts';
import { loadGatewayCredentials } from './gateway-configs.ts';
import { type UserRef, userRef } from './user-ref.ts';

const LINK_TTL_MS = 15 * 60_000; // T9
const GATEWAY_TIMEOUT_MS = 10_000; // §12.3
const HISTORY_LIMIT = 20; // §12.8 OrderPayment.links

export interface PaymentLinkView {
  id: string;
  orderId: string;
  gateway: Gateway;
  paymentCode: string;
  amount: number;
  payUrl: string | null;
  qrContent: string;
  bankTransfer: { bankBin: string; bankName: string; accountNo: string; accountName: string; content: string } | null;
  expiresAt: string;
  status: 'active' | 'paid' | 'expired' | 'cancelled';
  createdAt: string;
  createdBy: UserRef | null;
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy đơn hàng');
const notAllowed = (reason: string) => new AppError(409, 'payment_not_allowed', reason);

/** Mã `active` đã quá hạn hiện là `expired` khi đọc, không ghi DB (A13). */
const statusOf = (link: PaymentLinkRow) =>
  link.status === 'active' && link.expiresAt.getTime() <= Date.now() ? 'expired' : link.status;

/** Phần của `PaymentLink` dùng chung cho mã đầy đủ và dòng lịch sử (`OrderPayment.links`). */
const baseView = (link: PaymentLinkRow) => ({
  id: link.id,
  gateway: link.gateway,
  paymentCode: link.paymentCode,
  amount: Number(link.amount),
  status: statusOf(link),
  expiresAt: link.expiresAt.toISOString(),
  createdAt: link.createdAt.toISOString(),
});
const isLive = (link: PaymentLinkRow | undefined): link is PaymentLinkRow => !!link && statusOf(link) === 'active';

/** Trạng thái tiền: dòng `order_payments`, chưa có thì suy từ phương thức của đơn (A8 PR chuẩn bị). */
const paymentStatusOf = (order: OrderForPayment, row: OrderPaymentRow | undefined) =>
  row?.status ?? initialPaymentStatus(order.paymentMethod ?? 'prepaid');

function assertOrderAllowsLink(order: OrderForPayment, row: OrderPaymentRow | undefined): void {
  const reason = orderBlockReason({ ...order, paymentStatus: paymentStatusOf(order, row) });
  if (reason) throw notAllowed(reason);
}

/** `bankTransfer` của VietQR: tài khoản, nội dung giải từ chuỗi khách quét; tên chủ tài khoản theo cấu hình (A12). */
function bankTransferOf(link: PaymentLinkRow, credentials: Credentials | undefined): PaymentLinkView['bankTransfer'] {
  const qr = link.gateway === 'vietqr' && link.qrContent ? parseVietQr(link.qrContent) : null;
  if (!qr) return null;
  return {
    bankBin: qr.bankBin,
    bankName: bankNameOf(qr.bankBin),
    accountNo: qr.accountNo,
    accountName: credentials?.accountName ?? '',
    content: qr.content,
  };
}

/** Khoá chỉ để lấy tên chủ tài khoản: không đọc được (khoá hỏng, máy thiếu khoá chủ) thì bỏ trống, không chặn xem mã (#63 B6). */
const vietqrCredentialsForView = () =>
  loadGatewayCredentials('vietqr').catch((err: unknown) => {
    if (isCredentialsUnreadable(err) || (err instanceof AppError && err.code === 'payment_credentials_key_missing')) {
      return undefined;
    }
    throw err;
  });

/** Trong `withCompany`. `vietqrCredentials` truyền sẵn khi vừa giải mã, không thì đọc lại. */
async function toView(link: PaymentLinkRow, vietqrCredentials?: Credentials): Promise<PaymentLinkView> {
  const credentials = link.gateway === 'vietqr' ? (vietqrCredentials ?? (await vietqrCredentialsForView())) : undefined;
  return {
    ...baseView(link),
    orderId: link.orderId,
    payUrl: link.payUrl,
    qrContent: link.qrContent ?? link.payUrl ?? '',
    bankTransfer: bankTransferOf(link, credentials),
    createdBy: link.createdBy ? await userRef(link.createdBy) : null,
  };
}

/** Gốc URL công khai của API; máy dev chưa đặt `PUBLIC_API_URL` thì `localhost` (sandbox nhận, A6). */
const publicApiBase = () => (env.PUBLIC_API_URL ?? `http://localhost:${env.API_PORT}`).replace(/\/+$/, '');

/** Trang kết quả của FE mà cổng đưa khách quay về; chưa đặt `PUBLIC_WEB_URL` thì dùng gốc của API như trước. */
export const paymentReturnUrl = (publicWebUrl: string | undefined, apiBase: string): string =>
  `${(publicWebUrl ?? new URL(apiBase).origin).replace(/\/+$/, '')}/thanh-toan/ket-qua`;

export interface Caller {
  companyId: string;
  accountId: string;
  /** IP của người gọi (VNPay `vnp_IpAddr`). */
  ip: string;
}

/**
 * Tạo mã cho đơn (A7): (1) đọc, kiểm luật, trả mã còn hạn nếu có; (2) gọi cổng ngoài giao dịch; (3) ghi trong giao dịch có
 * khoá: dòng đơn (`FOR SHARE`) rồi `order_payments` (`FOR UPDATE`), kiểm lại luật theo đơn. `created: false` = mã có sẵn.
 */
export function createPaymentLink(caller: Caller, orderId: string, gateway: Gateway) {
  return createPaymentLinkOnce(caller, orderId, gateway, false);
}

async function createPaymentLinkOnce(
  caller: Caller,
  orderId: string,
  gateway: Gateway,
  retried: boolean,
): Promise<{ created: boolean; link: PaymentLinkView }> {
  const prepared = await withCompany(caller.companyId, async () => {
    const order = await getOrderForPayment(orderId);
    if (!order) throw notFound();
    assertOrderAllowsLink(order, await findOrderPayment(orderId));
    const live = await findActiveLink(orderId);
    if (isLive(live)) return { existing: await toView(live) };
    const credentials = await loadGatewayCredentials(gateway).catch((err: unknown) => {
      if (isCredentialsUnreadable(err)) return null;
      throw err;
    });
    if (credentials === null) {
      throw new AppError(422, 'gateway_not_configured', 'Khoá cổng đã lưu không đọc được', {
        errors: { gateway: 'Khoá cổng đã lưu không đọc được, Admin cần lưu lại khoá' },
      });
    }
    if (!credentials) {
      throw new AppError(422, 'gateway_not_configured', 'Cổng thanh toán này chưa được cấu hình', {
        errors: { gateway: 'Cổng chưa được cấu hình khoá' },
      });
    }
    const reason = gatewayBlockReason(gateway, order.total);
    if (reason) throw notAllowed(reason);
    return { order, credentials };
  });
  if (prepared.existing) return { created: false, link: prepared.existing };
  const { order, credentials } = prepared;

  const paymentCode = newPaymentCode();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + LINK_TTL_MS);
  // Lỗi mạng, quá hạn, cổng từ chối: adapter tự đổi thành 502 `gateway_unavailable`; lỗi khác là lỗi code (500).
  const created = await GatewayFactory.of(gateway).createPayment(
      {
        paymentCode,
        orderCode: order.code,
        amount: order.total,
        createdAt,
        expiresAt,
        clientIp: caller.ip,
        ipnBaseUrl: `${publicApiBase()}/api/v1/payment/webhooks`,
        returnUrl: paymentReturnUrl(env.PUBLIC_WEB_URL, publicApiBase()),
      },
      credentials,
      AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    );

  try {
    const link = await withCompany(caller.companyId, async () => {
      // Khoá đơn trước rồi `order_payments`, cùng thứ tự với huỷ đơn của #25 (A7).
      const current = await getOrderForPayment(orderId, { lock: 'share' });
      if (!current) throw notFound();
      await insertOrderPaymentIfMissing(caller.companyId, orderId, 'unpaid');
      assertOrderAllowsLink(current, await findOrderPayment(orderId, 'update'));
      // Cổng đã nhận số tiền đọc ở bước 1; tổng đơn đổi trong lúc chờ thì mã đó sai tiền, không ghi.
      if (!current.total.equals(order.total)) throw notAllowed('Tổng đơn vừa thay đổi, tạo lại mã');
      await expireStaleActiveLinks(orderId, new Date());
      const row = await insertPaymentLink({
        companyId: caller.companyId,
        orderId,
        gateway,
        paymentCode,
        gatewayOrderRef: created.gatewayOrderRef,
        amount: order.total.toFixed(2),
        payUrl: created.payUrl,
        qrContent: created.qrContent,
        expiresAt,
        createdBy: caller.accountId,
      });
      await recordAudit({
        companyId: caller.companyId,
        actorId: caller.accountId,
        action: 'create',
        entityType: 'payment.payment_links',
        entityId: row.id,
        after: { orderId, gateway, paymentCode, amount: Number(row.amount), expiresAt: row.expiresAt.toISOString() },
      });
      return toView(row, credentials);
    });
    return { created: true, link };
  } catch (err) {
    const { code, constraint } = pgError(err);
    if (code === '23505' && constraint === 'payment_links_one_active_per_order') {
      // Yêu cầu song song đã ghi mã trước (T10): giao dịch này đã hỏng, đọc mã của bên thắng ở giao dịch mới.
      const winner = await withCompany(caller.companyId, async () => {
        const live = await findActiveLink(orderId);
        return live ? toView(live) : undefined;
      });
      if (winner) return { created: false, link: winner };
      // Mã bên thắng vừa rời `active` (đơn huỷ, khách vừa trả): làm lại từ bước 1, luật đơn báo 409 đúng lý do (#63 B8).
      if (!retried) return createPaymentLinkOnce(caller, orderId, gateway, true);
      throw notAllowed('Mã thanh toán của đơn vừa thay đổi, tạo lại mã');
    }
    if (code === '23505' && constraint === 'payment_links_payment_code_unique' && !retried) {
      return createPaymentLinkOnce(caller, orderId, gateway, true);
    }
    throw err;
  }
}

export interface OrderPaymentView {
  orderId: string;
  method: 'prepaid' | 'cod';
  status: string;
  refundStatus: string;
  amount: number;
  paidAt: string | null;
  activeLink: PaymentLinkView | null;
  links: ReturnType<typeof baseView>[];
}

/** Trạng thái tiền của đơn (T13). Đơn sàn không có trạng thái tiền ở payment → 404 (§12.3). */
export async function getOrderPaymentView(companyId: string, orderId: string): Promise<OrderPaymentView> {
  return withCompany(companyId, async () => {
    const order = await getOrderForPayment(orderId);
    if (!order?.paymentMethod) throw notFound();
    const row = await findOrderPayment(orderId);
    const links = await findLinksOfOrder(orderId, HISTORY_LIMIT);
    const live = links.find(isLive);
    return {
      orderId,
      method: order.paymentMethod,
      status: paymentStatusOf(order, row),
      refundStatus: row?.refundStatus ?? 'none',
      amount: order.total.toNumber(),
      paidAt: row?.paidAt?.toISOString() ?? null,
      activeLink: live ? await toView(live) : null,
      links: links.map(baseView),
    };
  });
}
