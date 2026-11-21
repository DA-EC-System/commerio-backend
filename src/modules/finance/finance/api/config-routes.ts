import type { Response, Router } from 'express';
import { getAuth } from '../../../../shared/auth/authenticate.ts';
import { anyOf, getAccess } from '../../../../shared/auth/authorize.ts';
import { validate, validated as input } from '../../../../shared/http/validate.ts';
import { USER_ACTIONS } from '../domain/config-version.ts';
import {
  actOnConfig,
  type Caller,
  createConfig,
  dryRunConfig,
  getConfig,
  listConfigs,
  updateDraft,
} from '../service/config-versions.ts';
import { listFeeTemplates } from '../service/fee-templates.ts';
import type { FinanceContext } from '../service/settlement-views.ts';
import { financeView } from './access.ts';
import { ConfigActionBody, ConfigActionParams, ConfigListQuery, CreateConfigBody, FeeTemplateQuery, UpdateConfigBody } from './config-schemas.ts';
import { IdParams, VersionBody } from './schemas.ts';

const caller = (res: Response): Caller => {
  const { companyId, accountId } = getAuth(res);
  const { permissions, enabledModules } = getAccess(res);
  return { companyId: companyId!, accountId, permissions, enabledModules };
};
const id = (res: Response) => input<typeof IdParams>(res, 'params').id;

/**
 * Phiên bản cấu hình tiền (Documents/21 §21.0, §21.4; #118), gắn vào router của finance. Xem: có ít nhất một quyền
 * tiền (như mục 16.1); soạn: `finance.config.manage`; thao tác theo máy trạng thái tự kiểm quyền của bước.
 */
export function mountConfigRoutes(router: Router, ctx: FinanceContext): void {
  const view = financeView(ctx);
  const manage = ctx.authorize('finance.config.manage');
  const act = anyOf(manage, ctx.authorize('finance.config.approve'));

  router.get('/configs', view, validate({ query: ConfigListQuery }), async (_req, res) => {
    res.json(await listConfigs(caller(res).companyId, input<typeof ConfigListQuery>(res, 'query')));
  });
  router.get('/configs/:id', view, validate({ params: IdParams }), async (_req, res) => {
    res.json(await getConfig(caller(res).companyId, id(res)));
  });
  // Biểu phí mẫu của nền tảng (Documents/21 §21.6): người soạn hay người duyệt cấu hình phí đọc để chép số vào form.
  router.get('/fee-templates', act, validate({ query: FeeTemplateQuery }), async (_req, res) => {
    res.json(await listFeeTemplates(caller(res).companyId, input<typeof FeeTemplateQuery>(res, 'query').platform));
  });
  router.post('/configs', manage, validate({ body: CreateConfigBody }), async (_req, res) => {
    res.status(201).json(await createConfig(ctx, caller(res), input<typeof CreateConfigBody>(res, 'body')));
  });
  router.put('/configs/:id', manage, validate({ params: IdParams, body: UpdateConfigBody }), async (_req, res) => {
    res.json(await updateDraft(caller(res), id(res), input<typeof UpdateConfigBody>(res, 'body')));
  });
  router.post('/configs/:id/dry-run', manage, validate({ params: IdParams, body: VersionBody }), async (_req, res) => {
    res.json(await dryRunConfig(ctx, caller(res), id(res), input<typeof VersionBody>(res, 'body').version));
  });
  router.post('/configs/:id/:action', act, validate({ params: ConfigActionParams, body: ConfigActionBody }), async (_req, res) => {
    const { id: configId, action } = input<typeof ConfigActionParams>(res, 'params');
    res.json(await actOnConfig(ctx, caller(res), configId, USER_ACTIONS[action], input<typeof ConfigActionBody>(res, 'body')));
  });
}
