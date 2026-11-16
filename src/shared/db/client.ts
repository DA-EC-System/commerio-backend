import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.ts';
import { logger } from '../logger.ts';

export type Database = NodePgDatabase;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

let pool: pg.Pool | undefined;
let database: Database | undefined;

function rootDb(): Database {
  if (!database) {
    if (!env.DATABASE_URL) throw new Error('Chưa đặt DATABASE_URL');
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    });
    // Kết nối bị server cắt (restart, failover), lúc rảnh hay lúc đang giữ giao dịch mà chưa chạy truy vấn:
    // client phát `error`, thiếu listener thì EventEmitter ném và tiến trình thoát. Nghe và ghi log trên từng client;
    // pool phát lại lỗi của client rảnh nên cũng cần listener (rỗng). Pool bỏ kết nối hỏng, truy vấn đang chờ thì lỗi.
    // Không log cả `err`: `err.client` mang mật khẩu DB.
    pool.on('connect', (client) => {
      client.on('error', (err: Error & { code?: string }) => {
        logger.error({ code: err.code, reason: err.message }, 'kết nối PostgreSQL bị đứt');
      });
    });
    pool.on('error', () => undefined);
    database = drizzle({ client: pool });
  }
  return database;
}

/**
 * Pool của tiến trình cho thư viện cần chạy SQL thẳng (pg-boss), để cả tiến trình chỉ có **một** pool và
 * `DB_POOL_MAX` là trần thật (#335). Mỗi câu mượn một kết nối rồi trả ngay, không đi chung giao dịch đang mở.
 */
export function sharedPool(): pg.Pool {
  rootDb();
  return pool!;
}

// Transaction đang mở của yêu cầu hiện tại (docs/17 mục 2, luật 3), kèm công ty nếu mở bằng withCompany.
interface OpenTransaction {
  readonly tx: Transaction;
  readonly companyId: string | null;
}
const current = new AsyncLocalStorage<OpenTransaction>();

/** Repository luôn lấy kết nối qua đây để tự đi chung transaction của bên gọi nếu có. */
export function getDb(): Database | Transaction {
  return current.getStore()?.tx ?? rootDb();
}

/** Chạy `fn` ngoài transaction đang mở (nếu có): `getDb()` trong đó là kết nối gốc, mỗi câu tự commit ngay. */
export function outsideTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return current.exit(fn);
}

/**
 * Chạy `fn` trong một transaction. Nếu đã có transaction mở thì dùng lại,
 * nên service của module A gọi sang module B vẫn nằm trong cùng một giao dịch.
 */
export async function inTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const existing = current.getStore();
  if (existing) return fn(existing.tx);
  return rootDb().transaction((tx) => current.run({ tx, companyId: null }, () => fn(tx)));
}

/**
 * Chạy `fn` trong transaction của một công ty: `SET LOCAL ROLE commerio_app` và `app.company_id`,
 * nên Row-Level Security chỉ cho thấy dữ liệu của công ty đó (db/CLAUDE.md). Đang ở trong withCompany
 * cùng công ty thì dùng lại. Lồng vào giao dịch khác (công ty khác, hoặc giao dịch của role chủ bảng như
 * luồng đăng ký) là lỗi lập trình: SET LOCAL sẽ đổi role cho cả phần còn lại của giao dịch đó.
 */
export async function withCompany<T>(companyId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const existing = current.getStore();
  if (existing) {
    if (existing.companyId === companyId) return fn(existing.tx);
    const where = existing.companyId ? 'của công ty khác' : 'không thuộc công ty';
    throw new Error(`withCompany(${companyId}) không lồng được trong giao dịch ${where}`);
  }
  return rootDb().transaction(async (tx) => {
    // set_config(..., true) = SET LOCAL: hết hiệu lực khi giao dịch kết thúc. Gộp một câu cho đỡ một lượt đi về.
    await tx.execute(sql`select set_config('role', 'commerio_app', true), set_config('app.company_id', ${companyId}, true)`);
    return current.run({ tx, companyId }, () => fn(tx));
  });
}

/** Nghỉ giữa hai lần thử khoá phiên khi có `waitMs`: bắt đầu ngắn, gấp đôi tới trần. */
const LOCK_RETRY_MIN_MS = 25;
const LOCK_RETRY_MAX_MS = 500;

/*
 * Khoá phiên và trần kết nối (#335). Người giữ khoá giữ một kết nối suốt `fn`, mà `fn` lại mượn thêm kết nối của pool
 * (`withCompany`). Nếu mọi kết nối của pool đều do người giữ khoá cầm thì không ai lấy được kết nối thứ hai: cả tiến
 * trình chờ nhau tới hết `DB_CONNECT_TIMEOUT_MS`. Hai luật giữ cho luôn còn kết nối rảnh:
 * 1. Mỗi chuỗi khoá chỉ cầm **một** kết nối: `withSessionLock` lồng trong `fn` của khoá khác (vd đối soát → làm mới
 *    token) lấy thêm khoá trên chính kết nối của khoá ngoài, không mượn kết nối mới.
 * 2. Số chuỗi khoá cùng lúc trong tiến trình không quá nửa `DB_POOL_MAX` (ít nhất 1); chuỗi dư chờ chỗ, không cầm kết
 *    nối khi chờ. Chờ quá `DB_CONNECT_TIMEOUT_MS` thì ném lỗi như pool hết hạn chờ (api trả 503, việc nền thử lại).
 */

