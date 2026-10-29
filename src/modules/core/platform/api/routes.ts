import { type RequestHandler, Router } from 'express';
import { getAuth, readAccessClaims } from '../../../../shared/auth/authenticate.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { listCompanies, listPlatformAuditLogs, platformOverview, setCompanyLock } from '../service/admin.ts';
import type { PlatformContext } from '../service/context.ts';
import { listCompanyModules, setCompanyModule } from '../service/modules.ts';
import {
  CompanyListQuery,
  CompanyParams,
  LockCompanyBody,
  ModuleParams,
  PlatformAuditQuery,
  SetModuleBody,
  UnlockCompanyBody,
} from './schemas.ts';

/** Route của module `platform`, gắn tại /api/v1/platform (Documents/21 M1, V18). */
export function platformRouter(ctx: PlatformContext): Router {
  const router = Router();
  const manageModules = ctx.authorize('platform.module.manage');

  // Quản trị nền tảng: cờ `core.accounts.is_platform_admin` đọc từ DB mỗi request, gỡ cờ là chặn ngay (#152 A1).
  const platformAdmin: RequestHandler = async (req, res, next) => {
    const claims = await readAccessClaims(req);
    if (!(await ctx.isPlatformAdmin!(claims.accountId))) {
      throw new AppError(403, 'forbidden', 'Chỉ quản trị nền tảng được thực hiện');
    }
    res.locals.auth = claims;
    next();
  };

  router.get('/modules', manageModules, async (_req, res) => {
    res.json(await listCompanyModules(ctx, getAuth(res).companyId!));
  });

  router.put('/modules/:code', manageModules, validate({ params: ModuleParams, body: SetModuleBody }), async (_req, res) => {
    const { accountId, companyId } = getAuth(res);
    const { code } = validated<typeof ModuleParams>(res, 'params');
    res.json(await setCompanyModule(ctx, { accountId, companyId: companyId! }, code, validated<typeof SetModuleBody>(res, 'body')));
  });

  router.get('/overview', platformAdmin, async (_req, res) => {
    res.json(await platformOverview());
  });

  router.get('/companies', platformAdmin, validate({ query: CompanyListQuery }), async (_req, res) => {
    res.json(await listCompanies(validated<typeof CompanyListQuery>(res, 'query')));
  });

  router.post('/companies/:id/lock', platformAdmin, validate({ params: CompanyParams, body: LockCompanyBody }), async (_req, res) => {
    const { id } = validated<typeof CompanyParams>(res, 'params');
    const { reason, version } = validated<typeof LockCompanyBody>(res, 'body');
    res.json(await setCompanyLock(getAuth(res).accountId, id, { version, reason }));
  });

  router.post('/companies/:id/unlock', platformAdmin, validate({ params: CompanyParams, body: UnlockCompanyBody }), async (_req, res) => {
    const { id } = validated<typeof CompanyParams>(res, 'params');
    const { version } = validated<typeof UnlockCompanyBody>(res, 'body');
    res.json(await setCompanyLock(getAuth(res).accountId, id, { version, reason: null }));
  });

  router.get('/audit-logs', platformAdmin, validate({ query: PlatformAuditQuery }), async (_req, res) => {
    res.json(await listPlatformAuditLogs(validated<typeof PlatformAuditQuery>(res, 'query')));
  });

  return router;
}
