// Các kết nối SSE đang mở của một tiến trình realtime, và phân phối sự kiện tới đúng công ty, đúng quyền.
import { logger } from '../../../shared/logger.ts';
import type { EventEnvelope, EventType } from '../../platform/index.ts';
import { canReceive, toMessage } from '../domain/rules.ts';

const hubLogger = logger.child({ component: 'notification' });

/** Một kết nối SSE; lớp api cấp `send` (chỉ ghi khi stream còn mở) và `close`. */
export interface Connection {
  readonly companyId: string;
  /** Quyền có hiệu lực chụp lúc mở stream (plan A3). */
  readonly permissions: ReadonlySet<string>;
  send(chunk: string): void;
  close(): void;
}

/** Frame SSE của sự kiện, `null` nếu loại này không gửi. `id` = `eventId` để FE bỏ bản trùng. */
export function formatEvent(event: EventEnvelope<EventType>): string | null {
  const message = toMessage(event);
  return message && `event: ${message.type}\nid: ${message.eventId}\ndata: ${JSON.stringify(message)}\n\n`;
}

export interface Hub {
  /** Thêm kết nối, trả hàm gỡ. */
  add(connection: Connection): () => void;
  dispatch(event: EventEnvelope<EventType>): void;
  /** Tắt tiến trình: gỡ hết rồi mới đóng, để không ghi vào stream đã đóng; kết nối thêm sau đó bị đóng ngay. */
  closeAll(): void;
  size(): number;
}

export function createHub(): Hub {
  const byCompany = new Map<string, Set<Connection>>();
  let closed = false;

  return {
    add(connection) {
      // Tiến trình đang tắt (stream mở dở lúc closeAll): đóng ngay để server.close() không phải chờ.
      if (closed) {
        connection.close();
        return () => undefined;
      }
      let set = byCompany.get(connection.companyId);
      if (!set) byCompany.set(connection.companyId, (set = new Set()));
      set.add(connection);
      return () => {
        // Sau closeAll, set cũ không còn trong map: không xoá nhầm set mới của cùng công ty.
        if (set.delete(connection) && set.size === 0 && byCompany.get(connection.companyId) === set) {
          byCompany.delete(connection.companyId);
        }
      };
    },
    dispatch(event) {
      let frame: string | null | undefined;
      for (const connection of (event.companyId && byCompany.get(event.companyId)) || []) {
        if (!canReceive(connection.permissions, event.type)) continue;
        // Dựng frame một lần, chỉ khi có người nhận.
        frame ??= formatEvent(event);
        if (!frame) return;
        try {
          connection.send(frame);
        } catch (err) {
          hubLogger.warn({ err, eventId: event.eventId }, 'ghi sự kiện vào stream lỗi');
        }
      }
    },
    closeAll() {
      closed = true;
      const all = [...byCompany.values()].flatMap((set) => [...set]);
      byCompany.clear();
      for (const connection of all) connection.close();
    },
    // Chỉ /metrics và test gọi.
    size: () => [...byCompany.values()].reduce((n, set) => n + set.size, 0),
  };
}
