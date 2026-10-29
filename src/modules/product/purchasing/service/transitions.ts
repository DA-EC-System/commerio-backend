import { assertTransition, type StateMachine, type TransitionContext } from '../../../core/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';

/**
 * `assertTransition` kèm bản chi tiết mới nhất trong `current` của `invalid_transition` (Documents/21 mục 14.1). Bản
 * chi tiết chỉ dựng khi bị chặn, vì dựng tốn vài truy vấn.
 */
export async function checkTransition<S extends string, A extends string, R>(
  machine: StateMachine<S, A, R>,
  from: S,
  action: A,
  ctx: TransitionContext<R>,
  current: () => Promise<unknown>,
) {
  try {
    return assertTransition(machine, from, action, ctx);
  } catch (err) {
    if (err instanceof AppError && err.code === 'invalid_transition') {
      throw new AppError(409, err.code, err.message, { current: await current() });
    }
    throw err;
  }
}
