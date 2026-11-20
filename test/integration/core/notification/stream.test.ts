import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, PASSWORD, selectCompany, testApp } from '../../helpers/http.ts';
import { lockCompany, setModuleEnabled, suspendMembership } from '../../helpers/state.ts';
import { loadCompanyAccess } from '#src/modules/core/identity/index.ts';
import { createHub } from '#src/modules/core/notification/index.ts';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import type { OutboxRow } from '#src/modules/core/platform/repository/outbox.ts';
import { toKafkaMessage } from '#src/modules/core/platform/service/outbox/relay.ts';
import type { EventEnvelope, EventType } from '#src/modules/core/platform/index.ts';
import { settleCancelledOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { signAccessToken } from '#src/shared/auth/jwt.ts';
import { closeServer } from '#src/shared/lifecycle.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { seedPackage } from '../../order/fulfillment/helpers.ts';
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
const packageLost = (companyId: string) =>
  event('fulfillment.package_lost', companyId, { packageId: randomUUID(), orderId: randomUUID(), claimCode: null });
const belowThreshold = (companyId: string) => event('inventory.below_threshold', companyId, { variantId: randomUUID(), available: 1, minQty: 5 });
const poSubmitted = (companyId: string) => event('purchasing.request_submitted', companyId, { requestId: randomUUID(), number: 'DN-000001' });

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
    await testPool().query('delete from core.member_roles where membership_id = $1', [removed.membershipId]);
    await testPool().query('delete from core.memberships where id = $1', [removed.membershipId]);
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

  it('đúng công ty, đúng quyền theo bảng D11 (D1 "hoặc" cho kiện)', async () => {
    const [a, b] = await Promise.all([createCompany(), createCompany()]);
    const packerOnly = await addMember(a.companyId, await createCustomRole(a.companyId, ['fulfillment.order.process']));
    const [ceo, admin, sale, warehouse, packer, otherCeo] = await Promise.all([
      connect(a.ceo.token),
      addMember(a.companyId, 'admin').then((m) => connect(m.token)),
      addMember(a.companyId, 'sale').then((m) => connect(m.token)),
      addMember(a.companyId, 'warehouse').then((m) => connect(m.token)),
      connect(packerOnly.token),
      connect(b.ceo.token),
    ]);

    const order = orderCreated(a.companyId);
    const lost = packageLost(a.companyId);
    const stock = belowThreshold(a.companyId);
    const po = poSubmitted(a.companyId);
    for (const e of [order, lost, stock, po]) hub.dispatch(e);
    await ceo.until((t) => t.includes(po.eventId));

    const got = (s: Stream) => [order, lost, stock, po].filter((e) => s.text().includes(`id: ${e.eventId}`)).map((e) => e.type);
    // CEO nhận cuối cùng (đơn mua) nên khi CEO đủ thì các kết nối khác cũng đã được ghi xong.
    await sale.until((t) => t.includes(lost.eventId));
    expect(got(ceo)).toEqual(['sales.order_created', 'fulfillment.package_lost', 'inventory.below_threshold', 'purchasing.request_submitted']);
    expect(got(admin)).toEqual(['sales.order_created', 'fulfillment.package_lost', 'inventory.below_threshold']);
    expect(got(sale)).toEqual(['sales.order_created', 'fulfillment.package_lost']);
    expect(got(warehouse)).toEqual(['fulfillment.package_lost', 'inventory.below_threshold']);
    expect(got(packer)).toEqual(['fulfillment.package_lost']);
    expect(got(otherCeo)).toEqual([]);

    // Message không mang công ty, aggregateId (A4).
    expect(sale.text()).not.toContain(lost.aggregateId);
    expect(sale.text()).not.toContain(a.companyId);
  });

  it('bảy loại mới tới đúng vai trò, payload parse bằng schema strict (AC4)', async () => {
    const { companyId, ceo: owner } = await createCompany({ optionalModules: [] });
    const [ceo, admin, sale, warehouse] = await Promise.all([
      connect(owner.token),
      addMember(companyId, 'admin').then((m) => connect(m.token)),
      addMember(companyId, 'sale').then((m) => connect(m.token)),
      addMember(companyId, 'warehouse').then((m) => connect(m.token)),
    ]);
    const id = () => randomUUID();
    const events = [
      event('sales.order_status_changed', companyId, { orderId: id(), code: 'DH-000001', from: null, to: 'processing', flags: ['unmapped_sku'] }),
      event('fulfillment.package_status_changed', companyId, { packageId: id(), orderId: id(), from: 'reserved', to: 'packed' }),
      event('fulfillment.package_delivery_failed', companyId, { packageId: id(), orderId: id(), reason: 'Khách không nghe máy' }),
      event('fulfillment.package_lost', companyId, { packageId: id(), orderId: id(), claimCode: 'KN-1' }),
      event('sales.return_status_changed', companyId, { returnId: id(), orderId: id(), from: null, to: 'requested' }),
      event('channel.shop_status_changed', companyId, { shopId: id(), from: 'active', to: 'needs_reauth' }),
      event('channel.listing_sync_changed', companyId, { shopId: id(), listingId: id(), stockSync: 'pending', priceSync: 'synced', status: 'live' }),
    ];
    for (const e of events) hub.dispatch(e);
    const last = events.at(-1)!;
    await ceo.until((t) => t.includes(last.eventId));
    // Kho không nhận loại cuối (listing): chờ loại cuối Kho nhận.
    await warehouse.until((t) => t.includes(events[4]!.eventId));
    await Promise.all([admin.until((t) => t.includes(last.eventId)), sale.until((t) => t.includes(last.eventId))]);

    const got = (s: Stream) => events.filter((e) => s.text().includes(`id: ${e.eventId}`)).map((e) => e.type);
    const all = events.map((e) => e.type);
    expect(got(ceo)).toEqual(all);
    expect(got(admin)).toEqual(all);
    expect(got(sale)).toEqual(all);
    expect(got(warehouse)).toEqual([
      'fulfillment.package_status_changed',
      'fulfillment.package_delivery_failed',
      'fulfillment.package_lost',
      'sales.return_status_changed',
    ]);

    const messages = ceo
      .text()
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: EventType; payload: unknown });
    expect(messages.map((m) => m.type)).toEqual(all);
    for (const m of messages) expect(() => EVENT_SCHEMAS[m.type].strict().parse(m.payload), m.type).not.toThrow();
  });

  it('đổi trạng thái đơn bằng service thật thì stream của Sale nhận sales.order_status_changed (AC5)', async () => {
    const { companyId } = await createCompany();
    const sale = await addMember(companyId, 'sale').then((m) => connect(m.token));
    const { variantId } = await createVariant(companyId);
    const { orderId } = await seedPackage(companyId, { status: 'cancelled', orderStatus: 'processing', manual: true, lines: [{ variantId, quantity: 1 }] });
    // Việc nền khép đơn của file khác có thể chạy trước; dòng outbox giống nhau dù ai khép.
    await withCompany(companyId, () => settleCancelledOrder(orderId));

    const { rows } = await testPool().query<{
      id: string;
      event_id: string;
      company_id: string;
      type: string;
      topic: string;
      key: string;
      payload: Record<string, unknown>;
      created_at: Date;
      published_at: Date | null;
    }>(
      `select id, event_id, company_id, type, topic, key, payload, created_at, published_at from core.outbox_messages
       where type = 'sales.order_status_changed' and key = $1 order by id desc limit 1`,
      [orderId],
    );
    const r = rows[0]!;
    const row = {
      id: Number(r.id),
      eventId: r.event_id,
      companyId: r.company_id,
      type: r.type,
      topic: r.topic,
      key: r.key,
      payload: r.payload,
      createdAt: r.created_at,
      publishedAt: r.published_at,
    } as OutboxRow;
    hub.dispatch(JSON.parse(toKafkaMessage(row).value) as EventEnvelope<EventType>);

    await sale.until((t) => t.includes(`id: ${r.event_id}`));
    const line = sale
      .text()
      .split('\n')
      .find((l) => l.startsWith('data: ') && l.includes(r.event_id))!;
    const message = JSON.parse(line.slice('data: '.length)) as { type: string; payload: Record<string, unknown> };
    expect(message.type).toBe('sales.order_status_changed');
    expect(message.payload).toMatchObject({ orderId, from: 'processing', to: 'cancelled' });
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
