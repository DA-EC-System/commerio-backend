// Việc lỗi cho Admin (#102 A6): xem và chạy lại việc đã thử hết lượt của công ty mình.
// Đọc bằng pool của pg-boss (role chủ bảng), vì `commerio_app` chỉ được gửi việc; lọc công ty bằng `data.companyId`.
import { withCompany } from '../../../../../shared/db/client.ts';
import { AppError } from '../../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../../audit/index.ts';
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

/** Hàng việc lỗi giữ 30 ngày, mỗi công ty vài chục việc; đọc trọn rồi phân trang trong bộ nhớ. */
const READ_LIMIT = 10_000;

async function deadQueue() {
  const boss = await jobBoss();
  await boss.createQueue(DEAD_QUEUE, { retentionSeconds: 30 * 86_400 });
  return boss;
}

function errorOf(output: object | null): string {
  const message = (output as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : JSON.stringify(output);
}

/** Việc lỗi của công ty, mới nhất trước; `queue` lọc theo hàng gốc. */
export async function listDeadJobs(
  companyId: string,
  query: { queue?: string; page: number; pageSize: number },
): Promise<{ items: DeadJob[]; total: number; page: number; pageSize: number }> {
  const boss = await deadQueue();
  const jobs = (await boss.findJobs<JobData>(DEAD_QUEUE, { data: { companyId }, limit: READ_LIMIT }))
    .filter((j) => !query.queue || j.sourceName === query.queue)
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime());
  const items = jobs.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((j) => ({
    id: j.id,
    queue: j.sourceName ?? '',
    shopId: j.data.shopId ?? null,
    attempts: (j.sourceRetryCount ?? 0) + 1,
    lastError: errorOf(j.sourceOutput),
    failedAt: j.createdOn.toISOString(),
  }));
  return { items, total: jobs.length, page: query.page, pageSize: query.pageSize };
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
