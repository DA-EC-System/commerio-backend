import { type Response, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../shared/auth/authorize.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { approveInvitation, createInvitation, listInvitations, rejectInvitation } from '../service/invitations.ts';
import { type Caller, changeRoles, listStaff, setLocked } from '../service/members.ts';
import {
  ChangeRolesBody,
  CreateInvitationBody,
  InvitationListQuery,
  InvitationParams,
  StaffListQuery,
  StaffParams,
  VersionBody,
} from './schemas.ts';

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
    router.post(
      `/staff/:accountId/${action}`,
      manage,
      validate({ params: StaffParams, body: VersionBody }),
      async (_req, res) => {
        const { accountId } = validated<typeof StaffParams>(res, 'params');
        res.json(await setLocked(caller(res), accountId, locked, validated<typeof VersionBody>(res, 'body').version));
      },
    );
  }

  // Lời mời bằng link (#7 [C]).
  router.post('/invitations', manage, validate({ body: CreateInvitationBody }), async (_req, res) => {
    const { roleIds } = validated<typeof CreateInvitationBody>(res, 'body');
    res.status(201).json(await createInvitation(caller(res), roleIds));
  });

  router.get('/invitations', view, validate({ query: InvitationListQuery }), async (_req, res) => {
    res.json(await listInvitations(getAuth(res).companyId!, validated<typeof InvitationListQuery>(res, 'query')));
  });

  for (const [action, decide] of [
    ['approve', approveInvitation],
    ['reject', rejectInvitation],
  ] as const) {
    router.post(
      `/invitations/:id/${action}`,
      manage,
      validate({ params: InvitationParams, body: VersionBody }),
      async (_req, res) => {
        const { id } = validated<typeof InvitationParams>(res, 'params');
        res.json(await decide(caller(res), id, validated<typeof VersionBody>(res, 'body').version));
      },
    );
  }

  return router;
}
