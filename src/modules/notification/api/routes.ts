import { Router } from 'express';
import { readAccessClaims } from '../../../shared/auth/authenticate.ts';
import { type AccessLoader, assertCompanyAccess } from '../../../shared/auth/authorize.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { loadCompanyAccess } from '../../identity/index.ts';
import { effectivePermissions } from '../domain/rules.ts';
import type { Hub } from '../service/hub.ts';

export interface StreamOptions {
  readonly hub: Hub;
  /** Mặc định đọc DB qua identity (D1); test truyền bản khác được. */
  readonly loadAccess?: AccessLoader;
  /** 25 s, dưới ngưỡng nhàn rỗi của proxy (plan A6); test rút ngắn. */
  readonly heartbeatMs?: number;
}

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform: proxy không nén, không đệm; X-Accel-Buffering cho ingress-nginx.
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
  // Stream kết thúc thì đóng luôn socket: không giữ kết nối nhàn rỗi làm server.close() chờ lúc tắt.
  Connection: 'close',
};

/**
 * `GET /stream` (Documents/21 §13, D11). Không dùng `ctx.authorize` vì stream không gắn một mã quyền (plan A8):
 * kiểm token và truy cập công ty bằng đúng các hàm của `authorize`, rồi lọc từng sự kiện theo quyền chụp lúc mở.
 */
export function notificationRouter({ hub, loadAccess = loadCompanyAccess, heartbeatMs = 25_000 }: StreamOptions): Router {
  const router = Router();

  router.get('/stream', async (req, res) => {
    const claims = await readAccessClaims(req);
    if (!claims.companyId) throw new AppError(403, 'company_not_selected', 'Chưa chọn công ty làm việc');
    const access = await loadAccess(claims.accountId, claims.companyId);
    assertCompanyAccess(access);
    // Client đã đóng trong lúc đọc DB: sự kiện `close` đã qua, gắn listener lúc này sẽ không bao giờ chạy.
    if (res.destroyed) return;

    res.writeHead(200, HEADERS);
    res.flushHeaders();
    // Ghi sau res.end() ném bất đồng bộ (không bắt được), nên luôn kiểm stream còn mở.
    const send = (chunk: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    send('retry: 3000\n\n');

    let remove = () => {};
    const heartbeat = setInterval(() => send(': ping\n\n'), heartbeatMs);
    // D11: đóng đúng lúc token hết hạn, FE refresh rồi nối lại (lúc đó kiểm quyền lại từ DB).
    const expiry = setTimeout(() => close(), Math.max(0, claims.expiresAt * 1000 - Date.now()));
    const stop = () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      remove();
    };
    // Gỡ khỏi hub trước khi end, để không sự kiện nào ghi vào stream đã đóng.
    const close = () => {
      stop();
      if (!res.writableEnded) res.end();
    };
    res.on('close', stop);
    // hub đang tắt thì gọi close() ngay trong add (remove lúc đó còn là hàm rỗng).
    remove = hub.add({ companyId: claims.companyId, permissions: effectivePermissions(access), send, close });
  });

  return router;
}
