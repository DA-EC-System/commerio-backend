import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../../../shared/http/openapi.ts';

/** Đường dẫn Swagger của module `notification` (/api/v1/notification/stream do tiến trình realtime phục vụ). */
export function registerNotificationOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/stream',
    summary: 'Nhận thông báo thời gian thực qua SSE (UC-NO-01)',
    description: [
      'Do tiến trình **realtime** phục vụ, không phải api (Documents/21 §13). Mở bằng `fetch` kèm `Authorization: Bearer`',
      '(không dùng `EventSource`, D11). Không cần mã quyền riêng: mỗi sự kiện chỉ gửi cho người có quyền tương ứng.',
      'Stream bắt đầu bằng `retry: 3000`, heartbeat `: ping` mỗi 25 s; mỗi sự kiện là `event: <loại>`, `id: <eventId>`,',
      '`data: { eventId, type, occurredAt, payload }`. Server đóng stream đúng lúc access token hết hạn: refresh rồi mở lại.',
      'Không phát lại sự kiện lỡ. "Try it out" giữ kết nối tới khi token hết hạn.',
    ].join(' '),
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Stream sự kiện (text/event-stream), mở tới khi token hết hạn hoặc client đóng',
        content: { 'text/event-stream': { schema: z.string().meta({ example: 'event: sales.order_created\nid: …\ndata: {…}\n\n' }) } },
      },
      401: problemResponse('`unauthorized`'),
      403: problemResponse('`password_change_required`, `company_not_selected`, `company_locked`, `account_locked`'),
      404: problemResponse('`not_found`: không còn là thành viên công ty trong token'),
    },
  });
}
