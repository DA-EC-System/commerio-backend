import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GatewayFactory } from '#src/modules/payment/service/gateways/index.ts';

// Đọc và kiểm chữ ký callback của 4 cổng (Documents/21 §12.4; plan #27 A5–A7, A17, A18). Chuỗi ký tính độc lập ở đây
// theo tài liệu chính thức: VNPay (mẫu PHP, D1), MoMo IPN (D3), ZaloPay callback (D5), SePay API key (D7).

const hmac = (alg: 'sha256' | 'sha512', key: string, data: string) => createHmac(alg, key).update(data).digest('hex');
const input = (over: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> }) => ({
  query: over.query ?? {},
  body: over.body ?? {},
  headers: over.headers ?? {},
});

describe('VNPay IPN', () => {
  const credentials = { tmnCode: 'TESTCODE', hashSecret: 'SECRETHASHKEY123' };
  const vnpay = GatewayFactory.of('vnpay');
  // Mẫu PHP: urlencode (dấu cách → +), sắp khoá tăng dần, bỏ vnp_SecureHash, vnp_SecureHashType.
  const php = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  function signed(params: Record<string, string>) {
    const data = Object.keys(params)
      .sort()
      .map((k) => `${php(k)}=${php(params[k]!)}`)
      .join('&');
    return { ...params, vnp_SecureHashType: 'HmacSHA512', vnp_SecureHash: hmac('sha512', credentials.hashSecret, data).toUpperCase() };
  }
  const base = {
    vnp_Amount: '15000000',
    vnp_BankCode: 'NCB',
    vnp_BankTranNo: 'VNP14000001',
    vnp_CardType: 'ATM',
    vnp_OrderInfo: 'Thanh toan don DH12345678',
    vnp_PayDate: '20261018101530',
    vnp_ResponseCode: '00',
    vnp_TmnCode: 'TESTCODE',
    vnp_TransactionNo: '14000001',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: 'CMABCDEFGHJK',
  };

  it('lấy mã thanh toán từ vnp_TxnRef trước khi có khoá', () => {
    expect(vnpay.codeOf(input({ query: base }))).toBe('CMABCDEFGHJK');
    expect(vnpay.codeOf(input({ query: {} }))).toBeNull();
  });

  it('chữ ký đúng → kết quả thành công, số tiền chia 100, ngày giờ VN, payload bỏ chữ ký', () => {
    const r = vnpay.readCallback(input({ query: signed(base) }), credentials);
    expect(r).toMatchObject({
      paymentCode: 'CMABCDEFGHJK',
      eventKey: '14000001',
      gatewayTxnId: '14000001',
      succeeded: true,
      occurredAt: new Date('2026-10-18T03:15:30Z'),
    });
    if (r === 'bad_signature') throw new Error('sai');
    expect(r.amount.toFixed(0)).toBe('150000');
    expect(r.rawPayload).not.toHaveProperty('vnp_SecureHash');
    expect(r.rawPayload).not.toHaveProperty('vnp_SecureHashType');
  });

  it('giá trị có dấu cách vẫn khớp chữ ký theo urlencode của PHP', () => {
    const q = signed({ ...base, vnp_OrderInfo: 'Thanh toan don hang 01' });
    expect(vnpay.readCallback(input({ query: q }), credentials)).not.toBe('bad_signature');
  });

  it('sửa một tham số, sai khoá, thiếu chữ ký → bad_signature', () => {
    const q = signed(base);
    expect(vnpay.readCallback(input({ query: { ...q, vnp_Amount: '15000100' } }), credentials)).toBe('bad_signature');
    expect(vnpay.readCallback(input({ query: q }), { ...credentials, hashSecret: 'KHOAKHAC12345678' })).toBe('bad_signature');
    const noHash: Record<string, string> = { ...q };
    delete noHash.vnp_SecureHash;
    expect(vnpay.readCallback(input({ query: noHash }), credentials)).toBe('bad_signature');
  });

  it('giao dịch thất bại vnp_TransactionNo = 0: không thành công, khoá chống trùng gắn mã và mã lỗi (A7)', () => {
    const r = vnpay.readCallback(
      input({ query: signed({ ...base, vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_TransactionNo: '0' }) }),
      credentials,
    );
    expect(r).toMatchObject({ succeeded: false, eventKey: '0:CMABCDEFGHJK:24', gatewayTxnId: '0:CMABCDEFGHJK:24' });
  });

  it('phản hồi theo §12.4: 00 đã ghi, 02 đã xử lý, 01 không thấy mã, 97 sai chữ ký, 99 lỗi', () => {
    expect(vnpay.respond('recorded')).toEqual({ status: 200, body: { RspCode: '00', Message: 'Confirm Success' } });
    expect(vnpay.respond('unmatched').body).toMatchObject({ RspCode: '00' });
    expect(vnpay.respond('failed').body).toMatchObject({ RspCode: '00' });
    expect(vnpay.respond('duplicate').body).toMatchObject({ RspCode: '02' });
    expect(vnpay.respond('not_found').body).toMatchObject({ RspCode: '01' });
    expect(vnpay.respond('bad_signature').body).toMatchObject({ RspCode: '97' });
    expect(vnpay.respond('error')).toMatchObject({ status: 200, body: { RspCode: '99' } });
  });
});