/** Chuỗi khoá đang mở trong ngữ cảnh hiện tại: kết nối giữ khoá và các khoá đang giữ (kể cả khoá lồng). */
interface LockChain {
  readonly client: pg.PoolClient;
  readonly keys: Set<string>;
  open: boolean;
  /** Câu lệnh trước trên `client`: nhánh song song trong `fn` xếp hàng, không gửi chồng lên một kết nối (pg@9 cấm). */
  queue: Promise<unknown>;
  /** Khoá lồng đang chờ hoặc đang giữ trên chuỗi: chuỗi ngoài chờ hết rồi mới nhả khoá và trả kết nối. */
  readonly nested: Set<Promise<void>>;
}
const lockChain = new AsyncLocalStorage<LockChain>();

/** Chạy một câu trên kết nối của chuỗi, sau câu trước đó. */
function chainQuery<R extends pg.QueryResultRow>(chain: LockChain, text: string, values: unknown[]): Promise<pg.QueryResult<R>> {
  const run = chain.queue.then(() => chain.client.query<R>(text, values));
  chain.queue = run.catch(() => undefined);
  return run;
}

let lockSlotsInUse = 0;
const lockSlotWaiters: (() => void)[] = [];
const lockSlotCap = () => Math.max(1, Math.floor(env.DB_POOL_MAX / 2));

/** Lấy một chỗ cho chuỗi khoá mới; hết chỗ thì chờ theo thứ tự tới `DB_CONNECT_TIMEOUT_MS` (0 là chờ mãi). */
async function takeLockSlot(): Promise<void> {
  if (lockSlotsInUse < lockSlotCap()) {
    lockSlotsInUse++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeoutMs = env.DB_CONNECT_TIMEOUT_MS;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          lockSlotWaiters.splice(lockSlotWaiters.indexOf(waiter), 1);
          // Cùng câu với lỗi hết hạn chờ của pg-pool để `isConnectionUnavailable` nhận ra.
          reject(new Error('timeout exceeded when trying to connect: đã đủ số khoá phiên giữ cùng lúc'));
        }, timeoutMs)
      : undefined;
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    lockSlotWaiters.push(waiter);
  });
}

/** Trả chỗ: có người chờ thì trao thẳng chỗ cho người đó (số chỗ đang dùng giữ nguyên). */
function giveLockSlot(): void {
  const next = lockSlotWaiters.shift();
  if (next) next();
  else lockSlotsInUse--;
}

const TRY_LOCK = 'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked';

/** Thử lấy khoá một lần trên một kết nối của pool; có thì trả kết nối (đang giữ khoá), không thì trả kết nối và chỗ. */
async function tryLockOnce(keys: readonly string[]): Promise<pg.PoolClient | null> {
  await takeLockSlot();
  let client: pg.PoolClient;
  try {
    client = await pool!.connect();
  } catch (err) {
    giveLockSlot();
    throw err;
  }
  try {
    for (const [index, key] of keys.entries()) {
      const { rows } = await client.query<{ locked: boolean }>(TRY_LOCK, [key]);
      if (rows[0]!.locked) continue;
      if (index > 0) await client.query('select pg_advisory_unlock_all()');
      client.release();
      giveLockSlot();
      return null;
    }
    return client;
  } catch (err) {
    client.release(true);
    giveLockSlot();
    throw err;
  }
}

/**
 * Thử lấy thêm khoá trên kết nối của chuỗi đang mở. Khoá phiên của PostgreSQL lấy lại được trên cùng phiên, nên khoá
 * chuỗi đang giữ (hai nhánh song song trong cùng `fn` cùng xin một khoá) coi như bận; đánh dấu khoá trước khi gọi DB
 * để hai nhánh không cùng lọt.
 */
async function tryNestedLockOnce(chain: LockChain, keys: readonly string[]): Promise<boolean> {
  if (keys.some((key) => chain.keys.has(key))) return false;
  for (const key of keys) chain.keys.add(key);
  const taken: string[] = [];
  try {
    for (const key of keys) {
      const { rows } = await chainQuery<{ locked: boolean }>(chain, TRY_LOCK, [key]);
      if (!rows[0]!.locked) break;
      taken.push(key);
    }
  } finally {
    if (taken.length < keys.length) await unlockNested(chain, taken, keys);
  }
  return taken.length === keys.length;
}

