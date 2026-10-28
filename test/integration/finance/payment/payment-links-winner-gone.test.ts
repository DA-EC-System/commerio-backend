import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as LinkRepo from '#src/modules/finance/payment/repository/payment-links.ts';
import { testPool } from '../../helpers/db.ts';
import { createLink, linksOf, order, shop } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Nhánh 23505 của tạo mã (T10) mà mã của bên thắng đã đổi trạng thái trước khi bên thua đọc lại (commerio-backend#63 B8).
// Khe hẹp này không dựng được bằng thời gian thật: `beforeRead` chạy ngay trước lần đọc `findActiveLink` kế tiếp.
const hook = vi.hoisted(() => ({ beforeRead: undefined as (() => Promise<unknown>) | undefined }));
vi.mock('#src/modules/finance/payment/repository/payment-links.ts', async (importOriginal) => {
  const original = await importOriginal<typeof LinkRepo>();
  return {
    ...original,
    findActiveLink: async (orderId: string) => {
      const run = hook.beforeRead;
      hook.beforeRead = undefined;
      await run?.();
      return original.findActiveLink(orderId);
    },
  };
});

const MOMO_OK = { resultCode: 0, payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=abc', qrCodeUrl: 'momo://app?isScanQR=true' };

afterEach(() => {
  hook.beforeRead = undefined;
  vi.restoreAllMocks();
});

describe('tạo mã: bên thắng biến mất trước khi bên thua đọc lại (#63 B8)', () => {
  it.each([
    [
      'đơn bị huỷ, mã bên thắng cancelled',
      (orderId: string) =>
        testPool().query(
          `with o as (update "order".orders set status = 'cancelled' where id = $1)
           update finance.payment_links set status = 'cancelled' where order_id = $1 and status = 'active'`,
          [orderId],
        ),
    ],
    [
      'khách vừa trả mã bên thắng',
      (orderId: string) =>
        testPool().query(
          `with p as (update finance.order_payments set status = 'paid', paid_at = now() where order_id = $1)
           update finance.payment_links set status = 'paid' where order_id = $1 and status = 'active'`,
          [orderId],
        ),
    ],
  ])('%s → 409 payment_not_allowed, không 500, không thêm mã', async (_name, change) => {
    const s = await shop('vietqr', 'momo');
    const o = await order(s);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Trong lúc chờ MoMo, một yêu cầu khác tạo mã VietQR cho cùng đơn (bên thắng).
      expect((await createLink(s.sale.token, o.orderId, 'vietqr')).status).toBe(201);
      hook.beforeRead = () => change(o.orderId);
      return new Response(JSON.stringify(MOMO_OK));
    });
    const res = await createLink(s.sale.token, o.orderId, 'momo');
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/payment_not_allowed');
    // Lý do theo trạng thái mới của đơn (luật bước 1), không phải câu dự phòng.
    expect(res.body.detail).not.toBe('Mã thanh toán của đơn vừa thay đổi, tạo lại mã');
    const links = await linksOf(o.orderId);
    expect(links.map((l: { gateway: string }) => l.gateway)).toEqual(['vietqr']);
  });
});
