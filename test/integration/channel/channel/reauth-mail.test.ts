import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, EventPayload } from '#src/modules/core/platform/index.ts';
import { handleReauthMail, queueReauthMailsOnce } from '#src/modules/channel/channel/service/reauth-mail.ts';
import type { TokenSet } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { markNeedsReauth, refreshShopTokenLocked, tokenColumns } from '#src/modules/channel/channel/service/shop-tokens.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { type MailTransport, setMailTransport } from '#src/shared/mail/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { suspendMembership } from '../../helpers/state.ts';
import { fakeAdapter } from './helpers.ts';

type ReauthEvent = EventEnvelope<'channel.shop_reauth_mail', EventPayload<'channel.shop_reauth_mail'>>;
type SentMail = Parameters<MailTransport['sendMail']>[0];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = testPool();
const ACCESS = 'ACCESS-BI-MAT-312';
const REFRESH = 'REFRESH-BI-MAT-312';

afterEach(() => setMailTransport(null));
afterAll(() => resetAdapters());

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
async function activeShop(companyId: string, left: number | null, platform = 'lazada'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
     values ($1, $3, $2, 'Shop Áo Thun', 'active', now()) returning id`,
    [companyId, `seller-${randomUUID()}`, platform],
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
    // Thư trước hạn cùng mốc, hạn lệch dưới 1 giờ: EXCLUDE chặn (23P01); cách từ 1 giờ thì là mốc mới.
    const early = (deadline: string) =>
      db.query(
        "insert into channel.shop_reauth_mails (company_id, shop_id, stage, deadline) values ($1, $2, 'expiring_1d', $3::timestamptz)",
        [companyId, shopId, deadline],
      );
    await early('2026-11-20T00:00:00.000Z');
    await expect(early('2026-11-20T00:00:00.500Z')).rejects.toMatchObject({ code: '23P01' });
    await expect(early('2026-11-19T23:00:30Z')).rejects.toMatchObject({ code: '23P01' });
    await early('2026-11-20T01:00:00Z');
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
    // Lỗi vĩnh viễn (thư khác): không ném, ghi `failed`, việc nền không xếp lại.
    const other = await activeShop(companyId, 10 * DAY);
    await lose(companyId, other);
    const otherMail = (await mails(other))[0]!;
    captureMail({ responseCode: 550 });
    await expect(consume(other, otherMail.id)).resolves.toBeUndefined();
    const { rows } = await db.query<{ outcome: string }>('select outcome from channel.shop_reauth_mails where id = $1', [otherMail.id]);
    expect(rows[0]!.outcome).toBe('failed');
    await queueReauthMailsOnce(new Date(otherMail.deadline.getTime() + 30 * 60_000));
    expect(await events(other)).toHaveLength(1);
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
  it('hạn tính lại lệch vài trăm mili giây sau mỗi lần làm mới token: mỗi mốc vẫn chỉ một thư (CSDL chặn mốc trùng)', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    const now = new Date();
    const drift = (ms: number) =>
      db.query('update channel.shops set refresh_expires_at = refresh_expires_at + make_interval(secs => $2::float / 1000) where id = $1', [
        shopId,
        ms,
      ]);
    await queueReauthMailsOnce(now);
    for (const ms of [500, -300, 2_000, 40]) {
      await drift(ms);
      await queueReauthMailsOnce(now);
    }
    expect((await mails(shopId)).map((m) => m.stage)).toEqual(['expiring_3d']);
    const late = new Date(now.getTime() + DAY + HOUR);
    await queueReauthMailsOnce(late);
    for (const ms of [700, -1_200]) {
      await drift(ms);
      await queueReauthMailsOnce(late);
    }
    expect((await mails(shopId)).map((m) => m.stage)).toEqual(['expiring_3d', 'expiring_1d']);
    expect(await events(shopId)).toHaveLength(2);
  });

  it('hạn được gia hạn thật (xa hơn ngưỡng lệch): tính lại từ đầu theo hạn mới', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    await queueReauthMailsOnce(new Date());
    await db.query("update channel.shops set refresh_expires_at = refresh_expires_at + interval '20 hours' where id = $1", [shopId]);
    await queueReauthMailsOnce(new Date());
    expect((await mails(shopId)).map((m) => m.stage)).toEqual(['expiring_3d', 'expiring_3d']);
  });

  it('thư đã xếp, rồi token làm mới làm hạn lệch nhỏ trước khi gửi: vẫn gửi, không bỏ nhầm là thư cũ', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    await queueReauthMailsOnce(new Date());
    await db.query("update channel.shops set refresh_expires_at = refresh_expires_at + interval '1.5 seconds' where id = $1", [shopId]);
    const sent = captureMail();
    await consume(shopId, (await mails(shopId))[0]!.id);
    expect(sent).toHaveLength(1);
  });

  it('sàn giữ hạn refresh cố định (Lazada): làm mới token nhiều lần không đổi hạn đã lưu, mỗi mốc một thư', async () => {
    let n = 0;
    registerAdapter(
      'mock',
      fakeAdapter({
        refreshKeepsAuthDeadline: true,
        async refreshToken(): Promise<TokenSet> {
          n++;
          // Như Lazada: `refresh_expires_in` là số giây còn lại, `Date.now() + giây` lệch theo độ trễ mỗi lần.
          return {
            accessToken: `acc-${n}`,
            refreshToken: REFRESH,
            accessExpiresAt: new Date(Date.now() + 7 * DAY),
            refreshExpiresAt: new Date(Date.now() + 2 * DAY + n * 137),
          };
        },
      }),
    );
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY, 'mock');
    const stored = async () =>
      (await db.query<{ r: Date }>('select refresh_expires_at as r from channel.shops where id = $1', [shopId])).rows[0]!.r.getTime();
    const before = await stored();
    await queueReauthMailsOnce(new Date());
    for (let i = 0; i < 3; i++) {
      await db.query('update channel.shops set access_expires_at = now() where id = $1', [shopId]);
      expect(await refreshShopTokenLocked(companyId, shopId)).toBe('refreshed');
      await queueReauthMailsOnce(new Date());
    }
    expect(await stored()).toBe(before);
    expect(n).toBe(3);
    expect((await mails(shopId)).map((m) => m.stage)).toEqual(['expiring_3d']);
  });

  it('SMTP lỗi tạm kéo dài quá các lần thử của outbox: sau khi SMTP hồi, việc nền xếp lại và thư tới đúng một lần', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    const now = new Date();
    await queueReauthMailsOnce(now);
    const mailId = (await mails(shopId))[0]!.id;
    // Outbox thử 1 s, 5 s, 30 s rồi bỏ vào DLQ: sự kiện gốc không còn ai giao.
    captureMail({ code: 'ECONNECTION' });
    for (let i = 0; i < 3; i++) await expect(consume(shopId, mailId)).rejects.toMatchObject({ kind: 'transient' });
    // Chưa quá ngưỡng chờ: chưa xếp lại.
    await queueReauthMailsOnce(new Date(now.getTime() + 5 * 60_000));
    expect(await events(shopId)).toHaveLength(1);
    // Xếp lại lần thứ nhất mà SMTP vẫn hỏng.
    await queueReauthMailsOnce(new Date(now.getTime() + 11 * 60_000));
    expect(await events(shopId)).toHaveLength(2);
    await expect(consume(shopId, mailId)).rejects.toMatchObject({ kind: 'transient' });
    // SMTP hồi: lần xếp lại sau gửi được.
    await queueReauthMailsOnce(new Date(now.getTime() + 30 * 60_000));
    expect(await events(shopId)).toHaveLength(3);
    const sent = captureMail();
    await consume(shopId, mailId);
    expect(sent).toHaveLength(1);
    // Đã gửi: không xếp lại nữa, sự kiện cũ giao muộn cũng không gửi lần hai.
    await queueReauthMailsOnce(new Date(now.getTime() + 60 * 60_000));
    expect(await events(shopId)).toHaveLength(3);
    await consume(shopId, mailId);
    expect(sent).toHaveLength(1);
  });

  it('xếp lại có giới hạn số lần; thư đã bị mốc sau thay thì không xếp lại', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    const now = new Date();
    await queueReauthMailsOnce(now);
    for (let i = 1; i <= 20; i++) await queueReauthMailsOnce(new Date(now.getTime() + i * 15 * 60_000));
    const [row] = (
      await db.query<{ attempts: number; outcome: string | null }>(
        "select attempts, outcome from channel.shop_reauth_mails where shop_id = $1 and stage = 'expiring_3d'",
        [shopId],
      )
    ).rows;
    expect(row).toMatchObject({ attempts: 8, outcome: 'failed' });
    expect(await events(shopId)).toHaveLength(8);
    // Thư `lost` nhịp 0 chưa gửi mà đã sang nhịp 1: nhịp 0 thành cũ, không xếp lại.
    const lostShop = await activeShop(companyId, 10 * DAY);
    await lose(companyId, lostShop);
    const lostAt = (await mails(lostShop))[0]!.deadline.getTime();
    await queueReauthMailsOnce(new Date(lostAt + 6 * HOUR + 60_000));
    const rows = (
      await db.query<{ seq: number; outcome: string | null; attempts: number }>(
        'select seq, outcome, attempts from channel.shop_reauth_mails where shop_id = $1 order by seq',
        [lostShop],
      )
    ).rows;
    expect(rows).toEqual([
      { seq: 0, outcome: 'stale', attempts: 1 },
      { seq: 1, outcome: null, attempts: 1 },
    ]);
  });

  it('commerio_app chỉ được cập nhật cột kết quả gửi, không sửa mốc, không xoá dòng', async () => {
    const { companyId } = await createCompany();
    const shopId = await activeShop(companyId, 2 * DAY);
    await queueReauthMailsOnce(new Date());
    const mailId = (await mails(shopId))[0]!.id;
    await asCompany(companyId, async (c) => {
      await c.query("update channel.shop_reauth_mails set outcome = 'sent', finished_at = now() where id = $1", [mailId]);
    });
    for (const sql of [
      "update channel.shop_reauth_mails set stage = 'expiring_1d' where id = $1",
      'update channel.shop_reauth_mails set deadline = now() where id = $1',
      'delete from channel.shop_reauth_mails where id = $1',
    ]) {
      await expect(asCompany(companyId, (c) => c.query(sql, [mailId]))).rejects.toMatchObject({ code: '42501' });
    }
  });
});