describe('MoMo IPN', () => {
  const credentials = { partnerCode: 'MOMO', accessKey: 'ACCESSKEY-0001', secretKey: 'SECRETKEY-ABCDEF-9999' };
  const momo = GatewayFactory.of('momo');
  function ipn(over: Record<string, unknown> = {}) {
    const b = {
      partnerCode: 'MOMO',
      orderId: 'CMABCDEFGHJK',
      requestId: 'CMABCDEFGHJK',
      amount: 150000,
      orderInfo: 'Thanh toan don DH12345678',
      orderType: 'momo_wallet',
      transId: 4088878653,
      resultCode: 0,
      message: 'Thành công.',
      payType: 'qr',
      responseTime: 1792327116901,
      extraData: '',
      ...over,
    };
    const raw =
      `accessKey=${credentials.accessKey}&amount=${b.amount}&extraData=${b.extraData}&message=${b.message}` +
      `&orderId=${b.orderId}&orderInfo=${b.orderInfo}&orderType=${b.orderType}&partnerCode=${b.partnerCode}` +
      `&payType=${b.payType}&requestId=${b.requestId}&responseTime=${b.responseTime}&resultCode=${b.resultCode}&transId=${b.transId}`;
    return { ...b, signature: hmac('sha256', credentials.secretKey, raw) };
  }

  it('chữ ký đúng → thành công, khoá chống trùng là transId, payload bỏ chữ ký', () => {
    expect(momo.codeOf(input({ body: ipn() }))).toBe('CMABCDEFGHJK');
    const r = momo.readCallback(input({ body: ipn() }), credentials);
    expect(r).toMatchObject({ paymentCode: 'CMABCDEFGHJK', eventKey: '4088878653', succeeded: true });
    if (r === 'bad_signature') throw new Error('sai');
    expect(r.amount.toFixed(0)).toBe('150000');
    expect(r.occurredAt).toEqual(new Date(1792327116901));
    expect(r.rawPayload).not.toHaveProperty('signature');
  });

  it('resultCode ≠ 0 → không thành công', () => {
    expect(momo.readCallback(input({ body: ipn({ resultCode: 1006, message: 'Người dùng từ chối' }) }), credentials)).toMatchObject({
      succeeded: false,
    });
  });

  it('sửa số tiền sau khi ký, body không phải object → bad_signature / không có mã', () => {
    expect(momo.readCallback(input({ body: { ...ipn(), amount: 1000 } }), credentials)).toBe('bad_signature');
    expect(momo.codeOf(input({ body: 'x' }))).toBeNull();
  });

  it('phản hồi: 204 không body khi đã ghi/đã xử lý, 400 sai chữ ký hoặc không thấy mã', () => {
    expect(momo.respond('recorded')).toEqual({ status: 204, body: undefined });
    expect(momo.respond('duplicate')).toEqual({ status: 204, body: undefined });
    expect(momo.respond('bad_signature').status).toBe(400);
    expect(momo.respond('not_found').status).toBe(400);
    expect(momo.respond('error').status).toBe(500);
  });
});

describe('ZaloPay callback', () => {
  const credentials = { appId: '2553', key1: 'KEY1-ZALOPAY-TEST', key2: 'KEY2-ZALOPAY-TEST' };
  const zalopay = GatewayFactory.of('zalopay');
  const data = JSON.stringify({
    app_id: 2553,
    app_trans_id: '261018_CMABCDEFGHJK',
    app_time: 1792327116000,
    app_user: 'commerio',
    amount: 150000,
    embed_data: '{}',
    item: '[]',
    zp_trans_id: 261018000000123,
    server_time: 1792327200000,
    channel: 38,
    merchant_user_id: 'u1',
    user_fee_amount: 0,
    discount_amount: 0,
  });
  const body = { data, mac: hmac('sha256', credentials.key2, data), type: 1 };

  it('mac = HMAC-SHA256(key2, data gốc) → thành công, mã lấy từ app_trans_id', () => {
    expect(zalopay.codeOf(input({ body }))).toBe('CMABCDEFGHJK');
    const r = zalopay.readCallback(input({ body }), credentials);
    expect(r).toMatchObject({ paymentCode: 'CMABCDEFGHJK', eventKey: '261018000000123', succeeded: true });
    if (r === 'bad_signature') throw new Error('sai');
    expect(r.amount.toFixed(0)).toBe('150000');
    expect(r.occurredAt).toEqual(new Date(1792327200000));
    expect(r.rawPayload).not.toHaveProperty('mac');
  });

  it('mac sai, mac ký bằng key1 → bad_signature; app_trans_id không có dấu _ → không có mã', () => {
    expect(zalopay.readCallback(input({ body: { ...body, mac: hmac('sha256', credentials.key1, data) } }), credentials)).toBe(
      'bad_signature',
    );
    const noUnderscore = JSON.stringify({ app_trans_id: 'CMABCDEFGHJK' });
    expect(zalopay.codeOf(input({ body: { data: noUnderscore, mac: 'x', type: 1 } }))).toBeNull();
  });

  it('data ký đúng nhưng thiếu zp_trans_id → lỗi, không dựng khoá "undefined"', () => {
    const noTxn = JSON.stringify({ app_trans_id: '261018_CMABCDEFGHJK', amount: 150000 });
    expect(() =>
      zalopay.readCallback(input({ body: { data: noTxn, mac: hmac('sha256', credentials.key2, noTxn), type: 1 } }), credentials),
    ).toThrow(/zp_trans_id/);
  });

  it('phản hồi: 1 đã ghi, 2 đã xử lý, -1 sai mac hoặc không thấy mã, 0 lỗi để ZaloPay gửi lại', () => {
    expect(zalopay.respond('recorded')).toEqual({ status: 200, body: { return_code: 1, return_message: 'success' } });
    expect(zalopay.respond('duplicate').body).toMatchObject({ return_code: 2 });
    expect(zalopay.respond('bad_signature').body).toMatchObject({ return_code: -1 });
    expect(zalopay.respond('not_found').body).toMatchObject({ return_code: -1 });
    expect(zalopay.respond('error').body).toMatchObject({ return_code: 0 });
  });
});

