import type { Express } from 'express';
import request from 'supertest';
import type { EventPayload } from '#src/modules/core/platform/index.ts';
import { handleOtpRequested } from '#src/modules/core/staff/service/otp-consumer.ts';
import { hashPassword } from '#src/shared/crypto/password.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { type MailTransport, setMailTransport } from '#src/shared/mail/index.ts';
import { uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { PASSWORD } from '../../helpers/http.ts';

export async function accountIdOf(email: string): Promise<string> {
  const res = await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [email]);
  return res.rows[0]!.id;
}

/**
 * Lời mời đã nộp (`pending`) chèn thẳng bằng role chủ bảng, như sau `/join/complete`. Có `existingAccountId` thì là
 * tài khoản đã có (`sign_in`); không thì là email mới (`set_password`) với mật khẩu `PASSWORD`.
 */
export async function pendingInvitation(
  companyId: string,
  options: { createdBy: string; roleIds: string[]; email?: string; existingAccountId?: string },
): Promise<{ id: string; version: number; email: string }> {
  const email = options.email ?? uniqueEmail('moi');
  const passwordHash = options.existingAccountId ? null : await hashPassword(PASSWORD);
  const res = await testPool().query<{ id: string; version: number }>(
    `insert into core.invitations
       (company_id, role_ids, created_by, expires_at, status, email, full_name, submitted_at, password_hash, account_id)
     values ($1, $2, $3, now() + interval '72 hours', 'pending', $4, 'Nhân Viên Mới', now(), $5, $6)
     returning id, version`,
    [companyId, options.roleIds, options.createdBy, email, passwordHash, options.existingAccountId ?? null],
  );
  return { id: res.rows[0]!.id, version: res.rows[0]!.version, email };
}

type SentMail = Parameters<MailTransport['sendMail']>[0];

/** Transport giả ghi lại thư; `fail` thì ném lỗi như nodemailer. Gọi `setMailTransport(null)` trong `afterEach`. */
export function captureMail(fail?: object): SentMail[] {
  const sent: SentMail[] = [];
  setMailTransport({
    sendMail: async (message) => {
      if (fail) throw fail;
      sent.push(message);
      return {};
    },
  });
  return sent;
}

/** Mã 6 số trong thư OTP. */
export const codeIn = (mail: SentMail) => mail.text.match(/\b\d{6}\b/)![0];

/**
 * Làm thay worker: đọc sự kiện xin mã mới nhất của lời mời trong outbox rồi gọi consumer như consumer `shared`
 * (trong withCompany của sự kiện). Không có sự kiện thì ném.
 */
export async function deliverOtp(invitationId: string): Promise<void> {
  const res = await testPool().query<{
    event_id: string;
    company_id: string;
    key: string;
    payload: unknown;
    created_at: Date;
  }>(
    `select event_id, company_id, key, payload, created_at from core.outbox_messages
     where type = 'staff.invitation_otp_requested' and key = $1 order by id desc limit 1`,
    [invitationId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Lời mời ${invitationId} chưa có sự kiện xin mã`);
  const event = {
    eventId: row.event_id,
    type: 'staff.invitation_otp_requested' as const,
    companyId: row.company_id,
    aggregateId: row.key,
    occurredAt: row.created_at.toISOString(),
    payload: row.payload as EventPayload<'staff.invitation_otp_requested'>,
  };
  await withCompany(row.company_id, () => handleOtpRequested(event));
}

export const otpEvents = async (invitationId: string) =>
  Number(
    (
      await testPool().query(
        "select count(*) from core.outbox_messages where type = 'staff.invitation_otp_requested' and key = $1",
        [invitationId],
      )
    ).rows[0].count,
  );

/** Gọi API công khai `/identity/join/*`. */
export function joinApi(app: Express) {
  const post = (path: string, body: object) => request(app).post(`/api/v1/identity/join/${path}`).send(body);
  return {
    check: (token: string) => post('check', { token }),
    otp: (token: string, email: string, fullName = 'Người Được Mời') => post('otp', { token, email, fullName }),
    verify: (token: string, email: string, code: string) => post('verify', { token, email, code }),
    complete: (body: { registrationToken: string; password: string; confirmPassword?: string }) =>
      post('complete', body),
  };
}

/** CEO (hay Admin) tạo link qua API; trả id lời mời và token sau `#`. */
export async function newLink(app: Express, token: string, roleIds: string[]): Promise<{ id: string; token: string }> {
  const res = await request(app)
    .post('/api/v1/identity/invitations')
    .set('Authorization', `Bearer ${token}`)
    .send({ roleIds });
  if (res.status !== 201) throw new Error(`Tạo link lỗi ${res.status}`);
  return { id: res.body.id as string, token: (res.body.link as string).split('#')[1]! };
}
