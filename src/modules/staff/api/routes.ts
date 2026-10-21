import { type Response, Router } from 'express';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { getAccess } from '../../../shared/auth/authorize.ts';
import { env } from '../../../shared/config/env.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { approveInvitation, createInvitation, listInvitations, rejectInvitation } from '../service/invitations.ts';
import {
  checkInvitation,
  completeJoin,
  join2faConfirm,
  join2faSetup,
  requestOtp,
  RetryLaterError,
  verifyOtp,
} from '../service/join.ts';
import { type Caller, changeRoles, listStaff, setLocked } from '../service/members.ts';
import {
  ChangeRolesBody,
  CreateInvitationBody,
  InvitationListQuery,
  InvitationParams,
  JoinCheckBody,
  JoinCompleteBody,
  JoinOtpBody,
  JoinTwoFactorConfirmBody,
  JoinTwoFactorSetupBody,
  JoinVerifyBody,
  StaffListQuery,
  StaffParams,
  VersionBody,
} from './schemas.ts';
import { claimLimiter, emailKey, joinLimiter, joinLimits, readClaims } from './join-limits.ts';

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

  // Tham gia qua link (#7 [C]): công khai. Giới hạn theo IP đứng trước validate; giới hạn theo email, lời mời đứng sau
  // validate và sau bước kiểm chữ ký token (`readClaims`), chỉ tính token thật.
  const limits = joinLimits(env.JOIN_RATE_LIMIT_SCALE);
  const otpBody = (res: Response) => validated<typeof JoinOtpBody>(res, 'body');
  const verifyBody = (res: Response) => validated<typeof JoinVerifyBody>(res, 'body');
  const completeBody = (res: Response) => validated<typeof JoinCompleteBody>(res, 'body');

  router.post('/join/check', joinLimiter(limits.check), validate({ body: JoinCheckBody }), async (_req, res) => {
    res.json(await checkInvitation(validated<typeof JoinCheckBody>(res, 'body').token));
  });

  router.post(
    '/join/otp',
    joinLimiter(limits.otpIp),
    validate({ body: JoinOtpBody }),
    readClaims('invite', (res) => otpBody(res).token),
    claimLimiter(limits.otpEmail, (_claims, res) => emailKey(otpBody(res).email)),
    claimLimiter(limits.otpInvitation, (claims) => `invitation:${claims.jti}`),
    async (_req, res) => {
      try {
        await requestOtp(otpBody(res));
      } catch (err) {
        if (err instanceof RetryLaterError) res.setHeader('Retry-After', String(err.retryAfterSeconds));
        throw err;
      }
      res.status(202).json({});
    },
  );

  router.post(
    '/join/verify',
    joinLimiter(limits.verifyIp),
    validate({ body: JoinVerifyBody }),
    readClaims('invite', (res) => verifyBody(res).token),
    claimLimiter(limits.verifyInvitation, (claims) => `invitation:${claims.jti}`),
    async (_req, res) => {
      res.json(await verifyOtp(verifyBody(res)));
    },
  );

  router.post(
    '/join/complete',
    joinLimiter(limits.completeIp),
    validate({ body: JoinCompleteBody }),
    // Chỉ đếm lần lỗi (sai mật khẩu tài khoản đã có), theo email trong token đăng ký.
    readClaims('join', (res) => completeBody(res).registrationToken),
    claimLimiter(limits.completeEmail, (claims) => emailKey(claims.em ?? ''), { skipSuccessfulRequests: true }),
    async (_req, res) => {
      res.json(await completeJoin(completeBody(res)));
    },
  );

  // [D] 2FA lúc tham gia (email mới). Sai mã đếm theo lời mời của token đăng ký đã kiểm chữ ký.
  router.post(
    '/join/2fa/setup',
    joinLimiter(limits.completeIp),
    validate({ body: JoinTwoFactorSetupBody }),
    async (_req, res) => {
      res.json(await join2faSetup(validated<typeof JoinTwoFactorSetupBody>(res, 'body').registrationToken));
    },
  );

  const confirmBody = (res: Response) => validated<typeof JoinTwoFactorConfirmBody>(res, 'body');
  router.post(
    '/join/2fa/confirm',
    joinLimiter(limits.completeIp),
    validate({ body: JoinTwoFactorConfirmBody }),
    readClaims('join', (res) => confirmBody(res).registrationToken),
    claimLimiter(limits.twoFactorInvitation, (claims) => `join-2fa:${claims.jti}`, { skipSuccessfulRequests: true }),
    async (_req, res) => {
      const { registrationToken, code } = confirmBody(res);
      res.json(await join2faConfirm(registrationToken, code));
    },
  );

  return router;
}
