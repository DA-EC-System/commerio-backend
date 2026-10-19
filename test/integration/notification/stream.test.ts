import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { addMember, createCompany, createCustomRole } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, PASSWORD, selectCompany, testApp } from '../helpers/http.ts';
import { lockCompany, setModuleEnabled, suspendMembership } from '../helpers/state.ts';
import { loadCompanyAccess } from '#src/modules/identity/index.ts';
import { createHub } from '#src/modules/notification/index.ts';
import type { EventEnvelope, EventType } from '#src/modules/platform/index.ts';
import { signAccessToken } from '#src/shared/auth/jwt.ts';
import { closeServer } from '#src/shared/lifecycle.ts';
import { openStream, type Stream, startRealtime } from './helpers.ts';

// Stream SSE của realtime trên app thật (createRealtimeApp) và PostgreSQL thật; sự kiện đưa thẳng vào hub
// (luồng Kafka thật ở kafka.test.ts). Supertest đệm cả response nên đọc bằng fetch trên cổng thật.
const hub = createHub();
let server: Server;
let base: string;

beforeAll(async () => {
  ({ server, url: base } = await startRealtime({ hub, heartbeatMs: 100 }));
});

afterAll(async () => {
  hub.closeAll();
  await closeServer(server);
});

const opened: Stream[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.abort();
});

async function open(token?: string): Promise<Stream> {
  const stream = await openStream(base, token);
  opened.push(stream);
  return stream;
}

/** Mở stream và chờ hub nhận kết nối (dòng `retry:` đã tới). */
async function connect(token: string): Promise<Stream> {
  const stream = await open(token);
  expect(stream.status).toBe(200);
  await stream.until((t) => t.includes('retry: 3000'));
  return stream;
}

const event = (type: EventType, companyId: string, payload: Record<string, unknown>) =>
  ({ eventId: randomUUID(), type, companyId, aggregateId: randomUUID(), occurredAt: new Date().toISOString(), payload }) as EventEnvelope<EventType>;
const orderCreated = (companyId: string) =>
  event('sales.order_created', companyId, { orderId: randomUUID(), code: 'DH-0001', source: 'manual', total: '150000.00' });
const paymentSucceeded = (companyId: string) =>
  event('payment.succeeded', companyId, { orderId: randomUUID(), paymentTransactionId: randomUUID(), gateway: 'vnpay', amount: '150000.00' });
const belowThreshold = (companyId: string) => event('inventory.below_threshold', companyId, { variantId: randomUUID(), available: 1, minQty: 5 });
const poSubmitted = (companyId: string) => event('purchasing.order_submitted', companyId, { purchaseOrderId: randomUUID(), code: 'PO-0001' });

async function problem(stream: Stream) {
  expect(await stream.ended()).toBe(true);
  const body = JSON.parse(stream.text());
  return { status: stream.status, type: body.type as string, contentType: stream.headers.get('content-type') };
}

describe('mở stream: xác thực và truy cập công ty (S1)', () => {
  it('thiếu token, token sai → 401 unauthorized', async () => {
    expect(await problem(await open())).toMatchObject({ status: 401, type: '/problems/unauthorized' });
    expect(await problem(await open('khong-phai-jwt'))).toMatchObject({ status: 401, type: '/problems/unauthorized' });
  });

  it('còn mật khẩu thư mời → 403 password_change_required', async () => {
    const token = await signAccessToken({ accountId: randomUUID(), companyId: randomUUID(), permissions: [], mustChangePassword: true, passwordChangedAt: null });
    expect(await problem(await open(token))).toMatchObject({ status: 403, type: '/problems/password_change_required' });
  });

  it('token chưa chọn công ty → 403 company_not_selected', async () => {
    const { ceo } = await createCompany();
    const { token } = await login(ceo.email);
    const result = await problem(await open(token));
    expect(result).toMatchObject({ status: 403, type: '/problems/company_not_selected' });
    expect(result.contentType).toContain('application/problem+json');
  });

  it('không còn thuộc công ty → 404; tài khoản khoá → 403 account_locked; công ty khoá → 403 company_locked', async () => {
    const { companyId } = await createCompany();
    const removed = await addMember(companyId, 'sale');
    await testPool().query('delete from access.member_roles where membership_id = $1', [removed.membershipId]);
    await testPool().query('delete from staff.memberships where id = $1', [removed.membershipId]);
    expect(await problem(await open(removed.token))).toMatchObject({ status: 404, type: '/problems/not_found' });

    const suspended = await addMember(companyId, 'sale');
    await suspendMembership(suspended.membershipId);
    expect(await problem(await open(suspended.token))).toMatchObject({ status: 403, type: '/problems/account_locked' });

    const sale = await addMember(companyId, 'sale');
    await connect(sale.token); // mở được trước khi khoá
    await lockCompany(companyId);
    expect(await problem(await open(sale.token))).toMatchObject({ status: 403, type: '/problems/company_locked' });
  });
});

