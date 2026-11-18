import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, max, sql } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { stateTransitions } from './schema.ts';

export type TransitionSource = 'user' | 'marketplace' | 'system';

interface TransitionBase {
  /** Tên bảng của thực thể, vd `packages`. */
  entityType: string;
  entityId: string;
  /** null khi bản ghi vừa tạo. */
  from: string | null;
  to: string;
  action: string;
  /** null khi sàn hoặc hệ thống chuyển. */
  actorId: string | null;
  source?: TransitionSource;
  reason?: string | null;
}

/**
 * Bước có người duyệt khác truyền `selfApproved` (lấy nguyên từ `assertTransition`) và bắt buộc kèm `audit`: lần tự duyệt
 * ghi một dòng nhật ký thao tác với `entityType` theo mẫu `<schema>.<bảng>` (vd `product.purchase_requests`) và `label`
 * là tên người đọc được (số chứng từ…; #352).
 */
export type TransitionRecord = TransitionBase &
  (
    | { selfApproved?: undefined; audit?: undefined }
    | { selfApproved: boolean; audit: { entityType: string; label: string } }
  );

/**
 * Chèn một dòng lịch sử trong giao dịch của bên gọi. Bảng chỉ thêm. `source` mặc định `user` khi có `actorId`,
 * `system` khi không. Module khác gọi `recordTransition` của service (ghi thêm nhật ký khi tự duyệt).
 */
export async function insertTransition(input: TransitionRecord): Promise<void> {
  const companyId = requireCompanyId('recordTransition');
  await getDb()
    .insert(stateTransitions)
    .values({
      companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      fromState: input.from,
      toState: input.to,
      action: input.action,
      actorId: input.actorId,
      source: input.source ?? (input.actorId ? 'user' : 'system'),
      reason: input.reason ?? null,
      selfApproved: input.selfApproved ?? false,
    });
}

export interface TransitionRow {
  at: Date;
  from: string | null;
  to: string;
  action: string;
  actorId: string | null;
  source: TransitionSource;
  reason: string | null;
  selfApproved: boolean;
}

/** Lịch sử của một thực thể trong công ty hiện tại, cũ trước. Cùng `at` (một giao dịch) thì theo thứ tự ghi. */
export async function listTransitions(entityType: string, entityId: string): Promise<TransitionRow[]> {
  requireCompanyId('listTransitions');
  const t = stateTransitions;
  return getDb()
    .select({
      at: t.at,
      from: t.fromState,
      to: t.toState,
      action: t.action,
      actorId: t.actorId,
      source: t.source,
      reason: t.reason,
      selfApproved: t.selfApproved,
    })
    .from(t)
    .where(and(eq(t.entityType, entityType), eq(t.entityId, entityId)))
    .orderBy(asc(t.at), asc(t.id));
}

/**
 * Lúc chuyển trạng thái gần nhất của nhiều thực thể cùng loại, một câu cho cả danh sách. Bản ghi lúc tạo (`from` null)
 * không tính: thực thể chưa đổi lần nào không có trong Map. Gọi trong `withCompany`.
 */
export async function lastTransitionsAt(entityType: string, entityIds: readonly string[]): Promise<Map<string, Date>> {
  requireCompanyId('lastTransitionsAt');
  if (entityIds.length === 0) return new Map();
  const t = stateTransitions;
  const rows = await getDb()
    .select({ id: t.entityId, at: max(t.at) })
    .from(t)
    .where(and(eq(t.entityType, entityType), inArray(t.entityId, [...entityIds]), isNotNull(t.fromState)))
    .groupBy(t.entityId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.id, r.at] as const] : [])));
}

/**
 * Thao tác của lần gần nhất mỗi thực thể vào trạng thái `to` (vd listing vào `hidden` bằng `hide` hay `relist`), một câu
 * cho cả danh sách. Dòng đứng yên ở `to` (`from = to`, vd ghép lại trên listing đang ẩn) không tính. Thực thể chưa từng
 * vào `to` không có trong Map. Gọi trong `withCompany`.
 */
export async function lastEntryActions(entityType: string, entityIds: readonly string[], to: string): Promise<Map<string, string>> {
  requireCompanyId('lastEntryActions');
  if (entityIds.length === 0) return new Map();
  const t = stateTransitions;
  const rows = await getDb()
    .selectDistinctOn([t.entityId], { id: t.entityId, action: t.action })
    .from(t)
    .where(and(eq(t.entityType, entityType), inArray(t.entityId, [...entityIds]), eq(t.toState, to), sql`${t.fromState} is distinct from ${t.toState}`))
    .orderBy(t.entityId, desc(t.at), desc(t.id));
  return new Map(rows.map((r) => [r.id, r.action]));
}

export interface SelfApprovalRow extends TransitionRow {
  entityType: string;
  entityId: string;
}

/** Các lần tự duyệt của công ty hiện tại trong `[from, to)`, mới trước, cho báo cáo CEO (#246). */
export async function listSelfApprovals(
  range: { from: Date; to: Date },
  page: { limit: number; offset: number },
): Promise<{ rows: SelfApprovalRow[]; total: number }> {
  requireCompanyId('listSelfApprovals');
  const t = stateTransitions;
  const where = and(eq(t.selfApproved, true), gte(t.at, range.from), lt(t.at, range.to));
  const [rows, [counted]] = await Promise.all([
    getDb()
      .select({
        entityType: t.entityType,
        entityId: t.entityId,
        at: t.at,
        from: t.fromState,
        to: t.toState,
        action: t.action,
        actorId: t.actorId,
        source: t.source,
        reason: t.reason,
        selfApproved: t.selfApproved,
      })
      .from(t)
      .where(where)
      .orderBy(desc(t.at), desc(t.id))
      .limit(page.limit)
      .offset(page.offset),
    getDb().select({ total: count() }).from(t).where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}
