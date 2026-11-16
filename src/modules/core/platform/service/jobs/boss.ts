// Hàng việc nền trên PostgreSQL (#102), dùng pg-boss. Schema `pgboss` tạo bằng migration 0011, không để thư viện tự tạo.
import { PgBoss } from 'pg-boss';
import { sharedPool } from '../../../../../shared/db/client.ts';
import { logger } from '../../../../../shared/logger.ts';

let worker = false;
let starting: Promise<PgBoss> | undefined;

/** Gọi trước `jobBoss()` đầu tiên trong tiến trình worker: bật bảo trì hàng và lịch cron. */
export function runJobsAsWorker(): void {
  if (starting) throw new Error('runJobsAsWorker phải gọi trước khi khởi động hàng việc');
  worker = true;
}

/**
 * pg-boss của tiến trình, khởi động một lần. Tiến trình api chỉ gửi việc (không bảo trì, không lịch);
 * worker bảo trì hàng, chạy lịch, nhận việc.
 */
export function jobBoss(): Promise<PgBoss> {
  starting ??= create().start();
  return starting;
}

function create(): PgBoss {
  const pool = sharedPool();
  const boss = new PgBoss({
    // Dùng chung pool của tiến trình, không mở pool riêng: Session pooler giới hạn tổng số kết nối, pool nằm ngoài
    // `DB_POOL_MAX` sẽ làm vượt trần (#335). Không có `beginTransaction` nên không dùng được worker `transactional`.
    db: {
      executeSql: (text, values) => pool.query(text, values),
      poolCounts: () => ({ max: pool.options.max ?? 10, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    },
    schema: 'pgboss',
    // Schema của migration; bản schema lệch bản thư viện thì start() ném, không chạy lặng lẽ.
    migrate: false,
    createSchema: false,
    // REINDEX cần quyền chủ bảng; chỉ số do migration quản lý.
    reindex: false,
    supervise: worker,
    schedule: worker,
    registerInstance: worker,
  });
  // Thiếu listener thì EventEmitter ném và tiến trình thoát.
  boss.on('error', (err) => logger.error({ reason: err.message }, 'hàng việc nền lỗi'));
  return boss;
}

/** Dừng êm: chờ việc đang chạy xong. Pool là của tiến trình, đóng bằng `closeDb()` sau hàm này. */
export async function stopJobs(): Promise<void> {
  if (!starting) return;
  const boss = await starting.catch(() => undefined);
  starting = undefined;
  await boss?.stop({ graceful: true, close: true });
}
