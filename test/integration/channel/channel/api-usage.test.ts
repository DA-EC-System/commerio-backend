import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reservePlatformCall, usedCalls } from '#src/modules/channel/channel/repository/api-usage.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { withCompany } from '#src/shared/db/client.ts';

// Mỗi test một ngày riêng ở tương lai xa để không đụng bộ đếm của test khác hay của app.
const someDay = () => new Date(Date.UTC(2100 + randomInt(0, 800), randomInt(0, 12), randomInt(1, 28), 5));
const counted = async (at: Date) =>
  (
    await testPool().query<{ calls: number }>(
      `select calls from channel.api_usage
        where platform = 'lazada' and company_id is null and day = ($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date`,
      [at],
    )
  ).rows[0]?.calls;

/** Xin `n` lượt liền, trả kết quả từng lượt. */
async function reserveTimes(n: number, ...args: Parameters<typeof reservePlatformCall>) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await reservePlatformCall(...args));
  return out;
}

// Bộ đếm hạn mức gọi sàn dùng chung giữa các tiến trình (#102 AC-7c, AC-7d).
describe('channel.api_usage: trần chung của app', () => {
  it('nhiều lời xin cùng lúc qua nhiều kết nối: đúng bằng ngưỡng được phép, bộ đếm dừng ở ngưỡng', async () => {
    const at = someDay();
    const results = await Promise.all(Array.from({ length: 15 }, () => reservePlatformCall('lazada', 5, { at })));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === 'daily_call_limit')).toHaveLength(10);
    expect(await counted(at)).toBe(5);
  });

  it('sang ngày mới theo giờ Việt Nam thì tính lại từ đầu', async () => {
    const day = someDay();
    // 23:59 và 00:00 giờ VN của cùng một đêm.
    const lateNight = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 16, 59));
    const nextMorning = new Date(lateNight.getTime() + 60_000);
    expect(await reservePlatformCall('lazada', 1, { at: lateNight })).toBe('ok');
    expect(await reservePlatformCall('lazada', 1, { at: lateNight })).toBe('daily_call_limit');
    expect(await reservePlatformCall('lazada', 1, { at: nextMorning })).toBe('ok');
  });

  it('gọi trong giao dịch của công ty: lượt ghi ngay, không mất khi giao dịch đó rollback', async () => {
    const { companyId } = await createCompany();
    const at = someDay();
    const rollback = new Error('rollback');
    const res = withCompany(companyId, async () => {
      expect(await reservePlatformCall('lazada', 3, { companyId, companyMin: 3, at })).toBe('ok');
      throw rollback;
    });
    await expect(res).rejects.toBe(rollback);
    expect(await counted(at)).toBe(1);
    expect(await usedCalls('lazada', companyId, at)).toBe(1);
  });
});

// Phần của công ty (#215, Documents/21 §18.6.8). Công ty test không có gian hàng active nên phần = mức tối thiểu.
describe('channel.api_usage: phần của công ty', () => {
  it('một công ty dùng hết phần mình thì công ty kia vẫn gọi được', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const at = someDay();
    const opts = { companyMin: 10, background: true, at };
    const usedA = await reserveTimes(12, 'lazada', 1000, { ...opts, companyId: a.companyId });
    expect(usedA.slice(0, 10)).toEqual(Array(10).fill('ok'));
    expect(usedA.slice(10)).toEqual(['company_call_limit', 'company_call_limit']);
    expect(await reservePlatformCall('lazada', 1000, { ...opts, companyId: b.companyId })).toBe('ok');
    // Lượt bị chặn theo phần công ty không tính vào trần chung.
    expect(await counted(at)).toBe(11);
    expect(await usedCalls('lazada', a.companyId, at)).toBe(10);
    expect(await usedCalls('lazada', b.companyId, at)).toBe(1);
  });

  it('trần chung vẫn chặn khi tổng chạm ngưỡng, dù công ty còn phần', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const at = someDay();
    const opts = { companyMin: 10, background: true, at };
    expect(await reserveTimes(6, 'lazada', 8, { ...opts, companyId: a.companyId })).toEqual(Array(6).fill('ok'));
    expect(await reserveTimes(3, 'lazada', 8, { ...opts, companyId: b.companyId })).toEqual(['ok', 'ok', 'daily_call_limit']);
    expect(await reservePlatformCall('lazada', 8, { ...opts, companyId: a.companyId })).toBe('daily_call_limit');
    expect(await counted(at)).toBe(8);
  });

  it('bấm tay dừng ở 90% phần của công ty; việc nền chạy tiếp tới 100%', async () => {
    const { companyId } = await createCompany();
    const at = someDay();
    const base = { companyId, companyMin: 10, at };
    expect(await reserveTimes(10, 'lazada', 1000, { ...base, background: false })).toEqual([...Array(9).fill('ok'), 'company_call_limit']);
    expect(await reserveTimes(2, 'lazada', 1000, { ...base, background: true })).toEqual(['ok', 'company_call_limit']);
    expect(await usedCalls('lazada', companyId, at)).toBe(10);
  });

  it('đếm riêng theo sàn: hết phần Lazada không chặn TikTok', async () => {
    const { companyId } = await createCompany();
    const at = someDay();
    const opts = { companyId, companyMin: 2, background: true, at };
    await reserveTimes(2, 'lazada', 1000, opts);
    expect(await reservePlatformCall('lazada', 1000, opts)).toBe('company_call_limit');
    expect(await reservePlatformCall('tiktok', 1000, opts)).toBe('ok');
  });

  it('nhiều lời xin cùng lúc của một công ty: đúng bằng phần, trần chung chỉ tính lượt được nhận', async () => {
    const { companyId } = await createCompany();
    const at = someDay();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reservePlatformCall('lazada', 1000, { companyId, companyMin: 5, background: true, at })),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(await usedCalls('lazada', companyId, at)).toBe(5);
    expect(await counted(at)).toBe(5);
  });

  // Số gian hàng active của sàn do mọi file test cùng góp nên không biết trước tổng: công thức đúng từng con số kiểm ở
  // `test/unit/modules/channel/channel/domain/call-quota.test.ts`; ở đây chỉ kiểm câu đếm gian hàng có tác dụng.
  it('phần theo tỉ lệ gian hàng active: công ty có gian hàng active được hơn mức tối thiểu', async () => {
    const { companyId } = await createCompany();
    const at = someDay();
    await testPool().query(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at)
       values ($1, 'shopee', $2, 'Shop thử', 'active', now())`,
      [companyId, `quota-${randomInt(0, 1e9)}`],
    );
    // Dưới 100 gian hàng active trên sàn thì phần >= 10 > mức tối thiểu 1.
    const results = await reserveTimes(10, 'shopee', 1000, { companyId, companyMin: 1, background: true, at });
    expect(results).toEqual(Array(10).fill('ok'));
    const other = await createCompany();
    const otherResults = await reserveTimes(2, 'shopee', 1000, { companyId: other.companyId, companyMin: 1, background: true, at });
    expect(otherResults).toEqual(['ok', 'company_call_limit']);
  });
});
