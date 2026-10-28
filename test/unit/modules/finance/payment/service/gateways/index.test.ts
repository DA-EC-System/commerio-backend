import { createHmac } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVietQr } from '#src/modules/finance/payment/domain/vietqr.ts';
import { GatewayFactory, type PaymentInput } from '#src/modules/finance/payment/service/gateways/index.ts';

// Adapter tạo mã của 4 cổng (Strategy + Factory, docs/16 #9; #23 AC-18…AC-22; ground-truth S1–S11, D1–D3).
// Không gọi mạng: fetch giả (test/CLAUDE.md luật 3). Chuỗi ký tính độc lập trong test theo tài liệu cổng.
const hmac = (alg: string, key: string, data: string) => createHmac(alg, key).update(data).digest('hex');

// 18/10/2026 23:30 giờ VN = 16:30 UTC: ngày VN và ngày UTC trùng; ca qua nửa đêm kiểm riêng.
const input: PaymentInput = {
  paymentCode: 'CMABCDEFGH23',
  orderCode: 'DH-1A2B3C4D',
  amount: new Decimal(150000),
  createdAt: new Date('2026-10-18T16:30:00Z'),
  expiresAt: new Date('2026-10-18T16:45:00Z'),
  clientIp: '::ffff:10.0.0.5',
  ipnBaseUrl: 'https://api.commerio.test/api/v1/payment/webhooks',
  returnUrl: 'https://commerio.test/thanh-toan/ket-qua',
};
const signal = AbortSignal.timeout(10_000);

function fakeFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe('VNPay (không gọi mạng)', () => {
  const creds = { tmnCode: 'TESTCODE', hashSecret: 'SECRETHASHKEY123' };

  it('dựng URL vpcpay đủ tham số, tiền × 100, giờ VN, ký HMAC-SHA512 trên tham số sắp xếp', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('không được gọi mạng'));
    const out = await GatewayFactory.of('vnpay').createPayment(input, creds, signal);
    expect(spy).not.toHaveBeenCalled();
    const url = new URL(out.payUrl!);
    expect(url.origin + url.pathname).toBe('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html');
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: 'TESTCODE',
      vnp_Amount: '15000000',
      vnp_CurrCode: 'VND',
      vnp_TxnRef: 'CMABCDEFGH23',
      vnp_OrderInfo: 'Thanh toan don DH1A2B3C4D',
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrl,
      vnp_IpAddr: '10.0.0.5',
      vnp_CreateDate: '20261018233000',
      vnp_ExpireDate: '20261018234500',
    });
    // Theo mã mẫu PHP của VNPay: urlencode từng tên và giá trị (dấu cách → +), nối & theo khoá tăng dần.
    const { vnp_SecureHash: hash, ...rest } = p;
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
    const data = Object.keys(rest)
      .sort()
      .map((k) => `${enc(k)}=${enc(rest[k]!)}`)
      .join('&');
    expect(hash).toBe(hmac('sha512', creds.hashSecret, data));
    expect(out).toMatchObject({ qrContent: out.payUrl, gatewayOrderRef: 'CMABCDEFGH23' });
  });

  it('ngày tạo theo giờ VN khi giờ UTC còn ở ngày hôm trước; IPv6 loopback đổi thành 127.0.0.1', async () => {
    const out = await GatewayFactory.of('vnpay').createPayment(
      { ...input, createdAt: new Date('2026-10-18T17:30:00Z'), expiresAt: new Date('2026-10-18T17:45:00Z'), clientIp: '::1' },
      creds,
      signal,
    );
    const p = new URL(out.payUrl!).searchParams;
    expect(p.get('vnp_CreateDate')).toBe('20261019003000');
    expect(p.get('vnp_IpAddr')).toBe('127.0.0.1');
  });
});

