// Khung máy trạng thái dùng chung cho các thực thể vòng đời (Documents/21 mục 14.1, so-do-vong-doi).
// Cùng hình với FE `src/lib/stateMachine.ts` để bảng chép qua lại được. Chỉ kiểm, không ghi: câu UPDATE có điều kiện
// (`WHERE status = from AND version = …`) ở repository của từng module, lịch sử ghi bằng `recordTransition`.
import { moduleOfPermission } from '../../../../shared/auth/company-access.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';

export interface Transition<S extends string, A extends string, R = Record<string, unknown>> {
  from: S | readonly S[];
  to: S;
  action: A;
  /** Nhãn nút ở FE; BE không dùng, giữ để chép dòng bảng qua lại. */
  label?: string;
  /** Mã quyền của bước; bỏ trống: ai qua được quyền của route là làm được. */
  permission?: string;
  /** Người làm phải khác `record.createdBy`. */
  needsSecondPerson?: boolean;
  /** CEO hoặc khách thuê một người được tự làm bước cần người thứ hai; chỉ bật ở bảng có cột `self_approved`. */
  allowSelfApproval?: boolean;
  needsReason?: boolean;
  /** Chỉ hệ thống hoặc sàn làm (actor null). */
  system?: boolean;
  /** Điều kiện theo dữ liệu: trả mã lỗi (409) khi bị chặn, null khi cho qua. */
  guard?: (record: R) => string | null;
}

export interface StateMachine<S extends string, A extends string, R = Record<string, unknown>> {
  readonly transitions: readonly Transition<S, A, R>[];
}

export interface TransitionContext<R = Record<string, unknown>> {
  /**
   * null khi hệ thống hoặc sàn chuyển. `permissions`, `enabledModules` lấy nguyên từ `getAccess(res)`: quyền thuộc
   * phân hệ đang tắt không có hiệu lực (Documents/21 mục 8).
   */
  actor: { accountId: string; permissions: readonly string[]; enabledModules: readonly string[] } | null;
  /** `createdBy`: người mà bước cần người thứ hai phải khác (người lập, người báo thất lạc…); bên gọi tự nạp. */
  record?: R & { createdBy?: string | null };
  reason?: string | null;
  /** Kết quả `canSelfApprove` của người làm. */
  canSelfApprove?: boolean;
  /** Bản ghi dạng API trả trong `current` của lỗi `invalid_transition`; không có thì trả chuỗi trạng thái. */
  view?: unknown;
}

export function defineMachine<S extends string, A extends string, R = Record<string, unknown>>(
  transitions: readonly Transition<S, A, R>[],
): StateMachine<S, A, R> {
  return { transitions };
}

const fromList = <S extends string>(from: S | readonly S[]): readonly S[] => (typeof from === 'string' ? [from] : from);

const hasPermission = (actor: NonNullable<TransitionContext['actor']>, permission: string) =>
  actor.permissions.includes(permission) && actor.enabledModules.includes(moduleOfPermission(permission));

/**
 * Mã lỗi đầu tiên chặn bước này, theo thứ tự của FE. Không kiểm lý do: nút vẫn hiện, lý do nhập sau khi bấm.
 * `selfApproved`: qua nhờ tự duyệt.
 */
function check<S extends string, A extends string, R>(
  t: Transition<S, A, R>,
  ctx: TransitionContext<R>,
): { code: string; status: number } | { selfApproved: boolean } {
  const { actor, record } = ctx;
  if (actor && t.system) return { code: 'invalid_transition', status: 409 };
  if (actor && t.permission && !hasPermission(actor, t.permission)) return { code: 'forbidden', status: 403 };
  let selfApproved = false;
  if (actor && t.needsSecondPerson && record?.createdBy && record.createdBy === actor.accountId) {
    if (!(t.allowSelfApproval && ctx.canSelfApprove)) return { code: 'second_person_required', status: 409 };
    selfApproved = true;
  }
  const guarded = record && t.guard?.(record);
  if (guarded) return { code: guarded, status: 409 };
  return { selfApproved };
}

const MESSAGES: Record<string, string> = {
  invalid_transition: 'Thao tác không hợp lệ ở trạng thái hiện tại',
  forbidden: 'Bạn không có quyền thực hiện thao tác này',
  second_person_required: 'Bước này cần người khác người lập thực hiện',
  reason_required: 'Cần ghi lý do',
};

/** Kiểm một thao tác; ném `AppError` theo Documents/21 mục 14.1, qua thì trả trạng thái đích. */
export function assertTransition<S extends string, A extends string, R>(
  machine: StateMachine<S, A, R>,
  current: S,
  action: A,
  ctx: TransitionContext<R>,
): { to: S; selfApproved: boolean } {
  const t = machine.transitions.find((x) => x.action === action && fromList(x.from).includes(current));
  let result = t ? check(t, ctx) : { code: 'invalid_transition', status: 409 };
  if (!('code' in result) && t!.needsReason && !ctx.reason?.trim()) result = { code: 'reason_required', status: 422 };
  if ('code' in result) {
    const extensions = result.code === 'invalid_transition' ? { current: ctx.view ?? current } : undefined;
    throw new AppError(result.status, result.code, MESSAGES[result.code] ?? 'Không thực hiện được thao tác', extensions);
  }
  return { to: t!.to, selfApproved: result.selfApproved };
}

/** Các thao tác người dùng làm được từ trạng thái hiện tại, để trả kèm bản ghi cho FE. */
export function availableActions<S extends string, A extends string, R>(
  machine: StateMachine<S, A, R>,
  current: S,
  ctx: TransitionContext<R>,
): Transition<S, A, R>[] {
  return machine.transitions.filter((t) => fromList(t.from).includes(current) && !t.system && !('code' in check(t, ctx)));
}
