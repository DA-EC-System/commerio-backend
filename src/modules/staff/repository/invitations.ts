// Lời mời bằng link (#7 [C]). Mọi hàm chạy trong `withCompany` (RLS `company_isolation`, migration 0019); vẫn lọc
// thêm `company_id` cho rõ. Mỗi chuyển trạng thái là một UPDATE có điều kiện theo spec 6.4, 6.7: không trúng dòng
// thì bên gọi đọc lại để chọn mã lỗi.
import { and, count, desc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { PURPOSE_TTL_SECONDS } from '../../../shared/auth/purpose-token.ts';
import { getDb, requireCompanyId } from '../../../shared/db/client.ts';
import type { InvitationStatus } from '../domain/invitation-machine.ts';
import { OTP_MAX_ATTEMPTS, OTP_MAX_SENDS, OTP_RESEND_SECONDS, OTP_TTL_SECONDS } from '../domain/otp.ts';
import { invitations } from './schema.ts';

export type InvitationRow = typeof invitations.$inferSelect;

const seconds = (n: number) => sql`${`${n} seconds`}::interval`;
const bump = {
  version: sql`${invitations.version} + 1`,
  updatedAt: sql`now()`,
};

function inCompany(fn: string, ...conditions: SQL[]) {
  return and(eq(invitations.companyId, requireCompanyId(fn)), ...conditions);
}

/** Hạn link tính trong DB, cùng thời lượng với token `invite` (72 giờ). */
export async function insertInvitation(input: {
  companyId: string;
  roleIds: string[];
  createdBy: string;
}): Promise<InvitationRow> {
  const companyId = requireCompanyId('insertInvitation');
  if (input.companyId !== companyId) throw new Error('insertInvitation: companyId khác công ty của withCompany');
  const [row] = await getDb()
    .insert(invitations)
    .values({
      companyId,
      roleIds: input.roleIds,
      createdBy: input.createdBy,
      expiresAt: sql`now() + ${seconds(PURPOSE_TTL_SECONDS.invite)}`,
    })
    .returning();
  return row!;
}

export async function findInvitation(
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<InvitationRow | undefined> {
  const query = getDb()
    .select()
    .from(invitations)
    .where(inCompany('findInvitation', eq(invitations.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/**
 * Xin mã OTP (`open → open`, `claimed → claimed`): ghi email, họ tên (chỉ khi còn `open`; `claimed` thì email phải
 * trùng), xoá mã cũ, đếm lần gửi. Chặn khi link hết hạn, đã gửi đủ 5 lần, chưa qua 60 giây. `undefined` khi không
 * trúng dòng. `otp_requested_at` cắt về mili giây để consumer so khớp với `requestedAt` trong sự kiện.
 */
export async function requestOtpWrite(
  id: string,
  email: string,
  fullName: string,
): Promise<{ otpRequestedAt: Date } | undefined> {
  const t = invitations;
  const [row] = await getDb()
    .update(t)
    .set({
      email,
      fullName: sql`case when ${t.status} = 'open' then ${fullName} else ${t.fullName} end`,
      otpRequestedAt: sql`date_trunc('milliseconds', now())`,
      otpSendCount: sql`${t.otpSendCount} + 1`,
      otpAttempts: 0,
      otpHash: null,
      otpExpiresAt: null,
      ...bump,
    })
    .where(
      inCompany(
        'requestOtpWrite',
        eq(t.id, id),
        sql`${t.expiresAt} > now()`,
        sql`${t.otpSendCount} < ${OTP_MAX_SENDS}`,
        sql`(${t.status} = 'open' or (${t.status} = 'claimed' and ${t.email} = ${email}))`,
        sql`(${t.otpRequestedAt} is null or ${t.otpRequestedAt} < now() - ${seconds(OTP_RESEND_SECONDS)})`,
      ),
    )
    .returning({ otpRequestedAt: t.otpRequestedAt });
  return row ? { otpRequestedAt: row.otpRequestedAt! } : undefined;
}

/** Consumer ghi bản băm của mã vừa sinh, hạn 5 phút. Bên gọi đã khoá dòng và kiểm `otp_requested_at`. */
export async function storeOtpHash(id: string, otpHash: string): Promise<void> {
  await getDb()
    .update(invitations)
    .set({
      otpHash,
      otpExpiresAt: sql`now() + ${seconds(OTP_TTL_SECONDS)}`,
      updatedAt: sql`now()`,
    })
    .where(inCompany('storeOtpHash', eq(invitations.id, id)));
}

/**
 * Tăng bộ đếm sai trước khi so mã (nguyên tử: nhiều verify song song không vượt 5), trả bản băm để bên gọi so.
 * `undefined` khi chưa có mã, mã hết hạn, đã sai đủ 5 lần, email khác email đã xin mã, hay không còn `open`/`claimed`.
 */
export async function consumeOtpAttempt(id: string, email: string): Promise<{ otpHash: string } | undefined> {
  const t = invitations;
  const [row] = await getDb()
    .update(t)
    .set({ otpAttempts: sql`${t.otpAttempts} + 1`, updatedAt: sql`now()` })
    .where(
      inCompany(
        'consumeOtpAttempt',
        eq(t.id, id),
        eq(t.email, email),
        inArray(t.status, ['open', 'claimed']),
        isNotNull(t.otpHash),
        sql`${t.otpExpiresAt} > now()`,
        sql`${t.expiresAt} > now()`,
        sql`${t.otpAttempts} < ${OTP_MAX_ATTEMPTS}`,
      ),
    )
    .returning({ otpHash: t.otpHash });
  return row ? { otpHash: row.otpHash! } : undefined;
}

/** Mã đúng (`open | claimed → claimed`): xoá mã để không dùng lại được. */
export async function markClaimed(id: string, email: string): Promise<boolean> {
  const t = invitations;
  const rows = await getDb()
    .update(t)
    .set({ status: 'claimed', otpHash: null, otpExpiresAt: null, ...bump })
    .where(
      inCompany(
        'markClaimed',
        eq(t.id, id),
        eq(t.email, email),
        inArray(t.status, ['open', 'claimed']),
        isNotNull(t.otpHash),
        sql`${t.expiresAt} > now()`,
      ),
    )
    .returning({ id: t.id });
  return rows.length === 1;
}

/**
 * Nộp (`claimed → pending`): đúng một trong `passwordHash` (email mới) và `accountId` (tài khoản đã có). Chặn khi link
 * hết hạn. Trùng yêu cầu chờ duyệt cùng email trong công ty thì ném 23505 `invitations_one_pending_per_email`.
 */
export async function submitInvitation(
  id: string,
  email: string,
  input: { passwordHash: string | null; accountId: string | null; requireTotp?: boolean },
): Promise<boolean> {
  const t = invitations;
  const rows = await getDb()
    .update(t)
    .set({
      status: 'pending',
      submittedAt: sql`now()`,
      passwordHash: input.passwordHash,
      accountId: input.accountId,
      ...bump,
    })
    .where(
      inCompany(
        'submitInvitation',
        eq(t.id, id),
        eq(t.status, 'claimed'),
        eq(t.email, email),
        sql`${t.expiresAt} > now()`,
        // [D] email mới khi 2FA bắt buộc: phải xác nhận 2FA trước khi nộp.
        ...(input.requireTotp ? [isNotNull(t.totpConfirmedAt)] : []),
      ),
    )
    .returning({ id: t.id });
  return rows.length === 1;
}

/**
 * [D] Thiết lập 2FA lúc tham gia (email mới): ghi secret đã mã hoá (AAD `totp:<invitationId>`). Gọi lại thì thay secret,
 * bỏ xác nhận cũ. Chỉ khi link còn `claimed` với đúng email và còn hạn.
 */
export async function saveInvitationTotpSecret(id: string, email: string, sealed: Buffer): Promise<boolean> {
  const t = invitations;
  const rows = await getDb()
    .update(t)
    .set({ totpSecretEnc: sealed, totpConfirmedAt: null, recoveryCodeHashes: [], ...bump })
    .where(
      inCompany(
        'saveInvitationTotpSecret',
        eq(t.id, id),
        eq(t.status, 'claimed'),
        eq(t.email, email),
        sql`${t.expiresAt} > now()`,
      ),
    )
    .returning({ id: t.id });
  return rows.length === 1;
}

/** [D] Xác nhận 2FA của lời mời bằng một mã đúng: ghi lúc xác nhận và bản băm mã khôi phục (duyệt thì chép sang tài khoản). */
export async function confirmInvitationTotp(id: string, email: string, recoveryHashes: string[]): Promise<boolean> {
  const t = invitations;
  const rows = await getDb()
    .update(t)
    .set({ totpConfirmedAt: sql`now()`, recoveryCodeHashes: recoveryHashes, ...bump })
    .where(
      inCompany(
        'confirmInvitationTotp',
        eq(t.id, id),
        eq(t.status, 'claimed'),
        eq(t.email, email),
        isNotNull(t.totpSecretEnc),
        sql`${t.expiresAt} > now()`,
      ),
    )
    .returning({ id: t.id });
  return rows.length === 1;
}

/**
 * Duyệt hoặc từ chối (`pending → approved | rejected`) theo `version`; hết hạn link không chặn. Xoá mật khẩu băm và
 * mã OTP. `accountId`: tài khoản tạo lúc duyệt (email mới); bỏ trống thì giữ tài khoản đã có.
 */
export async function decideInvitation(
  id: string,
  version: number,
  decision: {
    status: 'approved' | 'rejected';
    decidedBy: string;
    accountId?: string;
  },
): Promise<InvitationRow | undefined> {
  const t = invitations;
  const [row] = await getDb()
    .update(t)
    .set({
      status: decision.status,
      decidedBy: decision.decidedBy,
      decidedAt: sql`now()`,
      ...(decision.accountId ? { accountId: decision.accountId } : {}),
      passwordHash: null,
      otpHash: null,
      otpExpiresAt: null,
      // [D] secret và mã khôi phục đã chép sang tài khoản lúc duyệt (CHECK `invitations_decided_clean`, 0020).
      totpSecretEnc: null,
      totpConfirmedAt: null,
      recoveryCodeHashes: [],
      ...bump,
    })
    .where(inCompany('decideInvitation', eq(t.id, id), eq(t.version, version), eq(t.status, 'pending')))
    .returning();
  return row;
}

/** Trang lời mời: mới nộp trước, rồi mới tạo trước. `status` trống thì lấy mọi trạng thái. */
export async function listInvitationRows(query: {
  status?: InvitationStatus;
  page: number;
  pageSize: number;
}): Promise<{ rows: InvitationRow[]; total: number }> {
  const t = invitations;
  const where = inCompany('listInvitationRows', ...(query.status ? [eq(t.status, query.status)] : []));
  const db = getDb();
  // Tuần tự: hai câu cùng một kết nối giao dịch.
  const [counted] = await db.select({ total: count() }).from(t).where(where);
  const rows = await db
    .select()
    .from(t)
    .where(where)
    .orderBy(sql`${t.submittedAt} desc nulls last`, desc(t.createdAt), t.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { rows, total: counted?.total ?? 0 };
}
