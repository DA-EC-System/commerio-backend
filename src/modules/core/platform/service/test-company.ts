// Xoá công ty thử của e2e (Documents/21 mục 2.2, Thành chốt 22/11/2026). Ba điều kiện chặn, kiểm lại
// trong giao dịch sau khi khoá dòng công ty:
//   (a) server bật đăng ký thử (`REGISTRATION_TEST_EMAIL_DOMAIN`, chỉ staging/test; production không có) — không thì 404;
//   (b) mọi thành viên (cả đã khoá) và lời mời đang chờ có email đúng miền thử, không ai là quản trị nền tảng — 403;
//   (c) người gọi là CEO đang hoạt động của công ty đó (route) — 403.
// Việc nền mỗi đêm xoá công ty thoả (a), (b) tạo quá 6 giờ (test chết giữa chừng không gọi được route).
import { z } from 'zod';
import { env } from '../../../../shared/config/env.ts';
import { inTransaction } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import {
  companyAccountIds,
  companyTablesChildFirst,
  isActiveCeo,
  lockCompany,
  purgeCompanyRows,
  purgeOrphanTestAccounts,
  staleTestCompanyIds,
  testCompanyFacts,
  type TestCompanyFacts,
} from '../repository/test-company.ts';
import { defineQueue, schedulePlatform, workQueue } from './jobs/queues.ts';

/** Công ty thử sống quá chừng này thì việc nền xoá */
export const TEST_COMPANY_MAX_AGE_MS = 6 * 3_600_000;
const CLEANUP_CRON = '40 3 * * *';

export const testCompanyCleanupQueue = defineQueue('platform.test_company_cleanup', z.object({}), {
  policy: 'stately',
  attempts: 2,
  retryDelaySeconds: 600,
});

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy');
const notTestCompany = () =>
  new AppError(403, 'not_test_company', 'Chỉ xoá được công ty thử: mọi thành viên và lời mời đang chờ phải dùng email của miền thử');

/** Miền thử đang bật; `null` là server không chạy chế độ đăng ký thử (production) thì route coi như không tồn tại. */
const testDomain = (): string | null => env.REGISTRATION_TEST_EMAIL_DOMAIN ?? null;

/** Luật (b), thuần: công ty có ít nhất một thành viên, ai cũng thuộc miền thử, không ai là quản trị nền tảng. */
export function isTestCompany(f: TestCompanyFacts): boolean {
  return f.members > 0 && f.outsideMembers === 0 && f.platformAdmins === 0 && f.outsideInvitations === 0;
}

/** Xoá trong giao dịch đang mở, sau khi đã khoá và kiểm. Trả số dòng đã xoá theo bảng và số tài khoản đã xoá. */
async function purgeLocked(companyId: string, domain: string) {
  const accountIds = await companyAccountIds(companyId);
  const counts = await purgeCompanyRows(companyId, await companyTablesChildFirst());
  const accounts = await purgeOrphanTestAccounts(accountIds, domain);
  return { counts, accounts };
}

/**
 * `DELETE /platform/company` (Documents/21 mục 2.2): CEO xoá công ty thử đang chọn trong token. Thứ tự lỗi: 404 (không bật
 * đăng ký thử) → 403 `forbidden` (chưa chọn công ty, không còn công ty, không phải CEO) → 403 `not_test_company`. Việc nền
 * đang xếp của công ty không xoá: lúc chạy không thấy công ty nên tự bỏ.
 */
export async function deleteTestCompany(actor: { accountId: string; companyId: string | null }, ceoRoleId: string): Promise<void> {
  const domain = testDomain();
  if (!domain) throw notFound();
  const forbidden = () => new AppError(403, 'forbidden', 'Chỉ CEO của công ty được xoá công ty thử');
  const companyId = actor.companyId;
  if (!companyId) throw forbidden();
  const result = await inTransaction(async () => {
    const company = await lockCompany(companyId);
    if (!company || !(await isActiveCeo(companyId, actor.accountId, ceoRoleId))) throw forbidden();
    if (!isTestCompany(await testCompanyFacts(companyId, domain))) throw notTestCompany();
    return purgeLocked(companyId, domain);
  });
  logger.info({ companyId, actorId: actor.accountId, accounts: result.accounts, counts: result.counts }, 'đã xoá công ty thử');
}

/**
 * Việc nền: xoá công ty thử tạo trước `now - 6 giờ`. Mỗi công ty một giao dịch, kiểm lại (b) sau khi khoá: công ty vừa có
 * thành viên thật hay không còn thì bỏ qua. Một công ty lỗi không chặn các công ty sau. Trả id đã xoá.
 */
export async function runTestCompanyCleanup(now = new Date()): Promise<string[]> {
  const domain = testDomain();
  if (!domain) return [];
  const candidates = await inTransaction(() => staleTestCompanyIds(new Date(now.getTime() - TEST_COMPANY_MAX_AGE_MS), domain));
  const deleted: string[] = [];
  for (const companyId of candidates) {
    try {
      const done = await inTransaction(async () => {
        const company = await lockCompany(companyId);
        if (!company || now.getTime() - company.createdAt.getTime() < TEST_COMPANY_MAX_AGE_MS) return false;
        if (!isTestCompany(await testCompanyFacts(companyId, domain))) return false;
        await purgeLocked(companyId, domain);
        return true;
      });
      if (done) deleted.push(companyId);
    } catch (err) {
      logger.error({ companyId, reason: (err as Error).message }, 'không xoá được công ty thử quá hạn');
    }
  }
  if (deleted.length) logger.info({ deleted }, 'việc nền đã xoá công ty thử quá hạn');
  return deleted;
}

/** Đăng ký việc nền trong worker; server không bật đăng ký thử thì không lên lịch. */
export async function startTestCompanyCleanup(): Promise<void> {
  if (!testDomain()) return;
  await workQueue(testCompanyCleanupQueue, async () => {
    await runTestCompanyCleanup();
  });
  await schedulePlatform(testCompanyCleanupQueue, CLEANUP_CRON, {} as never, 'all');
}
