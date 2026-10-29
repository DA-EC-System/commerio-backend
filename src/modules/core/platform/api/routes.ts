import { Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { PlatformContext } from '../service/context.ts';
import { listCompanyModules, setCompanyModule } from '../service/modules.ts';
import { ModuleParams, SetModuleBody } from './schemas.ts';

/** Route của module `platform`, gắn tại /api/v1/platform (Documents/21 M1, V18). */
export function platformRouter(ctx: PlatformContext): Router {
  const router = Router();
  const manageModules = ctx.authorize('platform.module.manage');

  router.get('/modules', manageModules, async (_req, res) => {
    res.json(await listCompanyModules(ctx, getAuth(res).companyId!));
  });

  router.put('/modules/:code', manageModules, validate({ params: ModuleParams, body: SetModuleBody }), async (_req, res) => {
    const { accountId, companyId } = getAuth(res);
    const { code } = validated<typeof ModuleParams>(res, 'params');
    res.json(await setCompanyModule(ctx, { accountId, companyId: companyId! }, code, validated<typeof SetModuleBody>(res, 'body')));
  });

  return router;
}
