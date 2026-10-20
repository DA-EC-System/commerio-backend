import { type Response, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { type Caller, changeRoles, listStaff, setLocked } from '../service/members.ts';
import { ChangeRolesBody, StaffListQuery, StaffParams, VersionBody } from './schemas.ts';

/**
 * Route của module `staff`, gắn dưới /api/v1/identity (`identity` gắn sau router của `access`), như
 * /identity/roles: đường dẫn nhân viên đã chốt ở Documents/21 I1.
 */
export function staffRouter(ctx: ModuleContext): Router {
  const router = Router();
  const view = ctx.authorize('identity.account.view');
  const manage = ctx.authorize('identity.account.manage');

  // Quyền thô hiện tại do `authorize` vừa đọc từ DB, gồm cả quyền của phân hệ đang tắt (Documents/21 D1).
  function caller(res: Response): Caller {
    const { accountId, companyId } = getAuth(res);
    return { accountId, companyId: companyId!, permissions: getAccess(res).permissions };
  }

  router.get('/staff', view, validate({ query: StaffListQuery }), async (_req, res) => {
    res.json(await listStaff(getAuth(res).companyId!, validated<typeof StaffListQuery>(res, 'query')));
  });

  router.put(
    '/staff/:accountId/roles',
    manage,
    validate({ params: StaffParams, body: ChangeRolesBody }),
    async (_req, res) => {
      const { accountId } = validated<typeof StaffParams>(res, 'params');
      res.json(await changeRoles(caller(res), accountId, validated<typeof ChangeRolesBody>(res, 'body')));
    },
  );

  for (const [action, locked] of [
    ['lock', true],
    ['unlock', false],
  ] as const) {
    router.post(`/staff/:accountId/${action}`, manage, validate({ params: StaffParams, body: VersionBody }), async (_req, res) => {
      const { accountId } = validated<typeof StaffParams>(res, 'params');
      res.json(await setLocked(caller(res), accountId, locked, validated<typeof VersionBody>(res, 'body').version));
    });
  }

  return router;
}
