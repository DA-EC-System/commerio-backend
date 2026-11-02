import { Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { type AuditContext, getCompanyAuditLog, listCompanyAuditLogs } from '../service/logs.ts';
import { AuditLogParams, AuditLogQuery } from './schemas.ts';

/** Route của module `audit`, gắn tại /api/v1/audit (Documents/21 M1). */
export function auditRouter(ctx: AuditContext): Router {
  const router = Router();
  const view = ctx.authorize('platform.audit.view');

  router.get('/logs', view, validate({ query: AuditLogQuery }), async (_req, res) => {
    res.json(await listCompanyAuditLogs(ctx, getAuth(res).companyId!, validated<typeof AuditLogQuery>(res, 'query')));
  });

  router.get('/logs/:id', view, validate({ params: AuditLogParams }), async (_req, res) => {
    const { id } = validated<typeof AuditLogParams>(res, 'params');
    res.json(await getCompanyAuditLog(ctx, getAuth(res).companyId!, id));
  });

  return router;
}
