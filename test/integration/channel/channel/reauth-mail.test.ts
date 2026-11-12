import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, EventPayload } from '#src/modules/core/platform/index.ts';
import { handleReauthMail, queueReauthMailsOnce } from '#src/modules/channel/channel/service/reauth-mail.ts';
import { markNeedsReauth, tokenColumns } from '#src/modules/channel/channel/service/shop-tokens.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { type MailTransport, setMailTransport } from '#src/shared/mail/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { suspendMembership } from '../../helpers/state.ts';

type ReauthEvent = EventEnvelope<'channel.shop_reauth_mail', EventPayload<'channel.shop_reauth_mail'>>;
type SentMail = Parameters<MailTransport['sendMail']>[0];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = testPool();
const ACCESS = 'ACCESS-BI-MAT-312';
const REFRESH = 'REFRESH-BI-MAT-312';

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

/** Gian hàng Lazada `active` đã thiết lập, token thật đã mã hoá, hạn refresh sau `left` mili giây (null: token dán tay). */
async function activeShop(companyId: string, left: number | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
     values ($1, 'lazada', $2, 'Shop Áo Thun', 'active', now()) returning id`,
    [companyId, `seller-${randomUUID()}`],
  );
  const id = rows[0]!.id;
  const cols = tokenColumns(id, {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    accessExpiresAt: new Date(Date.now() + HOUR),
    refreshExpiresAt: left === null ? null : new Date(Date.now() + left),
  });
  await db.query(
    'update channel.shops set access_token_enc = $2, refresh_token_enc = $3, access_expires_at = $4, refresh_expires_at = $5 where id = $1',
    [id, cols.accessTokenEnc, cols.refreshTokenEnc, cols.accessExpiresAt, cols.refreshExpiresAt],
  );
  return id;
}

const mails = async (shopId: string) =>
  (
    await db.query<{ id: string; stage: string; seq: number; deadline: Date }>(
      'select id, stage, seq, deadline from channel.shop_reauth_mails where shop_id = $1 order by created_at, seq',
      [shopId],
    )
  ).rows;

const events = async (shopId: string) =>
  (
    await db.query<{ payload: { mailId: string; shopId: string }; company_id: string; event_id: string }>(
      "select payload, company_id, event_id from core.outbox_messages where type = 'channel.shop_reauth_mail' and key = $1",
      [shopId],
    )
  ).rows;

/** Sự kiện vừa phát cho thư `mailId`, chạy như consumer `shared`: trong withCompany của sự kiện. */
async function consume(shopId: string, mailId: string): Promise<void> {
  const row = (await events(shopId)).find((e) => e.payload.mailId === mailId)!;
  const event: ReauthEvent = {
    eventId: row.event_id,
    type: 'channel.shop_reauth_mail',
    companyId: row.company_id,
    aggregateId: shopId,
    occurredAt: new Date().toISOString(),
    payload: row.payload,
  };
  await withCompany(row.company_id, () => handleReauthMail(event));
}

const lose = (companyId: string, shopId: string) => withCompany(companyId, () => markNeedsReauth(shopId, 'Sàn từ chối token'));

// Thư báo CEO, Admin khi gian hàng sắp hết hoặc đã mất uỷ quyền (#312).
describe('thư báo mất uỷ quyền gian hàng', () => {
  it('việc nền chạy hai lần liền, hay hai lượt chạy trùng: mỗi mốc chỉ một dòng và một sự kiện (unique ở CSDL)', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    const now = new Date();
    await queueReauthMailsOnce(now);
    await queueReauthMailsOnce(now);
    await Promise.all([queueReauthMailsOnce(now), queueReauthMailsOnce(now)]);
    expect((await mails(shopId)).map((m) => m.stage)).toEqual(['expiring_3d']);
    expect(await events(shopId)).toHaveLength(1);
    // Còn dưới 1 ngày: thêm đúng một thư 2.
    await queueReauthMailsOnce(new Date(now.getTime() + DAY + HOUR));
    await queueReauthMailsOnce(new Date(now.getTime() + DAY + 2 * HOUR));
    expect((await mails(shopId)).map((m) => m.stage)).toEqual(['expiring_3d', 'expiring_1d']);
  });

  it('CSDL chặn ghi trùng mốc kể cả khi không qua service', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    const insert = () =>
      db.query(
        "insert into channel.shop_reauth_mails (company_id, shop_id, stage, deadline, seq) values ($1, $2, 'lost', '2026-11-12T00:00:00Z', 1)",
        [companyId, shopId],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await expect(
      db.query(
        "insert into channel.shop_reauth_mails (company_id, shop_id, stage, deadline, seq) values ($1, $2, 'expiring_3d', now(), 1)",
        [companyId, shopId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('token dán tay không có hạn: không có thư trước hạn', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, null);
    await queueReauthMailsOnce(new Date());
    expect(await mails(shopId)).toEqual([]);
  });

  it('chuyển sang needs_reauth: thư đầu xếp ngay; 5 giờ 59 phút sau chưa có thư, 6 giờ sau có thư tiếp; nối lại thì dừng', async () => {
    const { companyId } = await createCompany();
    // Hạn còn 10 ngày: sàn thu hồi quyền trước hạn thì vào thẳng nhịp 6 giờ.
    const shopId = await activeShop(companyId, 10 * DAY);
    await lose(companyId, shopId);
    const [first] = await mails(shopId);
    expect(first).toMatchObject({ stage: 'lost', seq: 0 });
    expect(await events(shopId)).toHaveLength(1);
    const lostAt = first!.deadline.getTime();
    await queueReauthMailsOnce(new Date(lostAt + 6 * HOUR - 60_000));
    expect(await mails(shopId)).toHaveLength(1);
    await queueReauthMailsOnce(new Date(lostAt + 6 * HOUR));
    expect((await mails(shopId)).map((m) => m.seq)).toEqual([0, 1]);
    // Nối lại (về active, hạn mới xa): không còn thư.
    await db.query("update channel.shops set status = 'active', refresh_expires_at = now() + interval '30 days' where id = $1", [shopId]);
    await queueReauthMailsOnce(new Date(lostAt + 12 * HOUR));
    expect(await mails(shopId)).toHaveLength(2);
  });

  it('ngắt gian hàng: dừng thư', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 10 * DAY);
    await lose(companyId, shopId);
    await db.query("update channel.shops set status = 'disconnected', disconnected_at = now() where id = $1", [shopId]);
    await queueReauthMailsOnce(new Date(Date.now() + 7 * HOUR));
    expect(await mails(shopId)).toHaveLength(1);
  });

  it('người nhận là CEO, Admin đang hoạt động của đúng công ty; thư không chứa token', async () => {
    const { companyId, ceo } = await createCompany();
    const admin = await addMember(companyId, 'admin');
    const sale = await addMember(companyId, 'sale');
    const lockedAdmin = await addMember(companyId, 'admin');
    await suspendMembership(lockedAdmin.membershipId);
    const platformAdmin = await addMember(companyId, 'admin');
    await db.query('update core.accounts set is_platform_admin = true where id = $1', [platformAdmin.accountId]);
    const other = await createCompany();
    const otherAdmin = await addMember(other.companyId, 'admin');
    const shopId = await activeShop(companyId, 10 * DAY);
    await lose(companyId, shopId);
    const sent = captureMail();
    await consume(shopId, (await mails(shopId))[0]!.id);
    expect(sent).toHaveLength(1);
    const to = String(sent[0]!.to).split(', ').sort();
    expect(to).toEqual([ceo.email, admin.email].sort());
    for (const email of [sale.email, lockedAdmin.email, platformAdmin.email, other.ceo.email, otherAdmin.email]) {
      expect(to).not.toContain(email);
    }
    const body = `${sent[0]!.subject}\n${sent[0]!.text}`;
    expect(body).toContain('Shop Áo Thun');
    expect(body).toContain(`https://commerio.test/channel/shops/${shopId}`);
    for (const secret of [ACCESS, REFRESH, 'token', 'Token']) expect(body).not.toContain(secret);
    expect(body).not.toMatch(/\d[\d.,]*\s*(₫|đ|VND)/);
  });

  it('SMTP lỗi tạm thời thì ném để outbox thử lại, lần sau gửi được; lỗi vĩnh viễn thì không ném', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 10 * DAY);
    await lose(companyId, shopId);
    const mailId = (await mails(shopId))[0]!.id;
    captureMail({ code: 'ETIMEDOUT' });
    await expect(consume(shopId, mailId)).rejects.toMatchObject({ name: 'MailError', kind: 'transient' });
    const sent = captureMail();
    await consume(shopId, mailId);
    expect(sent).toHaveLength(1);
    captureMail({ responseCode: 550 });
    await expect(consume(shopId, mailId)).resolves.toBeUndefined();
  });

  it('gian hàng đã nối lại trước khi thư tới lượt: bỏ thư', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 10 * DAY);
    await lose(companyId, shopId);
    await db.query("update channel.shops set status = 'active' where id = $1", [shopId]);
    const sent = captureMail();
    await consume(shopId, (await mails(shopId))[0]!.id);
    expect(sent).toEqual([]);
  });
});
