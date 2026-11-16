import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import {
  handleInvitationDecided,
  handleInvitationSubmitted,
} from '#src/modules/core/staff/service/decision-consumer.ts';
import { setMailTransport } from '#src/shared/mail/index.ts';
import { addMember, createCompany, uniqueEmail } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { PASSWORD, testApp } from '../../helpers/http.ts';
import { accountIdOf, captureMail, claimLink, deliverLatest, joinApi, newLink, pendingInvitation } from './helpers.ts';

// Thư báo người duyệt khi có yêu cầu nộp, thư báo kết quả duyệt (Documents/21 mục 3.1; Documents/27 US-CT-06 AC 9,
// US-CT-07 AC 6). Worker gửi qua outbox: test đọc sự kiện trong outbox rồi gọi consumer như worker.
const app = testApp();
const db = testPool();
const join = joinApi(app);
const SALE = BUILTIN_ROLES.sale.id;

afterEach(() => setMailTransport(null));

const decide = (token: string, id: string, action: 'approve' | 'reject', version: number) =>
  request(app)
    .post(`/api/v1/identity/invitations/${id}/${action}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version });
const versionOf = async (id: string) =>
  (await db.query<{ version: number }>('select version from core.invitations where id = $1', [id])).rows[0]!.version;
const deliverSubmitted = (id: string) => deliverLatest('staff.invitation_submitted', id, handleInvitationSubmitted);
const deliverDecided = (id: string) => deliverLatest('staff.invitation_decided', id, handleInvitationDecided);

let company: Awaited<ReturnType<typeof createCompany>>;
let ceoId: string;
let admin: Awaited<ReturnType<typeof addMember>>;
let sale: Awaited<ReturnType<typeof addMember>>;

beforeAll(async () => {
  company = await createCompany();
  ceoId = await accountIdOf(company.ceo.email);
  admin = await addMember(company.companyId, 'admin');
  sale = await addMember(company.companyId, 'sale');
});

/** Đi trọn luồng tham gia qua API tới `pending`; trả id lời mời và email. */
async function submitThroughLink(fullName: string): Promise<{ id: string; email: string }> {
  const link = await newLink(app, company.ceo.token, [SALE]);
  const email = uniqueEmail('nop');
  const { registrationToken } = await claimLink(app, link.token, email, fullName);
  const res = await join.complete({ registrationToken, password: PASSWORD, confirmPassword: PASSWORD });
  expect(res.status).toBe(200);
  return { id: link.id, email };
}

describe('thư báo người duyệt (staff.invitation_submitted)', () => {
  it('US-CT-06 AC 9: nộp xong → một thư tới CEO và Admin (người có identity.account.manage), không tới Sale', async () => {
    const { id, email } = await submitThroughLink('Lê Thị Hoa');
    const sent = captureMail();
    expect(await deliverSubmitted(id)).toBe(true);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    const to = mail.to.split(', ').sort();
    expect(to).toEqual([company.ceo.email, admin.email].sort());
    expect(to).not.toContain(sale.email);
    expect(mail.subject).toContain('chờ duyệt');
    expect(mail.text).toContain('Lê Thị Hoa');
    expect(mail.text).toContain(email);
    expect(mail.text).toContain('Sale');
    expect(mail.text).toContain('https://commerio.test/admin/staff?tab=pending');
    expect(mail.html).toContain('href="https://commerio.test/admin/staff?tab=pending"');
  });

  it('họ tên có thẻ HTML thì bản HTML escape, không chèn được thẻ', async () => {
    const { id } = await submitThroughLink('Mai <b>Giả</b>');
    const sent = captureMail();
    await deliverSubmitted(id);
    expect(sent[0]!.html).toContain('Mai &lt;b&gt;Giả&lt;/b&gt;');
    expect(sent[0]!.html).not.toContain('<b>Giả</b>');
  });

  it('lời mời không còn pending lúc worker chạy (đã duyệt) → không gửi', async () => {
    const { id } = await submitThroughLink('Phạm Văn Tú');
    expect((await decide(company.ceo.token, id, 'reject', await versionOf(id))).status).toBe(200);
    const sent = captureMail();
    await deliverSubmitted(id);
    expect(sent).toHaveLength(0);
  });
});

describe('thư báo kết quả (staff.invitation_decided)', () => {
  it('US-CT-07 AC 6: duyệt email mới → thư tới người đăng ký, kèm link đăng nhập, nói dùng mật khẩu đã đặt', async () => {
    const { id, email } = await submitThroughLink('Đỗ Minh Anh');
    expect((await decide(company.ceo.token, id, 'approve', await versionOf(id))).status).toBe(200);
    const sent = captureMail();
    expect(await deliverDecided(id)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.subject).toContain('được duyệt');
    expect(sent[0]!.text).toContain('mật khẩu bạn đã đặt');
    expect(sent[0]!.text).toContain('https://commerio.test/login');
    expect(sent[0]!.html).toContain('href="https://commerio.test/login"');
  });

  it('duyệt tài khoản đã có → thư nói dùng mật khẩu hiện có', async () => {
    const other = await createCompany();
    const existingId = await accountIdOf(other.ceo.email);
    const inv = await pendingInvitation(company.companyId, {
      createdBy: ceoId,
      roleIds: [SALE],
      email: other.ceo.email,
      existingAccountId: existingId,
    });
    expect((await decide(company.ceo.token, inv.id, 'approve', inv.version)).status).toBe(200);
    const sent = captureMail();
    await deliverDecided(inv.id);
    expect(sent[0]!.to).toBe(other.ceo.email);
    expect(sent[0]!.text).toContain('mật khẩu hiện có');
  });

  it('từ chối → thư báo không được duyệt, không nêu ai từ chối', async () => {
    const inv = await pendingInvitation(company.companyId, { createdBy: ceoId, roleIds: [SALE] });
    expect((await decide(company.ceo.token, inv.id, 'reject', inv.version)).status).toBe(200);
    const sent = captureMail();
    await deliverDecided(inv.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(inv.email);
    expect(sent[0]!.subject).toContain('không được duyệt');
    expect(sent[0]!.text).not.toContain(company.ceo.email);
  });

  it('SMTP lỗi vĩnh viễn: duyệt vẫn 200, consumer không ném (không thử lại); lỗi tạm thì ném để outbox thử lại', async () => {
    captureMail({ responseCode: 550 });
    const inv = await pendingInvitation(company.companyId, { createdBy: ceoId, roleIds: [SALE] });
    expect((await decide(company.ceo.token, inv.id, 'approve', inv.version)).status).toBe(200);
    await expect(deliverDecided(inv.id)).resolves.toBe(true);

    captureMail({ code: 'ETIMEDOUT' });
    await expect(deliverDecided(inv.id)).rejects.toMatchObject({ name: 'MailError', kind: 'transient' });
  });

  it('duyệt rồi rollback (lỗi) thì không có sự kiện: lời mời của vai trò đã xoá', async () => {
    const inv = await pendingInvitation(company.companyId, { createdBy: ceoId, roleIds: [SALE] });
    await db.query("update core.invitations set role_ids = array['00000000-0000-4000-8000-0000000000ff']::uuid[] where id = $1", [
      inv.id,
    ]);
    expect((await decide(company.ceo.token, inv.id, 'approve', inv.version)).status).toBe(409);
    expect(await deliverDecided(inv.id)).toBe(false);
  });
});
