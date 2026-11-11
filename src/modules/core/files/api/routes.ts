import { type RequestHandler, Router } from 'express';
import { getAuth, readAccessClaims } from '../../../../shared/auth/authenticate.ts';
import { assertCompanyAccess, getAccess, moduleOfPermission } from '../../../../shared/auth/authorize.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { loadCompanyAccess } from '../../identity/index.ts';
import type { FilePurpose } from '../domain/upload-rules.ts';
import { createUploadTicket } from '../service/uploads.ts';
import { UploadBody } from './schemas.ts';

/**
 * Thành viên còn làm việc được trong công ty, không đòi quyền nào: các bước của `authorize`
 * (`src/shared/auth/authorize.ts`) trừ kiểm phân hệ và mã quyền. Tệp đính kèm thì mọi thành viên tải được (§14.3).
 */
const member: RequestHandler = async (req, res, next) => {
  const claims = await readAccessClaims(req);
  if (!claims.companyId) throw new AppError(403, 'company_not_selected', 'Chưa chọn công ty làm việc');
  const access = await loadCompanyAccess(claims.accountId, claims.companyId);
  assertCompanyAccess(access, claims);
  res.locals.auth = claims;
  res.locals.access = access;
  next();
};

/** Quyền cần thêm theo mục đích; `null` là mọi thành viên. Ảnh sản phẩm như route sửa sản phẩm (§5.2). */
const PURPOSE_PERMISSION: Readonly<Record<FilePurpose, string | null>> = {
  product_image: 'catalog.product.manage',
  attachment: null,
};

/** Route của module `files`, gắn tại /api/v1/files. */
export function filesRouter(_ctx: ModuleContext): Router {
  const router = Router();

  // Quyền phụ thuộc `purpose` trong body nên kiểm sau `validate()`; body sai của người không có quyền ra 422.
  router.post('/uploads', member, validate({ body: UploadBody }), async (_req, res) => {
    const body = validated<typeof UploadBody>(res, 'body');
    const permission = PURPOSE_PERMISSION[body.purpose];
    if (permission) {
      const access = getAccess(res);
      if (!access.enabledModules.includes(moduleOfPermission(permission))) {
        throw new AppError(403, 'module_disabled', 'Phân hệ này đang tắt');
      }
      if (!access.permissions.includes(permission)) {
        throw new AppError(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
      }
    }
    const { accountId, companyId } = getAuth(res);
    res.status(201).json(await createUploadTicket({ accountId, companyId: companyId! }, body));
  });

  return router;
}
