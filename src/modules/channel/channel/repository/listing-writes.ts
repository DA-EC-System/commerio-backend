// Câu ghi listing có thể đổi bộ ba `status`, `stock_sync`, `price_sync` (#216, spec 5.5). Chỉ `service/listing-writes.ts`
// được import file này (dependency-cruiser `ghi-listing-qua-lop-phat`): lớp đó phát `channel.listing_sync_changed` khi bộ ba
// đổi. `updateListing`, `markStockPendingIds`, `markStockPendingRows` trả bộ ba trước và sau; bộ ba trước đọc bằng
// `SELECT … FOR UPDATE … ORDER BY id` cùng điều kiện, cùng giao dịch của bên gọi, rồi mới UPDATE theo id đã khoá: chạy được
// trên PG17 (staging), không dùng `RETURNING old.*` (PG18). Hai hàm của ngắt gian hàng (`delistForDisconnect`,
// `failPushingForDisconnect`) không trả bộ ba vì không phát (D12). Ba hàm trên khoá theo thứ tự id nên không khoá chéo nhau;
// đường khác khoá listing không theo id (`pushDue`, `reconcileStock`, `delistForDisconnect`) vẫn có thể gặp 40P01 với chúng,
// lỗi đó rollback giao dịch và lượt sau chạy lại.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { NO_OUTSIDE_CHANGE, NO_PENDING, NO_REVISION, type ListingStatus } from '../domain/listing.ts';
import type { ListingPatch, ListingRow } from './listings.ts';
import { listings } from './schema.ts';
import { ON_PLATFORM } from './shops.ts';

type SyncState = 'synced' | 'pending' | 'error';

export interface SyncTriple {
  status: ListingStatus;
  stockSync: SyncState;
  priceSync: SyncState;
}

export interface SyncChange {
  listingId: string;
  shopId: string;
  before: SyncTriple;
  after: SyncTriple;
}

const tripleColumns = { id: listings.id, shopId: listings.shopId, status: listings.status, stockSync: listings.stockSync, priceSync: listings.priceSync };
type TripleRow = { id: string; shopId: string } & SyncTriple;
const tripleOf = (r: TripleRow): SyncTriple => ({ status: r.status, stockSync: r.stockSync, priceSync: r.priceSync });

/** Khoá các dòng theo id tăng dần, trả bộ ba hiện tại (đã thấy mọi ghi đã commit trước khi lấy được khoá). */
async function lockTriples(where: ReturnType<typeof and>): Promise<TripleRow[]> {
  return getDb().select(tripleColumns).from(listings).where(where).orderBy(asc(listings.id)).for('update');
}

function changesOf(before: readonly TripleRow[], after: readonly TripleRow[]): SyncChange[] {
  const afterById = new Map(after.map((r) => [r.id, r]));
  return before.flatMap((b) => {
    const a = afterById.get(b.id);
    return a ? [{ listingId: b.id, shopId: b.shopId, before: tripleOf(b), after: tripleOf(a) }] : [];
  });
}

export async function insertListing(values: typeof listings.$inferInsert): Promise<ListingRow> {
  const [row] = await getDb().insert(listings).values(values).returning();
  return row!;
}

/**
 * Sửa listing khi còn đúng `version` (và đúng trạng thái `from` khi chuyển trạng thái), tăng `version`.
 * Không trúng dòng thì `undefined`, bên gọi đọc lại để báo 409. Trúng thì trả kèm bộ ba trước khi sửa.
 */
export async function updateListing(
  id: string,
  expected: { version: number; status?: ListingStatus },
  patch: ListingPatch,
): Promise<{ row: ListingRow; before: SyncTriple } | undefined> {
  const [locked] = await lockTriples(
    and(eq(listings.id, id), eq(listings.version, expected.version), expected.status ? eq(listings.status, expected.status) : undefined),
  );
  if (!locked) return undefined;
  const [row] = await getDb()
    .update(listings)
    .set({ ...patch, version: sql`${listings.version} + 1`, updatedAt: sql`now()` })
    .where(eq(listings.id, id))
    .returning();
  return { row: row!, before: tripleOf(locked) };
}

/**
 * `stock_sync = pending` (listing đang Lệch tồn giữ `error`, vẫn được đẩy; #223), tăng `version` để lượt đồng bộ đang chờ
 * sàn không ghi `synced` đè lên lần đánh dấu (#222).
 */
