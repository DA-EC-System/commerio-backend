import { type RequestHandler, type Response, Router } from 'express';
import type { z } from 'zod';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { type AccessLoader, assertCompanyAccess } from '../../../shared/auth/authorize.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { validate } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { type Caller, createRole, deleteRole, listPermissions, listRoles, updateRole } from '../service/roles.ts';
import { DeleteRoleQuery, RoleBody, RoleParams, UpdateRoleBody } from './schemas.ts';

/** Ngoài `authorize`, router cần đọc quyền thô hiện tại của người gọi (Documents/21 D1); identity truyền vào. */
export type AccessRouterContext = ModuleContext & { readonly loadCompanyAccess: AccessLoader };

const validated = <T extends z.ZodType>(res: Response, part: 'body' | 'query' | 'params') =>
  (res.locals.validated as Record<string, z.output<T>>)[part]!;

/** Route của module `access` (vai trò, quyền), gắn dưới /api/v1/identity (Documents/21 mục 3). */
export function accessRouter(ctx: AccessRouterContext): Router {
  const router = Router();
  const manage = ctx.authorize('identity.role.manage');
  const roleView = ctx.authorize('identity.role.view');
  const accountView = ctx.authorize('identity.account.view');

  // Màn nhân viên cũng cần danh sách vai trò để mời (mock FE): nhận identity.role.view hoặc identity.account.view.
  const viewRoles: RequestHandler = async (req, res, next) => {
    try {
      await roleView(req, res, next);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'forbidden')) throw err;
      await accountView(req, res, next);
    }
  };

  async function caller(res: Response): Promise<Caller> {
    const { accountId, companyId } = getAuth(res);
    const access = await ctx.loadCompanyAccess(accountId, companyId!);
    assertCompanyAccess(access);
    return { accountId, companyId: companyId!, permissions: access.permissions, enabledModules: access.enabledModules };
  }

  router.get('/permissions', roleView, async (_req, res) => {
    res.json(await listPermissions(getAuth(res).companyId!));
  });

  router.get('/roles', viewRoles, async (_req, res) => {
    res.json(await listRoles(getAuth(res).companyId!));
  });

  router.post('/roles', manage, validate({ body: RoleBody }), async (_req, res) => {
    res.status(201).json(await createRole(await caller(res), validated<typeof RoleBody>(res, 'body')));
  });

  router.put('/roles/:id', manage, validate({ params: RoleParams, body: UpdateRoleBody }), async (_req, res) => {
    const { id } = validated<typeof RoleParams>(res, 'params');
    res.json(await updateRole(await caller(res), id, validated<typeof UpdateRoleBody>(res, 'body')));
  });

  router.delete('/roles/:id', manage, validate({ params: RoleParams, query: DeleteRoleQuery }), async (_req, res) => {
    const { id } = validated<typeof RoleParams>(res, 'params');
    await deleteRole(await caller(res), id, validated<typeof DeleteRoleQuery>(res, 'query').version);
    res.status(204).end();
  });

  return router;
}
