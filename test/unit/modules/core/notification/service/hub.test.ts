import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Connection, createHub, formatEvent } from '#src/modules/core/notification/service/hub.ts';
import type { EventEnvelope, EventType } from '#src/modules/core/platform/index.ts';

const id = () => randomUUID();
const companyA = id();
const companyB = id();

function connection(companyId: string, ...permissions: string[]) {
  const sent: string[] = [];
  const conn: Connection & { sent: string[]; closed: boolean } = {
    companyId,
    permissions: new Set(permissions),
    sent,
    closed: false,
    send: (chunk) => void sent.push(chunk),
    close: () => {
      conn.closed = true;
    },
  };
  return conn;
}

const orderCreated = (companyId: string, code = 'DH-0001') =>
  ({
    eventId: id(),
    type: 'sales.order_created',
    companyId,
    aggregateId: id(),
    occurredAt: '2026-10-18T09:00:00.000+07:00',
    payload: { orderId: id(), code, source: 'manual', total: '150000.00' },
  }) as EventEnvelope<EventType>;

describe('hub phân phối sự kiện (AC-2, AC-3, AC-4)', () => {
  it('gửi tới kết nối cùng công ty có quyền, không tới công ty khác hay người thiếu quyền', () => {
    const hub = createHub();
    const sale = connection(companyA, 'sales.order.view');
    const warehouse = connection(companyA, 'inventory.stock.view');
    const otherCompany = connection(companyB, 'sales.order.view');
    for (const c of [sale, warehouse, otherCompany]) hub.add(c);

    hub.dispatch(orderCreated(companyA));

    expect(sale.sent).toHaveLength(1);
    expect(warehouse.sent).toHaveLength(0);
    expect(otherCompany.sent).toHaveLength(0);
  });

  it('frame SSE: event, id = eventId, data là JSON không có companyId', () => {
    const event = orderCreated(companyA);
    const frame = formatEvent(event)!;
    const lines = frame.split('\n');
    expect(lines[0]).toBe('event: sales.order_created');
    expect(lines[1]).toBe(`id: ${event.eventId}`);
    expect(JSON.parse(lines[2]!.slice('data: '.length))).toMatchObject({ eventId: event.eventId, payload: { total: 150000 } });
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame).not.toContain(companyA);
  });

  it('hai sự kiện liên tiếp tới cùng kết nối, đúng thứ tự', () => {
    const hub = createHub();
    const sale = connection(companyA, 'sales.order.view');
    hub.add(sale);
    hub.dispatch(orderCreated(companyA, 'DH-1'));
    hub.dispatch(orderCreated(companyA, 'DH-2'));
    expect(sale.sent.map((f) => JSON.parse(f.split('\n')[2]!.slice(6)).payload.code)).toEqual(['DH-1', 'DH-2']);
  });

  it('sự kiện không thuộc công ty nào hoặc loại ngoài bảng thì không gửi', () => {
    const hub = createHub();
    const ceo = connection(companyA, 'sales.order.view', 'inventory.stock.view');
    hub.add(ceo);
    hub.dispatch({ ...orderCreated(companyA), companyId: null });
    hub.dispatch({ ...orderCreated(companyA), type: 'inventory.stock_changed', payload: {} } as EventEnvelope<EventType>);
    expect(ceo.sent).toHaveLength(0);
  });

  it('gỡ kết nối thì không ghi nữa, size về 0', () => {
    const hub = createHub();
    const sale = connection(companyA, 'sales.order.view');
    const remove = hub.add(sale);
    expect(hub.size()).toBe(1);
    remove();
    hub.dispatch(orderCreated(companyA));
    expect(sale.sent).toHaveLength(0);
    expect(hub.size()).toBe(0);
  });

  it('closeAll gỡ mọi kết nối trước khi đóng, dispatch sau đó không ghi vào kết nối đã đóng', () => {
    const hub = createHub();
    const conns = [connection(companyA, 'sales.order.view'), connection(companyB, 'sales.order.view')];
    const sizeWhenClosing: number[] = [];
    for (const c of conns) {
      c.close = () => {
        sizeWhenClosing.push(hub.size());
        c.closed = true;
      };
      hub.add(c);
    }
    hub.closeAll();
    hub.dispatch(orderCreated(companyA));
    expect(conns.every((c) => c.closed)).toBe(true);
    expect(sizeWhenClosing.every((n) => n === 0)).toBe(true);
    expect(conns[0]!.sent).toHaveLength(0);
  });

  it('thêm kết nối sau closeAll (tắt tiến trình) thì đóng ngay, không vào hub', () => {
    const hub = createHub();
    hub.closeAll();
    const late = connection(companyA, 'sales.order.view');
    hub.add(late);
    expect(late.closed).toBe(true);
    expect(hub.size()).toBe(0);
  });

  it('một kết nối ghi lỗi không chặn kết nối khác', () => {
    const hub = createHub();
    const broken = connection(companyA, 'sales.order.view');
    broken.send = () => {
      throw new Error('socket hỏng');
    };
    const sale = connection(companyA, 'sales.order.view');
    hub.add(broken);
    hub.add(sale);
    expect(() => hub.dispatch(orderCreated(companyA))).not.toThrow();
    expect(sale.sent).toHaveLength(1);
  });
});