function stockPending() {
  return {
    stockSync: sql`case when ${listings.stockSync} = 'error' then 'error' else 'pending' end::channel.sync_state`,
    version: sql`${listings.version} + 1`,
    updatedAt: sql`now()`,
  };
}

async function markPending(where: ReturnType<typeof and>, extra: ListingPatch = {}): Promise<SyncChange[]> {
  const before = await lockTriples(where);
  if (!before.length) return [];
  const after = await getDb()
    .update(listings)
    .set({ ...stockPending(), ...extra })
    .where(inArray(listings.id, before.map((r) => r.id)))
    .returning(tripleColumns);
  return changesOf(before, after);
}

/**
 * Tồn trên sàn vừa bị đẩy về 0 mà ngắt bị chặn (#207): như `markStockPendingRows`, thêm `platform_stock = 0`.
 */
export async function markStockPendingIds(ids: readonly string[]): Promise<SyncChange[]> {
  if (!ids.length) return [];
  return markPending(inArray(listings.id, [...ids]), { platformStock: 0 });
}

/**
 * Listing của các biến thể ở các trạng thái cho trước chờ đẩy tồn (như `stockPending`). Trả mọi dòng đã ghi (kể cả bộ ba
 * không đổi), bên gọi lấy id gian hàng để xếp việc đẩy.
 */
export async function markStockPendingRows(variantIds: readonly string[], statuses: readonly ListingStatus[]): Promise<SyncChange[]> {
  if (!variantIds.length) return [];
  return markPending(and(inArray(listings.variantId, [...variantIds]), inArray(listings.status, [...statuses])));
}

/**
 * Ngắt gian hàng: listing còn trên sàn chuyển `delisted`, đánh dấu gỡ do ngắt để kết nối lại thì đưa lên (§18.1).
 * Trả trạng thái trước khi gỡ để bên gọi ghi lịch sử. Bên gọi đã khoá dòng gian hàng nên không đua với lần đẩy listing.
 */
export async function delistForDisconnect(
  shopId: string,
): Promise<{ id: string; from: string; pending: 'dropped' | 'deleted' | null }[]> {
  const before = await getDb()
    .select({ id: listings.id, from: listings.status, mode: listings.mode, approvedBy: listings.approvedBy, pendingBy: listings.pendingRequestedBy })
    .from(listings)
    .where(and(eq(listings.shopId, shopId), inArray(listings.status, [...ON_PLATFORM])))
    .for('update');
  if (before.length === 0) return [];
  // Gỡ là trạng thái cuối nên bỏ ghép chờ duyệt (CHECK `listings_delisted_no_pending`, #220 đợt 2); dòng chỉ để chờ
  // duyệt "không quản tồn" của SKU chưa ghép thì xoá, như khi CEO từ chối.
  const onlyPending = before.filter((r) => r.pendingBy && r.mode === 'unmanaged' && !r.approvedBy).map((r) => r.id);
  if (onlyPending.length) await getDb().delete(listings).where(inArray(listings.id, onlyPending));
  const rest = before.filter((r) => !onlyPending.includes(r.id));
  if (rest.length) {
    await getDb()
      .update(listings)
      .set({
        status: 'delisted',
        hiddenBy: null,
        delistedByDisconnect: true,
        ...NO_PENDING,
        ...NO_OUTSIDE_CHANGE,
        ...NO_REVISION,
        categoryChange: null,
        version: sql`${listings.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(inArray(listings.id, rest.map((r) => r.id)));
  }
  return before.map((r) => ({
    id: r.id,
    from: r.from,
    pending: onlyPending.includes(r.id) ? 'deleted' : r.pendingBy ? 'dropped' : null,
  }));
}

/**
 * Listing đang `pushing` của gian hàng vừa ngắt: việc đẩy đã bị bỏ (`dropHeld`) hoặc sẽ tự `fail` khi chạy, nên chuyển
 * `push_failed` ngay kèm `shop_not_connected` để bảng không hiện "Đang đẩy" mãi (#219). Gọi trong giao dịch ngắt.
 */
export async function failPushingForDisconnect(shopId: string): Promise<{ id: string }[]> {
  const error = { code: 'shop_not_connected', message: 'Gian hàng đã ngắt', at: new Date().toISOString() };
  return getDb()
    .update(listings)
    .set({ status: 'push_failed', pushError: error, version: sql`${listings.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(listings.shopId, shopId), eq(listings.status, 'pushing')))
    .returning({ id: listings.id });
}