describe('stream đang mở (AC-1, AC-3, AC-4, AC-5, AC-9, A9)', () => {
  it('200 text/event-stream, header chống đệm, retry rồi heartbeat', async () => {
    const { ceo } = await createCompany();
    const stream = await connect(ceo.token);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.text().startsWith('retry: 3000\n\n')).toBe(true);
    await stream.until((t) => t.split(': ping\n\n').length > 2);
  });

  it('đúng công ty, đúng quyền theo bảng D11 (A1 "hoặc" cho thanh toán)', async () => {
    const [a, b] = await Promise.all([createCompany(), createCompany()]);
    const financeOnly = await addMember(a.companyId, await createCustomRole(a.companyId, ['finance.invoice.view']));
    const [ceo, admin, sale, warehouse, finance, otherCeo] = await Promise.all([
      connect(a.ceo.token),
      addMember(a.companyId, 'admin').then((m) => connect(m.token)),
      addMember(a.companyId, 'sale').then((m) => connect(m.token)),
      addMember(a.companyId, 'warehouse').then((m) => connect(m.token)),
      connect(financeOnly.token),
      connect(b.ceo.token),
    ]);

    const order = orderCreated(a.companyId);
    const payment = paymentSucceeded(a.companyId);
    const stock = belowThreshold(a.companyId);
    const po = poSubmitted(a.companyId);
    for (const e of [order, payment, stock, po]) hub.dispatch(e);
    await ceo.until((t) => t.includes(po.eventId));

    const got = (s: Stream) => [order, payment, stock, po].filter((e) => s.text().includes(`id: ${e.eventId}`)).map((e) => e.type);
    // CEO nhận cuối cùng (đơn mua) nên khi CEO đủ thì các kết nối khác cũng đã được ghi xong.
    await sale.until((t) => t.includes(payment.eventId));
    expect(got(ceo)).toEqual(['sales.order_created', 'payment.succeeded', 'inventory.below_threshold', 'purchasing.order_submitted']);
    expect(got(admin)).toEqual(['sales.order_created', 'payment.succeeded', 'inventory.below_threshold']);
    expect(got(sale)).toEqual(['sales.order_created', 'payment.succeeded']);
    expect(got(warehouse)).toEqual(['inventory.below_threshold']);
    expect(got(finance)).toEqual(['payment.succeeded']);
    expect(got(otherCeo)).toEqual([]);

    // Message thanh toán không mang mã giao dịch cổng, công ty, aggregateId (A4).
    const payload = payment.payload as { paymentTransactionId: string };
    expect(sale.text()).not.toContain(payload.paymentTransactionId);
    expect(sale.text()).not.toContain(payment.aggregateId);
    expect(sale.text()).not.toContain(a.companyId);
    expect(sale.text()).toContain('"amount":150000');
  });

  it('phân hệ tắt lúc mở thì quyền của nó không tính', async () => {
    const { companyId, ceo } = await createCompany();
    await setModuleEnabled(companyId, 'purchasing', false);
    const stream = await connect(ceo.token);
    const po = poSubmitted(companyId);
    const order = orderCreated(companyId);
    hub.dispatch(po);
    hub.dispatch(order);
    await stream.until((t) => t.includes(order.eventId));
    expect(stream.text()).not.toContain(po.eventId);
  });

  it('người không có quyền nào trong bảng vẫn mở được, chỉ nhận heartbeat (A9)', async () => {
    const { companyId } = await createCompany();
    const member = await addMember(companyId, await createCustomRole(companyId, ['catalog.product.view']));
    const stream = await connect(member.token);
    const order = orderCreated(companyId);
    hub.dispatch(order);
    await stream.until((t) => t.split(': ping\n\n').length > 2);
    expect(stream.text()).not.toContain('event:');
  });

  it('ngắt rồi nối lại: nhận sự kiện mới, không phát lại sự kiện lúc ngắt (AC-5)', async () => {
    const { companyId, ceo } = await createCompany();
    const before = hub.size();
    const first = await connect(ceo.token);
    first.abort();
    await vi.waitUntil(() => hub.size() === before, { timeout: 5_000 });
    const missed = orderCreated(companyId);
    hub.dispatch(missed);
    const second = await connect(ceo.token);
    const next = orderCreated(companyId);
    hub.dispatch(next);
    await second.until((t) => t.includes(next.eventId));
    expect(second.text()).not.toContain(missed.eventId);
  });

  it('client đóng thì hub gỡ kết nối', async () => {
    const { ceo } = await createCompany();
    const before = hub.size();
    const stream = await connect(ceo.token);
    expect(hub.size()).toBe(before + 1);
    stream.abort();
    await vi.waitUntil(() => hub.size() === before, { timeout: 5_000 });
  });

  it('server đóng stream đúng lúc token hết hạn (AC-9)', async () => {
    const { ceo } = await createCompany();
    const { exp } = JSON.parse(Buffer.from(ceo.token.split('.')[1]!, 'base64url').toString()) as { exp: number };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(exp * 1000 - 1_000);
      const started = performance.now();
      const stream = await connect(ceo.token);
      expect(await stream.ended(4_000)).toBe(true);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThan(500);
      expect(elapsed).toBeLessThan(2_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closeAll (tắt realtime): stream kết thúc, server đóng được ngay (S3)', async () => {
    const localHub = createHub();
    const local = await startRealtime({ hub: localHub });
    const { ceo } = await createCompany();
    const stream = await openStream(local.url, ceo.token);
    await stream.until((t) => t.includes('retry:'));
    localHub.closeAll();
    const closing = closeServer(local.server);
    expect(await stream.ended()).toBe(true);
    await expect(Promise.race([closing.then(() => 'đã đóng'), new Promise((r) => setTimeout(() => r('treo'), 2_000))])).resolves.toBe('đã đóng');
    localHub.dispatch(orderCreated(randomUUID())); // không ném sau khi đã đóng
  });

  /** App riêng có `loadAccess` chậm 300 ms, để client đóng hoặc tiến trình tắt đúng lúc đang kiểm quyền. */
  async function slowRealtime(localHub: ReturnType<typeof createHub>) {
    let pending = 0;
    const local = await startRealtime({
      hub: localHub,
      loadAccess: async (accountId, companyId) => {
        pending++;
        try {
          await sleep(300);
          return await loadCompanyAccess(accountId, companyId);
        } finally {
          pending--;
        }
      },
    });
    return { ...local, pending: () => pending };
  }

  it('client đóng lúc server còn đang kiểm quyền: không để lại kết nối chết trong hub', async () => {
    const localHub = createHub();
    const local = await slowRealtime(localHub);
    const { ceo } = await createCompany();
    const controller = new AbortController();
    const res = fetch(local.url, { headers: { authorization: `Bearer ${ceo.token}` }, signal: controller.signal }).catch(() => null);
    await vi.waitUntil(() => local.pending() === 1, { timeout: 5_000, interval: 10 });
    controller.abort();
    await res;
    await vi.waitUntil(() => local.pending() === 0, { timeout: 5_000, interval: 10 });
    await sleep(50);
    expect(localHub.size()).toBe(0);
    await closeServer(local.server);
  });

  it('tắt realtime lúc có stream đang kiểm quyền: stream đó đóng ngay, server không treo', async () => {
    const localHub = createHub();
    const local = await slowRealtime(localHub);
    const { ceo } = await createCompany();
    const opening = openStream(local.url, ceo.token);
    await vi.waitUntil(() => local.pending() === 1, { timeout: 5_000, interval: 10 });
    localHub.closeAll();
    const closing = closeServer(local.server);
    const stream = await opening;
    expect(await stream.ended(2_000)).toBe(true);
    await expect(Promise.race([closing.then(() => 'đã đóng'), sleep(2_000).then(() => 'treo')])).resolves.toBe('đã đóng');
    expect(localHub.size()).toBe(0);
  });
});

describe('mở stream bằng token phát trước lần đổi mật khẩu (#62 AC-3)', () => {
  it('token cũ → 401 unauthorized; token sau khi đăng nhập lại mở được', async () => {
    const { companyId, ceo } = await createCompany();
    const { token } = await login(ceo.email);
    const changed = await request(testApp())
      .post('/api/v1/identity/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'MatKhauMoi9' });
    expect(changed.status).toBe(204);
    expect(await problem(await open(ceo.token))).toMatchObject({ status: 401, type: '/problems/unauthorized' });
    const again = await login(ceo.email, 'MatKhauMoi9');
    await connect(await selectCompany(again.token, companyId));
  });
});
