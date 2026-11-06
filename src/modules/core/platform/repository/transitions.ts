import { and, asc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import { getDb, requireCompanyId } from '../../../../shared/db/client.ts';
import { stateTransitions } from './schema.ts';

export type TransitionSource = 'user' | 'marketplace' | 'system';

export interface TransitionRecord {
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
 * Ghi một lần chuyển trạng thái trong giao dịch của bên gọi, ngay sau câu UPDATE trạng thái (N4). Bảng chỉ thêm.
 * `source` mặc định `user` khi có `actorId`, `system` khi không.
 */
export async function recordTransition(input: TransitionRecord): Promise<void> {
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
}

/** Lịch sử của một thực thể trong công ty hiện tại, cũ trước. Cùng `at` (một giao dịch) thì theo thứ tự ghi. */
export async function listTransitions(entityType: string, entityId: string): Promise<TransitionRow[]> {
  requireCompanyId('listTransitions');
  const t = stateTransitions;
  return getDb()
    .select({ at: t.at, from: t.fromState, to: t.toState, action: t.action, actorId: t.actorId, source: t.source, reason: t.reason })
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
