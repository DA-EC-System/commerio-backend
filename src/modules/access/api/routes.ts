import { type Response, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { anyOf, getAccess } from '../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { type Caller, createRole, deleteRole, listPermissions, listRoles, updateRole } from '../service/roles.ts';
import { DeleteRoleQuery, RoleBody, RoleParams, UpdateRoleBody } from './schemas.ts';

/** Route của module `access` (vai trò, quyền), gắn dưới /api/v1/identity (Documents/21 mục 3). */
export function accessRouter(ctx: ModuleContext): Router {
  const router = Router();
  const manage = ctx.authorize('identity.role.manage');
  const roleView = ctx.authorize('identity.role.view');
  const accountView = ctx.authorize('identity.account.view');

  // Màn nhân viên cũng cần danh sách vai trò để mời (mock FE): nhận identity.role.view hoặc identity.account.view.
  const viewRoles = anyOf(roleView, accountView);

  // Quyền thô hiện tại do `authorize` vừa đọc từ DB, gồm cả quyền của phân hệ đang tắt (Documents/21 D1).
  function caller(res: Response): Caller {
    const { accountId, companyId } = getAuth(res);
    const access = getAccess(res);
    return { accountId, companyId: companyId!, permissions: access.permissions, enabledModules: access.enabledModules };
  }

  router.get('/permissions', roleView, async (_req, res) => {
    res.json(await listPermissions(getAuth(res).companyId!));
  });

  router.get('/roles', viewRoles, async (_req, res) => {
    res.json(await listRoles(getAuth(res).companyId!));
  });

  router.post('/roles', manage, validate({ body: RoleBody }), async (_req, res) => {
    res.status(201).json(await createRole(caller(res), validated<typeof RoleBody>(res, 'body')));
  });

  router.put('/roles/:id', manage, validate({ params: RoleParams, body: UpdateRoleBody }), async (_req, res) => {
    const { id } = validated<typeof RoleParams>(res, 'params');
    res.json(await updateRole(caller(res), id, validated<typeof UpdateRoleBody>(res, 'body')));
  });

  router.delete('/roles/:id', manage, validate({ params: RoleParams, query: DeleteRoleQuery }), async (_req, res) => {
    const { id } = validated<typeof RoleParams>(res, 'params');
    await deleteRole(caller(res), id, validated<typeof DeleteRoleQuery>(res, 'query').version);
    res.status(204).end();
  });

  return router;
}
