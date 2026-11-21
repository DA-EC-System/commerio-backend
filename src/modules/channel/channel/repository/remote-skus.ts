// Bản sao danh sách SKU của gian hàng trên sàn (#220 đợt 2, bảng `remote_skus`). Chạy trong `withCompany` của bên gọi.
import { and, asc, count, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import type { RemoteSkusFullError } from '../domain/remote-skus-refresh.ts';
import { listings, remoteSkus, shops } from './schema.ts';

export type RemoteSkuRow = typeof remoteSkus.$inferSelect;
/** SKU sàn adapter trả (cùng trường với `RemoteSku` của `marketplaces/common.ts`; repository không import lớp service). */
export interface RemoteSkuInput {
  externalProductId: string;
  externalSkuId: string;
  sellerSku: string;
  title: string;
  titleEn?: string | null;
  state: string;
  quantity: number;
  /** Giá gốc trên sàn, chuỗi số (#460). */
  price?: string | null;
  /** Tiêu đề thiếu nhãn biến thể: dòng đã có thì giữ tiêu đề cũ (review #309 vòng 2 N3). */
  labelMissing?: boolean;
}

/**
 * Ghi các SKU vừa đọc từ sàn: SKU `deleted` thì xoá dòng, còn lại thêm hoặc sửa, `seen_at` = `seenAt`. Không đụng SKU
 * không có trong danh sách (đọc theo giờ sửa chỉ trả phần đã sửa). SKU `labelMissing` sửa mọi cột trừ `title` (dòng mới
 * thì lấy tiêu đề dự phòng): sàn không đọc được nhãn lần này không làm mất nhãn đã lưu.
 */
export async function upsertRemoteSkus(shopId: string, skus: readonly RemoteSkuInput[], seenAt: Date): Promise<void> {
  const companyId = requireCompanyId('upsertRemoteSkus');
  const gone = skus.filter((s) => s.state === 'deleted').map((s) => s.externalSkuId);
  // Một mã SKU sàn có thể về hai lần (đọc `all` rồi `deleted`): giữ lần cuối.
  const live = [...new Map(skus.filter((s) => s.state !== 'deleted').map((s) => [s.externalSkuId, s])).values()].filter(
    (s) => !gone.includes(s.externalSkuId),
  );
  if (gone.length) await getDb().delete(remoteSkus).where(and(eq(remoteSkus.shopId, shopId), inArray(remoteSkus.externalSkuId, gone)));
  for (let i = 0; i < live.length; i += 500) {
    const values = live.slice(i, i + 500).map((s) => ({
      companyId,
      shopId,
      externalProductId: s.externalProductId,
      externalSkuId: s.externalSkuId,
      sellerSku: s.sellerSku,
      title: s.title,
      titleEn: s.titleEn ?? null,
      state: s.state as RemoteSkuRow['state'],
      // Sàn không có tồn âm; số lạ không làm hỏng cả bản sao.
      quantity: Math.max(0, Math.trunc(s.quantity)),
      // Giá lạ (không phải số không âm) thì bỏ, không làm hỏng cả bản sao.
      price: s.price != null && /^\d+(\.\d+)?$/.test(s.price.trim()) ? s.price.trim() : null,
      seenAt,
      labelMissing: s.labelMissing === true,
    }));
    for (const keepTitle of [false, true]) {
      const part = values.filter((v) => v.labelMissing === keepTitle).map(({ labelMissing: _, ...v }) => v);
      if (!part.length) continue;
      await getDb()
        .insert(remoteSkus)
        .values(part)
        .onConflictDoUpdate({
          target: [remoteSkus.shopId, remoteSkus.externalSkuId],
          set: {
            externalProductId: sql`excluded.external_product_id`,
            sellerSku: sql`excluded.seller_sku`,
            ...(!keepTitle && { title: sql`excluded.title` }),
            titleEn: sql`excluded.title_en`,
            state: sql`excluded.state`,
            quantity: sql`excluded.quantity`,
            price: sql`excluded.price`,
            seenAt: sql`excluded.seen_at`,
          },
        });
    }
  }
  await refreshRemoteTitleFlags(shopId, seenAt);
}

/**
 * Cờ "Tên trên sàn đã đổi" (#396) sau một lần ghi bản sao. Chỉ xét SKU vừa ghi ở lượt này (`seen_at = seenAt`: dòng không
 * có trong lượt đọc theo giờ sửa còn tên cũ) của listing chưa gỡ, không đang đẩy (tăng `version` làm việc đẩy bỏ kết quả),
 * có mốc tên. Hai bước:
 * 1. Mốc chưa có giờ (`matched_at` null: mốc lấy từ bản sao, dòng bản sao có thể chưa có `title_en`): lấy tên tiếng Anh vừa
 *    đọc làm mốc, giờ mốc = lúc lượt đọc bắt đầu. Không đổi thứ người dùng thấy nên không tăng `version`.
 * 2. Bản đọc từ giờ mốc trở đi (lượt đọc bắt đầu trước khi app đẩy xong còn tên cũ): (tên, tên tiếng Anh) khác mốc mà chưa
 *    có cờ thì bật (`changed_at` = bây giờ), giống mốc mà đang có cờ thì tắt; chỉ dòng đổi trạng thái cờ, tăng `version` như
 *    `outside_change`. Đổi tiếp khi cờ đang bật thì giữ lúc phát hiện đầu.
 */
async function refreshRemoteTitleFlags(shopId: string, seenAt: Date): Promise<void> {
  const fresh = sql`r.shop_id = l.shop_id and r.external_sku_id = l.external_sku_id and r.seen_at = ${seenAt}
    and l.shop_id = ${shopId} and l.status not in ('delisted', 'pushing') and l.remote_title_at_match is not null`;
  await getDb().execute(sql`
    update ${listings} l set remote_title_en_at_match = r.title_en, remote_title_matched_at = r.seen_at
      from ${remoteSkus} r where ${fresh} and l.remote_title_matched_at is null`);
  const differs = sql`((r.title, r.title_en) is distinct from (l.remote_title_at_match, l.remote_title_en_at_match))`;
  await getDb().execute(sql`
    update ${listings} l set remote_title_changed_at = case when ${differs} then now() end, version = l.version + 1, updated_at = now()
      from ${remoteSkus} r where ${fresh} and r.seen_at >= l.remote_title_matched_at
        and ${differs} <> (l.remote_title_changed_at is not null)`);
}

/** Dòng bản sao của các SKU sàn (cờ tên trên `GET /listings`, xác nhận tên). */
export async function remoteSkuRowsOf(shopId: string, externalSkuIds: readonly string[]): Promise<RemoteSkuRow[]> {
  if (!externalSkuIds.length) return [];
  return getDb()
    .select()
    .from(remoteSkus)
    .where(and(eq(remoteSkus.shopId, shopId), inArray(remoteSkus.externalSkuId, [...externalSkuIds])));
}

/** Số dòng của bản sao đã thấy từ `since` (lần đọc trọn trước, hoặc lượt đọc theo giờ sửa sau đó). */
export async function countRemoteSkusSeenSince(shopId: string, since: Date): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(remoteSkus)
    .where(and(eq(remoteSkus.shopId, shopId), gte(remoteSkus.seenAt, since)));
  return row?.n ?? 0;
}