describe('SePay (cổng vietqr)', () => {
  const credentials = { bankBin: '970422', accountNo: '0123456789', accountName: 'CONG TY THU', sepayApiKey: 'SEPAY-KEY-55667788' };
  const vietqr = GatewayFactory.of('vietqr');
  const tx = {
    id: 92704,
    gateway: 'MBBank',
    transactionDate: '2026-10-18 10:15:30',
    accountNumber: '0123456789',
    code: null,
    content: 'NGUYEN VAN A chuyen tien CMABCDEFGHJK FT2629',
    transferType: 'in',
    transferAmount: 150000,
    accumulated: 0,
    subAccount: '',
    referenceCode: 'FT2629',
    description: '',
  };
  const auth = { authorization: 'Apikey SEPAY-KEY-55667788' };

  it('API key đúng → mã tìm trong content khi code null; giờ VN; khoá chống trùng là id', () => {
    const r = vietqr.readCallback(input({ body: tx, headers: auth }), credentials);
    expect(r).toMatchObject({ paymentCode: 'CMABCDEFGHJK', eventKey: '92704', succeeded: true, occurredAt: new Date('2026-10-18T03:15:30Z') });
    if (r === 'bad_signature') throw new Error('sai');
    expect(r.amount.toFixed(0)).toBe('150000');
  });

  it('code của SePay có giá trị thì dùng code; không có mã nào → paymentCode null', () => {
    expect(vietqr.readCallback(input({ body: { ...tx, code: 'CMZZZZZZZZZZ' }, headers: auth }), credentials)).toMatchObject({
      paymentCode: 'CMZZZZZZZZZZ',
    });
    expect(vietqr.readCallback(input({ body: { ...tx, content: 'chuyen tien hang thang' }, headers: auth }), credentials)).toMatchObject({
      paymentCode: null,
    });
  });

  it('code của SePay không đúng dạng mã (tiền tố công ty khác) → tìm trong content; content chữ thường vẫn khớp', () => {
    expect(vietqr.readCallback(input({ body: { ...tx, code: 'DH123' }, headers: auth }), credentials)).toMatchObject({
      paymentCode: 'CMABCDEFGHJK',
    });
    expect(
      vietqr.readCallback(input({ body: { ...tx, content: 'ck cmabcdefghjk' }, headers: auth }), credentials),
    ).toMatchObject({ paymentCode: 'CMABCDEFGHJK' });
  });

  it('thiếu id giao dịch → lỗi (cổng gửi lại), không dựng khoá chống trùng "undefined"', () => {
    const { id: _id, ...noId } = tx;
    void _id;
    expect(() => vietqr.readCallback(input({ body: noId, headers: auth }), credentials)).toThrow(/thiếu id/);
  });

  it('thiếu header, sai key, sai tiền tố → bad_signature', () => {
    expect(vietqr.readCallback(input({ body: tx }), credentials)).toBe('bad_signature');
    expect(vietqr.readCallback(input({ body: tx, headers: { authorization: 'Apikey SAI-KEY-00000000' } }), credentials)).toBe(
      'bad_signature',
    );
    expect(vietqr.readCallback(input({ body: tx, headers: { authorization: 'Bearer SEPAY-KEY-55667788' } }), credentials)).toBe(
      'bad_signature',
    );
  });

  it('phản hồi: 200 {success:true} khi đã ghi/đã xử lý/chưa khớp, 401 sai key, 404 không thấy công ty', () => {
    expect(vietqr.respond('recorded')).toEqual({ status: 200, body: { success: true } });
    expect(vietqr.respond('duplicate')).toEqual({ status: 200, body: { success: true } });
    expect(vietqr.respond('unmatched')).toEqual({ status: 200, body: { success: true } });
    expect(vietqr.respond('bad_signature')).toEqual({ status: 401, body: { success: false } });
    expect(vietqr.respond('not_found')).toEqual({ status: 404, body: { success: false } });
  });
});
