import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reservePlatformCall } from '#src/modules/channel/channel/repository/api-usage.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { withCompany } from '#src/shared/db/client.ts';

// Mỗi test một ngày riêng ở tương lai xa để không đụng bộ đếm của test khác hay của app.
const someDay = () => new Date(Date.UTC(2100 + randomInt(0, 800), randomInt(0, 12), randomInt(1, 28), 5));
const counted = async (at: Date) =>
  (
    await testPool().query<{ calls: number }>(
      `select calls from channel.api_usage where platform = 'lazada' and day = ($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date`,
      [at],
    )
  ).rows[0]?.calls;

// Bộ đếm hạn mức gọi sàn dùng chung giữa các tiến trình (#102 AC-7c, AC-7d).
describe('channel.api_usage', () => {
  it('nhiều lời xin cùng lúc qua nhiều kết nối: đúng bằng ngưỡng được phép, bộ đếm dừng ở ngưỡng', async () => {
    const at = someDay();
    const results = await Promise.all(Array.from({ length: 15 }, () => reservePlatformCall('lazada', 5, at)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await counted(at)).toBe(5);
  });

  it('sang ngày mới theo giờ Việt Nam thì tính lại từ đầu', async () => {
    const day = someDay();
    // 23:59 và 00:00 giờ VN của cùng một đêm.
    const lateNight = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 16, 59));
    const nextMorning = new Date(lateNight.getTime() + 60_000);
    expect(await reservePlatformCall('lazada', 1, lateNight)).toBe(true);
    expect(await reservePlatformCall('lazada', 1, lateNight)).toBe(false);
    expect(await reservePlatformCall('lazada', 1, nextMorning)).toBe(true);
  });

  it('gọi trong giao dịch của công ty: lượt ghi ngay, không mất khi giao dịch đó rollback', async () => {
    const { companyId } = await createCompany();
    const at = someDay();
    const rollback = new Error('rollback');
    const res = withCompany(companyId, async () => {
      expect(await reservePlatformCall('lazada', 3, at)).toBe(true);
      throw rollback;
    });
    await expect(res).rejects.toBe(rollback);
    expect(await counted(at)).toBe(1);
  });
});