/** Đọc trọn: SKU không còn thấy ở lần đọc bắt đầu lúc `seenAt` thì xoá. Gọi sau `upsertRemoteSkus` cùng `seenAt`. */
export async function dropRemoteSkusNotSeen(shopId: string, seenAt: Date): Promise<void> {
  await getDb().delete(remoteSkus).where(and(eq(remoteSkus.shopId, shopId), lt(remoteSkus.seenAt, seenAt)));
}

/** Đặt mốc của bản sao: `syncedAt` khi vừa đọc trọn, `changedSince` cho lần đọc theo giờ sửa sau. */
export async function markRemoteSkus(shopId: string, marks: { syncedAt?: Date; changedSince: Date }): Promise<void> {
  await getDb()
    .update(shops)
    .set({
      // Đọc trọn được thì xoá mốc giãn lần thử.
      ...(marks.syncedAt && { remoteSkusSyncedAt: marks.syncedAt, remoteSkusFullFailures: 0, remoteSkusFullRetryAt: null, remoteSkusFullFailedAt: null, remoteSkusFullError: null }),
      remoteSkusChangedSince: marks.changedSince,
    })
    .where(eq(shops.id, shopId));
}

/**
 * Lượt đọc trọn định kỳ lỗi: tăng số lần lỗi, mốc thử lại = bây giờ + 1 giờ × 2^(số lần lỗi trước), tối đa 24 giờ
 * (review #309 vòng 3 R1). Một câu UPDATE nên hai lượt không ghi đè nhau.
 */
export async function recordFullReadFailure(shopId: string, error: RemoteSkusFullError): Promise<void> {
  await getDb()
    .update(shops)
    .set({
      remoteSkusFullFailures: sql`${shops.remoteSkusFullFailures} + 1`,
      remoteSkusFullRetryAt: sql`now() + least(interval '1 hour' * power(2, least(${shops.remoteSkusFullFailures}, 10)), interval '24 hours')`,
      remoteSkusFullFailedAt: sql`now()`,
      remoteSkusFullError: error,
    })
    .where(eq(shops.id, shopId));
}

