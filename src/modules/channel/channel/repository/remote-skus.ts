// Bản sao danh sách SKU của gian hàng trên sàn (#220 đợt 2, bảng `remote_skus`). Chạy trong `withCompany` của bên gọi.
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { listings, remoteSkus, shops } from './schema.ts';

export type RemoteSkuRow = typeof remoteSkus.$inferSelect;
/** SKU sàn adapter trả (cùng trường với `RemoteSku` của `marketplaces/common.ts`; repository không import lớp service). */
export interface RemoteSkuInput {
  externalProductId: string;
  externalSkuId: string;
  sellerSku: string;
  title: string;
  state: string;
  quantity: number;
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
      state: s.state as RemoteSkuRow['state'],
      // Sàn không có tồn âm; số lạ không làm hỏng cả bản sao.
      quantity: Math.max(0, Math.trunc(s.quantity)),
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
            state: sql`excluded.state`,
            quantity: sql`excluded.quantity`,
            seenAt: sql`excluded.seen_at`,
          },
        });
    }
  }
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
    .set({ ...(marks.syncedAt && { remoteSkusSyncedAt: marks.syncedAt }), remoteSkusChangedSince: marks.changedSince })
    .where(eq(shops.id, shopId));
}

export async function listRemoteSkuRows(shopId: string): Promise<RemoteSkuRow[]> {
  return getDb().select().from(remoteSkus).where(eq(remoteSkus.shopId, shopId)).orderBy(asc(remoteSkus.title), asc(remoteSkus.externalSkuId));
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
