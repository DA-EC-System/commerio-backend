import { Decimal } from 'decimal.js';
import request from 'supertest';
import { expect, vi } from 'vitest';
import { handleVerifiedPayment } from '#src/modules/finance/finance/index.ts';
import {
  initOrderPayment,
  markDelivered,
  markRefundPending,
  type VerifiedGatewayPayment,
} from '#src/modules/finance/payment/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { type CREDENTIALS, createLink, order, shop } from '../payment/helpers.ts';

// Helper riêng của test finance (#27). File dùng chúng phải đặt PAYMENT_CREDENTIALS_KEY trong vi.hoisted.

type Gateway = keyof typeof CREDENTIALS;

/** Trả lời giả của cổng khi tạo mã (MoMo, ZaloPay gọi mạng; VNPay, VietQR không). */
function fakeCreate(gateway: Gateway) {
  if (gateway === 'momo') return { resultCode: 0, payUrl: 'https://test-payment.momo.vn/pay?t=x', qrCodeUrl: 'momo://x' };
  if (gateway === 'zalopay') return { return_code: 1, order_url: 'https://qcgateway.zalopay.vn/openinapp?order=x' };
  return undefined;
}

/**
 * Công ty đã lưu khoá cổng, một đơn trả trước 150.000 đ và một mã thanh toán tạo qua API của #23 (đường thật, L004).
 * `fetch` ra cổng bị thay bằng bản giả chỉ trong lúc tạo mã.
 */
export async function linkedOrder(gateway: Gateway = 'vietqr', unitPrice = 150000) {
  const s = await shop(gateway);
  const o = await order(s, unitPrice);
  const reply = fakeCreate(gateway);
  const spy = reply
    ? vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(reply), { status: 200 }))
    : undefined;
  const res = await createLink(s.sale.token, o.orderId, gateway);
  spy?.mockRestore();
  expect(res.status).toBe(201);
  return { ...s, ...o, link: res.body as { id: string; paymentCode: string; amount: number } };
}

let seq = 0;
/** Kết quả cổng đã kiểm chữ ký, mặc định thành công đủ tiền cho mã của `l`. */
export function verified(
  l: { companyId: string; orderId: string; link: { id: string; paymentCode: string } },
  over: Partial<VerifiedGatewayPayment> = {},
): VerifiedGatewayPayment {
  const key = `T${Date.now()}${++seq}`;
  return {
    companyId: l.companyId,
    gateway: 'vietqr',
    source: 'sepay',
    eventKey: key,
    gatewayTxnId: key,
    paymentCode: l.link.paymentCode,
    paymentLinkId: l.link.id,
    orderId: l.orderId,
    amount: new Decimal(150000),
    succeeded: true,
    fee: null,
    occurredAt: new Date(),
    rawPayload: { content: `chuyen tien ${l.link.paymentCode}` },
    ...over,
  };
}

const rows = async (sql: string, params: unknown[]) => (await testPool().query(sql, params)).rows;

/** Mọi thứ webhook có thể ghi cho một công ty, để so trước/sau. */
export async function moneyRows(companyId: string) {
  const [txns, events, receipts, unmatched, outbox] = await Promise.all([
    rows('select gateway, gateway_txn_id, status, source, amount, order_id, payment_link_id from payment.payment_transactions where company_id = $1 order by created_at', [companyId]),
    rows('select gateway, event_key from payment.webhook_events where company_id = $1', [companyId]),
    rows('select number, source, amount, order_id, payment_transaction_id, status from finance.receipts where company_id = $1 order by number', [companyId]),
    rows('select reason, status, amount, transfer_content, payment_transaction_id from finance.unmatched_receipts where company_id = $1', [companyId]),
    rows("select type, payload from platform.outbox_messages where company_id = $1 and type in ('payment.succeeded', 'finance.receipt_posted') order by id", [companyId]),
  ]);
  return { txns, events, receipts, unmatched, outbox };
}

export const orderPayment = async (orderId: string) =>
  (await rows('select status, refund_status, paid_at from payment.order_payments where order_id = $1', [orderId]))[0];

export const linkStatus = async (linkId: string) =>
  (await rows('select status from payment.payment_links where id = $1', [linkId]))[0]?.status as string | undefined;

/** Gọi API finance bằng token; `body` có thì gửi JSON. */
export function api(method: 'get' | 'post' | 'put' | 'delete', path: string, token?: string, body?: object) {
  const req = request(testApp())[method](`/api/v1/finance${path}`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
}

/** Đơn trả trước đã thu qua cổng (handler webhook thật), có phiếu thu PT. */
export async function paidOrder() {
  const l = await linkedOrder();
  const outcome = await withCompany(l.companyId, () => handleVerifiedPayment(verified(l)));
  expect(outcome).toEqual({ outcome: 'recorded' });
  return l;
}

/** Đơn đã thu rồi bị huỷ: hoàn tiền `pending_refund` (đường của #25: đổi đơn rồi `markRefundPending`). */
export async function refundPendingOrder() {
  const l = await paidOrder();
  await testPool().query("update sales.orders set status = 'cancelled', updated_at = now() where id = $1", [l.orderId]); // của #25
  await withCompany(l.companyId, () => markRefundPending(l.orderId));
  return l;
}

/** Đơn COD đã xác nhận (`cod_pending`) của công ty; `delivered` thì #25 đã gọi `markDelivered`. */
export async function codOrder(s: { companyId: string; variantId: string }, delivered = true, unitPrice = 200000) {
  const o = await order(s, unitPrice, { paymentMethod: 'cod' });
  await withCompany(s.companyId, async () => {
    await initOrderPayment(o.orderId, 'cod');
    if (delivered) await markDelivered(o.orderId, new Date('2026-10-18T03:00:00Z'));
  });
  return o;
}