/**
 * Lượt Tải lại (hoặc lần mở đầu) lỗi hẳn (#361): ghi giờ lỗi, mã lỗi cho `refresh` và cooldown 10 phút, xoá lượt chờ; không
 * tính vào giãn của lượt định kỳ.
 */
export async function recordManualReadFailure(shopId: string, error: RemoteSkusFullError): Promise<void> {
  await getDb()
    .update(shops)
    .set({ remoteSkusFullFailedAt: sql`now()`, remoteSkusFullError: error, remoteSkusRefreshRequestedAt: null })
    .where(eq(shops.id, shopId));
}

/** Đánh dấu có lượt Tải lại chờ chạy nền (#361); gọi cùng giao dịch với lúc xếp việc. */
export async function markRefreshRequested(shopId: string, at: Date): Promise<void> {
  await getDb().update(shops).set({ remoteSkusRefreshRequestedAt: at }).where(eq(shops.id, shopId));
}

/** Lượt Tải lại xong (hoặc không còn việc để làm): xoá lượt chờ. */
export async function clearRefreshRequested(shopId: string): Promise<void> {
  await getDb().update(shops).set({ remoteSkusRefreshRequestedAt: null }).where(eq(shops.id, shopId));
}

export async function listRemoteSkuRows(shopId: string): Promise<RemoteSkuRow[]> {
  return getDb().select().from(remoteSkus).where(eq(remoteSkus.shopId, shopId)).orderBy(asc(remoteSkus.title), asc(remoteSkus.externalSkuId));
}

/** Số SKU của một sản phẩm sàn trong bản sao (#399: sản phẩm nhiều SKU thì ghi nội dung đè cả sản phẩm). */
export async function countRemoteSkusOfProduct(shopId: string, externalProductId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(remoteSkus)
    .where(and(eq(remoteSkus.shopId, shopId), eq(remoteSkus.externalProductId, externalProductId)));
  return row?.n ?? 0;
}

/** Các SKU của một sản phẩm sàn trong bản sao (KB3: tách nhãn biến thể từ tên chung). */
export function remoteSkusOfProduct(shopId: string, externalProductId: string): Promise<RemoteSkuRow[]> {
  return getDb()
    .select()
    .from(remoteSkus)
    .where(and(eq(remoteSkus.shopId, shopId), eq(remoteSkus.externalProductId, externalProductId)))
    .orderBy(asc(remoteSkus.externalSkuId));
}

/** Biến thể app đang liên kết (listing chưa gỡ) với SKU của một sản phẩm sàn trên gian hàng (KB3). */
export async function linkedVariantsOfRemoteProduct(shopId: string, externalProductId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ variantId: listings.variantId })
    .from(listings)
    .where(and(eq(listings.shopId, shopId), eq(listings.externalProductId, externalProductId), isNotNull(listings.variantId), ne(listings.status, 'delisted')));
  return rows.flatMap((r) => (r.variantId ? [r.variantId] : []));
}

export async function findRemoteSkuRow(shopId: string, externalSkuId: string): Promise<RemoteSkuRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(remoteSkus)
    .where(and(eq(remoteSkus.shopId, shopId), eq(remoteSkus.externalSkuId, externalSkuId)));
  return row;
}

/**
 * Số SKU trong bản sao chưa có ghép hiệu lực, theo gian hàng (§18.7.7 `unmatchedCount`, #220 đợt 2): không có listing
 * chưa gỡ cùng mã SKU sàn, hoặc listing đó chỉ chờ duyệt "không quản tồn" (chưa ai duyệt). Một câu cho cả danh sách.
 */
export async function unmatchedRemoteCounts(shopIds: readonly string[]): Promise<Map<string, number>> {
  if (!shopIds.length) return new Map();
  const rows = await getDb()
    .select({ shopId: remoteSkus.shopId, n: sql<number>`count(*)::int` })
    .from(remoteSkus)
    .where(
      and(
        inArray(remoteSkus.shopId, [...shopIds]),
        sql`not exists (select 1 from ${listings} l where l.shop_id = ${remoteSkus.shopId}
              and l.external_sku_id = ${remoteSkus.externalSkuId} and l.status <> 'delisted'
              and (l.mode = 'mapped' or l.approved_by is not null))`,
      ),
    )
    .groupBy(remoteSkus.shopId);
  return new Map(rows.map((r) => [r.shopId, r.n]));
}
