import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, EventPayload } from '#src/modules/platform/index.ts';
import { otpHash } from '#src/modules/staff/domain/otp.ts';
import { insertInvitation, requestOtpWrite } from '#src/modules/staff/repository/invitations.ts';
import { handleOtpRequested } from '#src/modules/staff/service/otp-consumer.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { type MailTransport, setMailTransport } from '#src/shared/mail/index.ts';
import { metricsRegistry } from '#src/shared/observability/metrics.ts';
import { registerCompany, uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';

type OtpEvent = EventEnvelope<'staff.invitation_otp_requested', EventPayload<'staff.invitation_otp_requested'>>;
type SentMail = Parameters<MailTransport['sendMail']>[0];

const db = testPool();

afterEach(() => setMailTransport(null));

/** Transport giả ghi lại thư; `fail` thì ném lỗi như nodemailer. */
function captureMail(fail?: object): SentMail[] {
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

/** Lời mời đã xin mã (như `/join/otp`), cùng sự kiện mà bước đó phát. */
async function requestedInvitation(): Promise<{ id: string; companyId: string; email: string; event: OtpEvent }> {
  const { email: ceoEmail, companyId } = await registerCompany();
  const ceo = await db.query<{ id: string }>('select id from staff.accounts where email = $1', [ceoEmail]);
  const email = uniqueEmail('moi');
  const { id, requestedAt } = await withCompany(companyId, async () => {
    const row = await insertInvitation({ companyId, roleIds: [randomUUID()], createdBy: ceo.rows[0]!.id });
    const written = await requestOtpWrite(row.id, email, 'Trần Thị Mai');
    return { id: row.id, requestedAt: written!.otpRequestedAt };
  });
  return { id, companyId, email, event: otpEvent(companyId, id, requestedAt.toISOString()) };
}

function otpEvent(companyId: string, invitationId: string, requestedAt: string): OtpEvent {
  return {
    eventId: randomUUID(),
    type: 'staff.invitation_otp_requested',
    companyId,
    aggregateId: invitationId,
    occurredAt: requestedAt,
    payload: { invitationId, requestedAt },
  };
}

// Handler chạy như consumer `shared`: trong withCompany của sự kiện, lỗi thì giao dịch rollback.
const consume = (event: OtpEvent) => withCompany(event.companyId!, () => handleOtpRequested(event));

const row = async (id: string) =>
  (
    await db.query<{ otp_hash: string | null; otp_expires_at: Date | null; otp_requested_at: Date }>(
      'select otp_hash, otp_expires_at, otp_requested_at from staff.invitations where id = $1',
      [id],
    )
  ).rows[0]!;

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric(name)?.get();
  const hit = metric?.values.find((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value));
  return hit?.value ?? 0;
}

// Consumer gửi OTP lời mời (#7 [C], spec 6.7 "Consumer OTP", 6.8).
describe('consumer OTP lời mời', () => {
  it('gửi đúng một thư có mã 6 số tới email đã xin, DB chỉ giữ bản băm của mã đó, hạn 5 phút', async () => {
    const sent = captureMail();
    const inv = await requestedInvitation();
    const before = await counter('otp_requests_total', { result: 'sent' });
    await consume(inv.event);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(inv.email);
    expect(sent[0]!.text).toContain('Trần Thị Mai');
    const code = sent[0]!.text.match(/\b\d{6}\b/)![0];
    expect((await row(inv.id)).otp_hash).toBe(otpHash(code, inv.id));
    // Tính bằng đồng hồ DB: đồng hồ container có thể lệch đồng hồ của Node vài giây.
    const ttl = await db.query<{ seconds: number }>(
      'select extract(epoch from otp_expires_at - now())::float as seconds from staff.invitations where id = $1',
      [inv.id],
    );
    expect(ttl.rows[0]!.seconds).toBeGreaterThan(240);
    expect(ttl.rows[0]!.seconds).toBeLessThanOrEqual(300);
    expect(await counter('otp_requests_total', { result: 'sent' })).toBe(before + 1);
  });

  // Mốc đúng 300/301 giây kiểm ở test unit của domain/otp.ts; ở đây lùi xa hơn vì đồng hồ DB lệch đồng hồ Node.
  it('sự kiện cũ hơn 5 phút: không gửi, không đổi DB', async () => {
    const sent = captureMail();
    const inv = await requestedInvitation();
    const old = await db.query<{ at: Date }>(
      "update staff.invitations set otp_requested_at = date_trunc('milliseconds', now()) - interval '330 seconds' where id = $1 returning otp_requested_at as at",
      [inv.id],
    );
    const before = await counter('otp_requests_total', { result: 'stale' });
    await consume(otpEvent(inv.companyId, inv.id, old.rows[0]!.at.toISOString()));
    expect(sent).toEqual([]);
    expect((await row(inv.id)).otp_hash).toBeNull();
    expect(await counter('otp_requests_total', { result: 'stale' })).toBe(before + 1);
  });

  it('requestedAt không khớp otp_requested_at (đã có lần xin sau): bỏ qua', async () => {
    const sent = captureMail();
    const inv = await requestedInvitation();
    const earlier = new Date(Date.parse(inv.event.payload.requestedAt) - 1).toISOString();
    const before = await counter('otp_requests_total', { result: 'skipped' });
    await consume(otpEvent(inv.companyId, inv.id, earlier));
    expect(sent).toEqual([]);
    expect((await row(inv.id)).otp_hash).toBeNull();
    expect(await counter('otp_requests_total', { result: 'skipped' })).toBe(before + 1);
  });

  it('lời mời không còn open/claimed, hay không còn dòng: bỏ qua, không ném', async () => {
    const sent = captureMail();
    const inv = await requestedInvitation();
    await db.query(
      "update staff.invitations set status = 'pending', submitted_at = now(), password_hash = 'argon2-gia' where id = $1",
      [inv.id],
    );
    await expect(consume(inv.event)).resolves.toBeUndefined();
    await expect(
      consume(otpEvent(inv.companyId, randomUUID(), inv.event.payload.requestedAt)),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('giao lại sự kiện đã gửi thư: không gửi lần hai, giữ mã đầu', async () => {
    const sent = captureMail();
    const inv = await requestedInvitation();
    await consume(inv.event);
    const first = (await row(inv.id)).otp_hash;
    await consume({ ...inv.event, eventId: randomUUID() });
    expect(sent).toHaveLength(1);
    expect((await row(inv.id)).otp_hash).toBe(first);
  });

  it('lỗi SMTP tạm thời: ném lại để outbox thử lại, mã chưa được ghi', async () => {
    captureMail({ code: 'ECONNECTION' });
    const inv = await requestedInvitation();
    await expect(consume(inv.event)).rejects.toMatchObject({ name: 'MailError', kind: 'transient' });
    expect((await row(inv.id)).otp_hash).toBeNull();
  });

  it('lỗi SMTP vĩnh viễn: không ném, mail_send_total permanent tăng', async () => {
    captureMail({ responseCode: 550 });
    const inv = await requestedInvitation();
    const before = await counter('mail_send_total', { template: 'invitation_otp', result: 'permanent' });
    await expect(consume(inv.event)).resolves.toBeUndefined();
    expect(await counter('mail_send_total', { template: 'invitation_otp', result: 'permanent' })).toBe(before + 1);
  });

  it('Review Focus 5: chưa đặt SMTP_URL: không ném, ghi permanent', async () => {
    setMailTransport(null);
    const inv = await requestedInvitation();
    const before = await counter('mail_send_total', { template: 'invitation_otp', result: 'permanent' });
    await expect(consume(inv.event)).resolves.toBeUndefined();
    expect(await counter('mail_send_total', { template: 'invitation_otp', result: 'permanent' })).toBe(before + 1);
  });

  it('requestedAt ghi xong đọc lại vẫn bằng nhau tới mili giây', async () => {
    const inv = await requestedInvitation();
    const stored = await row(inv.id);
    expect(stored.otp_requested_at.toISOString()).toBe(inv.event.payload.requestedAt);
    const micros = await db.query<{ micros: number }>(
      'select (extract(microseconds from otp_requested_at)::int % 1000) as micros from staff.invitations where id = $1',
      [inv.id],
    );
    expect(micros.rows[0]!.micros).toBe(0);
  });
});