/** Nhả các khoá lồng `taken` trên kết nối của chuỗi rồi bỏ đánh dấu `marked`. Lỗi nhả (kết nối đứt) thì thôi. */
async function unlockNested(chain: LockChain, taken: readonly string[], marked: readonly string[]): Promise<void> {
  for (const key of taken) {
    await chainQuery(chain, 'select pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => undefined);
  }
  for (const key of marked) chain.keys.delete(key);
}

/**
 * Chạy `fn` khi giữ được khoá advisory **phiên** `hashtextextended(key, 0)` trên một kết nối riêng; phiên khác đang giữ
 * thì trả `'busy'` ngay, hoặc thử lại tới `waitMs` rồi mới trả `'busy'`. Cho việc nền kéo dài qua nhiều giao dịch và lời
 * gọi mạng, nơi khoá giao dịch không giữ được. `fn` chạy ngoài giao dịch (tự mở `withCompany`). Xong thì nhả khoá rồi huỷ
 * kết nối, không trả về pool.
 *
 * Chờ bằng `pg_try_advisory_lock` lặp có nghỉ (25 ms gấp đôi tới 500 ms), không bằng `pg_advisory_lock` chặn: lần thử
 * hụt trả kết nối về pool ngay, nên nhiều bên cùng chờ một khoá không giữ kết nối của pool suốt `waitMs`. Khoá phiên chỉ
 * nhả được trên phiên đã lấy nó, nên kết nối lấy được khoá giữ tới khi `fn` xong rồi mới nhả. Không công bằng (không xếp
 * hàng): bên chờ lâu chưa chắc được trước, đủ cho khoá làm mới token.
 * Cần kết nối giữ phiên (PostgreSQL thẳng, Supabase Session pooler); PgBouncer chế độ transaction không giữ được khoá.
 *
 * Gọi lồng trong `fn` của khoá khác thì lấy khoá trên kết nối của khoá ngoài, không mượn kết nối mới; số chuỗi khoá
 * cùng lúc có trần (luật ở đầu phần này, #335).
 */
export async function withSessionLock<T>(
  key: string, fn: () => Promise<T>, opts: { waitMs?: number; additionalKeys?: readonly string[] } = {},
): Promise<T | 'busy'> {
  rootDb();
  // Khi cần nhiều khoá, dùng cùng một kết nối và nhả tất cả nếu lần thử hụt.
  const keys = opts.additionalKeys?.length ? [...new Set([key, ...opts.additionalKeys])].sort() : [key];
  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
  /** Thử lặp có nghỉ tới `deadline`; `false` khi hết hạn mà chưa lấy được. */
  const retry = async (attempt: () => Promise<boolean>): Promise<boolean> => {
    let pause = LOCK_RETRY_MIN_MS;
    while (!(await attempt())) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pause, left)));
      pause = Math.min(pause * 2, LOCK_RETRY_MAX_MS);
    }
    return true;
  };

  const outer = lockChain.getStore();
  // Việc chạy tiếp sau khi chuỗi ngoài đã đóng (promise bỏ lửng trong `fn`) thì mở chuỗi mới. Kiểm `open` và đăng ký vào
  // `nested` cùng một bước đồng bộ: chuỗi ngoài đóng sau đó sẽ chờ khoá lồng này xong (kể cả `fn` bỏ lửng chạy lâu hơn
  // `fn` ngoài) rồi mới nhả khoá, nên không có lúc khoá lồng chạy mà khoá đã bị nhả.
  if (outer?.open) {
    let done!: () => void;
    const settled = new Promise<void>((resolve) => (done = resolve));
    outer.nested.add(settled);
    try {
      if (!(await retry(() => tryNestedLockOnce(outer, keys)))) return 'busy';
      try {
        return await fn();
      } finally {
        await unlockNested(outer, keys, keys);
      }
    } finally {
      outer.nested.delete(settled);
      done();
    }
  }

  let client: pg.PoolClient | null = null;
  if (!(await retry(async () => (client = await tryLockOnce(keys)) !== null))) return 'busy';
  const chain: LockChain = { client: client!, keys: new Set(keys), open: true, queue: Promise.resolve(), nested: new Set() };
  try {
    return await lockChain.run(chain, fn);
  } finally {
    chain.open = false;
    // Khoá lồng còn chạy (`fn` bỏ lửng): chờ xong mới nhả, không thì chúng chạy tiếp mà khoá đã bị nhả.
    while (chain.nested.size) await Promise.all(chain.nested);
    // Nhả ngay phía server: huỷ kết nối không chờ phiên đóng, lượt liền sau có thể còn thấy khoá. Lỗi nhả (kết nối
    // đứt) thì thôi, phiên chết cũng nhả khoá; không che lỗi của `fn`.
    await chainQuery(chain, 'select pg_advisory_unlock_all()', []).catch(() => undefined);
    chain.client.release(true);
    giveLockSlot();
  }
}

/** Công ty của giao dịch đang mở bằng withCompany; `null` khi ở ngoài. */
export function currentCompanyId(): string | null {
  return current.getStore()?.companyId ?? null;
}

/**
 * Mã công ty của `withCompany` đang mở; ngoài đó thì ném lỗi lập trình. Hàm ranh giới cho module khác gọi dùng ở đầu:
 * ngoài `withCompany` là role chủ bảng, RLS không có hiệu lực, đọc ghi được dữ liệu mọi công ty.
 */
export function requireCompanyId(fn: string): string {
  const companyId = currentCompanyId();
  if (!companyId) throw new Error(`${fn} phải gọi trong withCompany của bên gọi`);
  return companyId;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}
