import type { ModuleContext } from '../../../../shared/module.ts';
import type { OptionalModule } from '../domain/modules.ts';

/** Người thao tác hiện trên FE (`ActorRef`, Documents/21 M5). */
export interface AccountRef {
  accountId: string;
  email: string;
  fullName: string;
}

/**
 * Hàm của module khác mà `platform` cần (#152). `staff` import `platform` nên không import ngược được: `core/index.ts`
 * tiêm `accountSummaries`, `platformAccount`. Bảng của phân hệ tuỳ chọn ở module lớn lớp trên: `src/wiring.ts` tiêm
 * `moduleData`.
 */
export interface PlatformContext extends ModuleContext {
  readonly accountSummaries?: (ids: readonly string[]) => Promise<{ id: string; email: string; fullName: string }[]>;
  /** Cờ quản trị nền tảng và lần đổi mật khẩu gần nhất (token phát trước đó hết hiệu lực, #62); `undefined` khi không có. */
  readonly platformAccount?: (
    accountId: string,
  ) => Promise<{ isPlatformAdmin: boolean; passwordChangedAt: Date | null } | undefined>;
  /** Công ty đang chọn đã có dữ liệu trong phân hệ chưa, gọi trong `withCompany`. Không có hàm là chưa có (vd report). */
  readonly moduleData?: Partial<Record<OptionalModule, () => Promise<boolean>>>;
}

/** `ActorRef` theo id; id trống hay tài khoản không còn thì `null`. */
export async function accountRefs(ctx: PlatformContext, ids: readonly (string | null)[]) {
  const found = await ctx.accountSummaries!(ids.filter((id): id is string => !!id));
  const refs = new Map(found.map((a) => [a.id, { accountId: a.id, email: a.email, fullName: a.fullName }]));
  return (id: string | null): AccountRef | null => (id ? (refs.get(id) ?? null) : null);
}
