// Nhận webhook của cổng (Documents/21 §12.4, T6, D16; plan #27 A4): (1) lấy mã thanh toán, SePay lấy công ty từ
// `receiverKey`; (2) tìm mã/công ty **toàn hệ thống** bằng role chủ bảng; (3) trong `withCompany` của công ty đó: lấy khoá,
// kiểm chữ ký — sai thì dừng, không ghi gì; (4) giao cho finance (`ctx.onVerifiedPayment`) trong cùng giao dịch.
// Phản hồi theo định dạng của từng cổng, không dùng Problem Details.
import { Decimal } from 'decimal.js';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import type { Gateway } from '../domain/gateways.ts';
import { findCompanyByReceiverKey } from '../repository/gateway-configs.ts';
import { findLinkByCode, findLinkByCodeAnyCompany } from '../repository/payment-links.ts';
import { loadGatewayCredentials } from './gateway-configs.ts';
import { asRecord } from './gateways/common.ts';
import { type CallbackInput, type CallbackOutcome, GatewayFactory, type GatewayResult } from './gateways/index.ts';
import { type PaymentContext, type VerifiedGatewayPayment, verifiedPaymentHandlerOf } from './webhook-handler.ts';

export interface CallbackReply {
  status: number;
  body: unknown;
}

const reply = (gateway: Gateway, outcome: CallbackOutcome): CallbackReply => GatewayFactory.of(gateway).respond(outcome);

/** Sai chữ ký: chỉ ghi cổng và mã, không ghi khoá, chữ ký hay payload (A18). */
const badSignature = (gateway: Gateway, paymentCode: string | null) => {
  logger.warn({ gateway, paymentCode }, 'webhook sai chữ ký, bỏ qua');
  return 'bad_signature' as const;
};

export function toPayment(
  companyId: string,
  gateway: Gateway,
  source: VerifiedGatewayPayment['source'],
  r: GatewayResult,
  link: { id: string; orderId: string; paymentCode: string } | undefined,
): VerifiedGatewayPayment {
  return {
    companyId,
    gateway,
    source,
    eventKey: r.eventKey,
    gatewayTxnId: r.gatewayTxnId,
    paymentCode: link?.paymentCode ?? null,
    paymentLinkId: link?.id ?? null,
    orderId: link?.orderId ?? null,
    amount: r.amount,
    succeeded: r.succeeded,
    fee: null,
    occurredAt: r.occurredAt,
    rawPayload: r.rawPayload,
  };
}

async function handle(gateway: Gateway, run: () => Promise<CallbackOutcome>): Promise<CallbackReply> {
  try {
    return reply(gateway, await run());
  } catch (err) {
    // Lỗi lạ (DB, lắp ráp): báo cổng gửi lại; giao dịch đã rollback nên lần sau xử lý lại được.
    logger.error({ err, gateway }, 'webhook lỗi khi xử lý');
    return reply(gateway, 'error');
  }
}

/** VNPay, MoMo, ZaloPay: công ty suy từ mã thanh toán (D16). */
export function receiveGatewayCallback(ctx: PaymentContext, gateway: Exclude<Gateway, 'vietqr'>, input: CallbackInput) {
  const adapter = GatewayFactory.of(gateway);
  return handle(gateway, async () => {
    const code = adapter.codeOf(input);
    const link = code ? await findLinkByCodeAnyCompany(code) : undefined;
    if (!link || link.gateway !== gateway) return 'not_found';
    return withCompany(link.companyId, async () => {
      const credentials = await loadGatewayCredentials(gateway);
      if (!credentials) return 'not_found';
      const result = adapter.readCallback(input, credentials);
      if (result === 'bad_signature') return badSignature(gateway, code);
      const { outcome } = await verifiedPaymentHandlerOf(ctx)(toPayment(link.companyId, gateway, 'webhook', result, link));
      return outcome;
    });
  });
}

/** SePay: công ty suy từ `receiverKey` của URL (T12); mã thanh toán chỉ tìm trong công ty đó. Tiền ra thì bỏ qua. */
export function receiveSepay(ctx: PaymentContext, receiverKey: string, input: CallbackInput) {
  const adapter = GatewayFactory.of('vietqr');
  return handle('vietqr', async () => {
    const companyId = await findCompanyByReceiverKey(receiverKey);
    if (!companyId) return 'not_found';
    return withCompany(companyId, async () => {
      const credentials = await loadGatewayCredentials('vietqr');
      if (!credentials) return 'not_found';
      const result = adapter.readCallback(input, credentials);
      if (result === 'bad_signature') return badSignature('vietqr', null);
      if (asRecord(input.body).transferType === 'out') return 'recorded';
      const found = result.paymentCode ? await findLinkByCode(result.paymentCode) : undefined;
      const { outcome } = await verifiedPaymentHandlerOf(ctx)(toPayment(companyId, 'vietqr', 'sepay', result, found));
      return outcome;
    });
  });
}

/**
 * Mô phỏng khách trả đủ tiền cho mã của công ty (demo, E2E; §12.11, plan #27 A12): đi đúng bước 4 của webhook, bỏ
 * bước chữ ký. Chỉ gắn route khi `NODE_ENV ≠ production`. Mã không có hoặc của công ty khác → 404.
 */
export function simulatePayment(ctx: PaymentContext, companyId: string, paymentCode: string) {
  return withCompany(companyId, async () => {
    const link = await findLinkByCode(paymentCode);
    if (!link) throw new AppError(404, 'not_found', 'Không tìm thấy mã thanh toán');
    const key = `sim:${paymentCode}`;
    return verifiedPaymentHandlerOf(ctx)({
      companyId,
      gateway: link.gateway,
      source: 'webhook',
      eventKey: key,
      gatewayTxnId: key,
      paymentCode,
      paymentLinkId: link.id,
      orderId: link.orderId,
      amount: new Decimal(link.amount),
      succeeded: true,
      fee: null,
      occurredAt: new Date(),
      rawPayload: { simulated: true },
    });
  });
}