describe('MoMo', () => {
  const creds = { partnerCode: 'MOMO', accessKey: 'ACCESSKEY01', secretKey: 'SECRETKEY-MOMO-01' };

  it('gửi đúng body, chữ ký HMAC-SHA256 theo thứ tự a→z, nhận payUrl và qrCodeUrl', async () => {
    const spy = fakeFetch(200, { resultCode: 0, payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=x', qrCodeUrl: 'momo://app?x' });
    const out = await GatewayFactory.of('momo').createPayment(input, creds, signal);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://test-payment.momo.vn/v2/gateway/api/create');
    expect(init!.signal).toBe(signal);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      partnerCode: 'MOMO',
      requestId: 'CMABCDEFGH23',
      orderId: 'CMABCDEFGH23',
      amount: 150000,
      orderInfo: 'Thanh toan don DH1A2B3C4D',
      redirectUrl: input.returnUrl,
      ipnUrl: 'https://api.commerio.test/api/v1/payment/webhooks/momo',
      requestType: 'captureWallet',
      extraData: '',
      lang: 'vi',
      orderExpireTime: 15,
    });
    const raw =
      `accessKey=${creds.accessKey}&amount=150000&extraData=&ipnUrl=${body.ipnUrl}&orderId=CMABCDEFGH23` +
      `&orderInfo=${body.orderInfo}&partnerCode=MOMO&redirectUrl=${body.redirectUrl}&requestId=CMABCDEFGH23&requestType=captureWallet`;
    expect(body.signature).toBe(hmac('sha256', creds.secretKey, raw));
    expect(out).toEqual({ payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=x', qrContent: 'momo://app?x', gatewayOrderRef: 'CMABCDEFGH23' });
  });

  it('MoMo từ chối (HTTP 400 kèm resultCode) → 502 gateway_unavailable, không chép message của cổng', async () => {
    fakeFetch(400, { resultCode: 11007, message: 'Invalid signature. Raw data before hash: accessKey=***' });
    const err = await GatewayFactory.of('momo').createPayment(input, creds, signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'gateway_unavailable' });
    expect((err as Error).message).not.toContain('Raw data');
  });
});

describe('ZaloPay', () => {
  const creds = { appId: '2553', key1: 'KEY1-ZALOPAY-TEST', key2: 'KEY2-ZALOPAY-TEST' };

  it('gửi form, app_trans_id = yymmdd_<mã> theo giờ VN, mac key1, hạn 900 giây', async () => {
    const spy = fakeFetch(200, { return_code: 1, order_url: 'https://qcgateway.zalopay.vn/openinapp?order=x', qr_code: '000201xyz' });
    const out = await GatewayFactory.of('zalopay').createPayment(input, creds, signal);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://sb-openapi.zalopay.vn/v2/create');
    expect(init!.signal).toBe(signal);
    const f = Object.fromEntries(new URLSearchParams(String(init!.body)));
    expect(f).toMatchObject({
      app_id: '2553',
      app_trans_id: '261018_CMABCDEFGH23',
      app_user: 'commerio',
      amount: '150000',
      app_time: String(input.createdAt.getTime()),
      item: '[]',
      embed_data: JSON.stringify({ redirecturl: input.returnUrl }),
      description: 'Commerio - Thanh toan don DH1A2B3C4D',
      callback_url: 'https://api.commerio.test/api/v1/payment/webhooks/zalopay',
      expire_duration_seconds: '900',
    });
    const data = [f.app_id, f.app_trans_id, f.app_user, f.amount, f.app_time, f.embed_data, f.item].join('|');
    expect(f.mac).toBe(hmac('sha256', creds.key1, data));
    expect(out).toEqual({ payUrl: 'https://qcgateway.zalopay.vn/openinapp?order=x', qrContent: '000201xyz', gatewayOrderRef: '261018_CMABCDEFGH23' });
  });

  it('không có qr_code thì qrContent là order_url (app_id 554, S8)', async () => {
    fakeFetch(200, { return_code: 1, order_url: 'https://qcgateway.zalopay.vn/openinapp?order=y' });
    expect((await GatewayFactory.of('zalopay').createPayment(input, creds, signal)).qrContent).toBe(
      'https://qcgateway.zalopay.vn/openinapp?order=y',
    );
  });

  it('return_code khác 1, hoặc fetch lỗi mạng/quá hạn → 502 gateway_unavailable', async () => {
    fakeFetch(200, { return_code: 2, sub_return_code: -402 });
    await expect(GatewayFactory.of('zalopay').createPayment(input, creds, signal)).rejects.toMatchObject({ status: 502 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('quá hạn', 'TimeoutError'));
    await expect(GatewayFactory.of('zalopay').createPayment(input, creds, signal)).rejects.toMatchObject({
      status: 502,
      code: 'gateway_unavailable',
    });
  });
});

describe('VietQR (không gọi mạng)', () => {
  it('chuỗi EMVCo tới tài khoản công ty, nội dung là mã thanh toán', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('không được gọi mạng'));
    const creds = { bankBin: '970422', accountNo: '0123456789', accountName: 'CONG TY THU', sepayApiKey: 'SEPAY-KEY-1234' };
    const out = await GatewayFactory.of('vietqr').createPayment(input, creds, signal);
    expect(spy).not.toHaveBeenCalled();
    expect(out.payUrl).toBeNull();
    expect(out.gatewayOrderRef).toBeNull();
    expect(parseVietQr(out.qrContent)).toEqual({ bankBin: '970422', accountNo: '0123456789', amount: '150000', content: 'CMABCDEFGH23' });
  });
});
