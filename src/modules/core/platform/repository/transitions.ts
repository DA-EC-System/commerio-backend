import { and, asc, count, desc, eq, gte, lt } from 'drizzle-orm';
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
  /** `selfApproved` mà `assertTransition` trả: bước người duyệt khác đi theo ngoại lệ tự duyệt. */
  selfApproved?: boolean;
  /**
   * Dòng nhật ký thao tác của lần tự duyệt: `entityType` theo mẫu nhật ký `<schema>.<bảng>` (vd
   * `product.purchase_requests`), `label` là mã chứng từ. Không có thì ghi tên bảng của lịch sử. Chỉ dùng khi `selfApproved`.
   */
  audit?: { entityType: string; label?: string | null };
}

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
