// Việc lỗi cho Admin (#102 A6): xem và chạy lại việc đã thử hết lượt của công ty mình.
// Đọc và chuyển việc ngoài `withCompany` (role chủ bảng), vì `commerio_app` chỉ được gửi việc; lọc công ty bằng `data.companyId`.
import { withCompany } from '../../../../../shared/db/client.ts';
import { AppError } from '../../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../../audit/index.ts';
import { findDeadJobs } from '../../repository/dead-jobs.ts';
import { jobBoss } from './boss.ts';
import { DEAD_QUEUE, type JobData } from './queues.ts';

export interface DeadJob {
  id: string;
  queue: string;
  shopId: string | null;
  attempts: number;
  lastError: string;
  failedAt: string;
}

function errorOf(output: unknown): string {
  const message = (output as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : JSON.stringify(output);
}

/** Việc lỗi của công ty, mới nhất trước; `queue` lọc theo hàng gốc. */
export async function listDeadJobs(
  companyId: string,
  query: { queue?: string; page: number; pageSize: number },
): Promise<{ items: DeadJob[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await findDeadJobs(DEAD_QUEUE, companyId, {
    queue: query.queue,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  const items = rows.map((r) => ({
    id: r.id,
    queue: r.queue ?? '',
    shopId: r.shopId,
    attempts: (r.retryCount ?? 0) + 1,
    lastError: errorOf(r.output),
    failedAt: r.failedAt.toISOString(),
  }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/** Hàng việc lỗi chưa có (chưa việc nào lỗi) thì tạo, để `findJobs` không báo hàng không tồn tại. */
async function deadQueue() {
  const boss = await jobBoss();
  await boss.createQueue(DEAD_QUEUE, { retentionSeconds: 30 * 86_400 });
  return boss;
}

/**
 * Lúc lỗi gần nhất của việc đã thử hết lượt, theo gian hàng và hàng gốc (`Shop.setup`, #198): khoá `"<shopId> <hàng>"`.
 * Chỉ các hàng trong `queues`. Đọc bằng kết nối của pg-boss, gọi được trong `withCompany`.
 */
export async function lastDeadJobs(shopIds: readonly string[], queues: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!shopIds.length) return out;
  const boss = await deadQueue();
  for (const shopId of shopIds) {
    for (const job of await boss.findJobs(DEAD_QUEUE, { data: { shopId } })) {
      if (!job.sourceName || !queues.includes(job.sourceName)) continue;
      const key = `${shopId} ${job.sourceName}`;
      const at = new Date(job.createdOn);
      const seen = out.get(key);
      if (!seen || at > seen) out.set(key, at);
    }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Đưa việc lỗi về hàng gốc với lượt thử mới (`redrive` của pg-boss lọc theo id và công ty trong một câu).
 * Nhật ký ghi trong giao dịch của công ty, trước khi chuyển: không chuyển được thì rollback cả nhật ký.
 */
export async function retryDeadJob(companyId: string, actorId: string, id: string): Promise<void> {
  const notFound = new AppError(404, 'not_found', 'Không có việc lỗi này');
  if (!UUID.test(id)) throw notFound;
  const boss = await deadQueue();
  const [job] = await boss.findJobs<JobData>(DEAD_QUEUE, { id, data: { companyId } });
  if (!job) throw notFound;
  await withCompany(companyId, async () => {
    await recordAudit({
      companyId,
      actorId,
      action: 'update',
      entityType: 'pgboss.job',
      entityId: id,
      before: { queue: job.sourceName, state: 'dead' },
    });
    if ((await boss.redrive(DEAD_QUEUE, { ids: [id], data: { companyId } })) === 0) throw notFound;
  });
}
