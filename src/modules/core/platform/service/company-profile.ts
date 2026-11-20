// Hồ sơ công ty: tổ chức chịu trách nhiệm hàng hoá cho thuộc tính sàn (#292, Documents/21 mục 4, 11.3).
import { inTransaction, requireCompanyId } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { TAX_CODE_TAKEN_MESSAGE } from '../domain/tax-code.ts';
import {
  type CompanyProfilePatch,
  type CompanyProfileRow,
  findCompanyProfile,
  updateCompanyProfile as saveProfile,
  wasTaxCodeReleasedFrom,
} from '../repository/companies.ts';

/** Tổ chức chịu trách nhiệm hàng hoá hiệu lực; `address` null khi công ty chưa khai địa chỉ. */
export interface ResponsibleOrg {
  name: string;
  address: string | null;
}

/** Ô ghi đè trống thì theo tên, địa chỉ đăng ký của công ty. */
export const effectiveResponsible = (r: CompanyProfileRow): ResponsibleOrg => ({
  name: r.responsibleName ?? r.name,
  address: r.responsibleAddress ?? r.address,
});

const toView = (r: CompanyProfileRow) => ({ ...r, effectiveResponsible: effectiveResponsible(r) });

async function load(companyId: string): Promise<CompanyProfileRow> {
  const row = await findCompanyProfile(companyId);
  if (!row) throw new AppError(404, 'not_found', 'Không tìm thấy công ty');
  return row;
}

export const getCompanyProfile = async (companyId: string) => toView(await load(companyId));

/** Cổng cho channel điền thuộc tính sàn (Documents/21 mục 11.3). */
export const responsibleOrgOf = async (companyId: string) => effectiveResponsible(await load(companyId));

/** Cổng cho insight onboarding (#461, Documents/21 mục 11.3, 23): công ty đang chọn đã khai địa chỉ chưa. */
export const companyProfileFilled = async (): Promise<boolean> =>
  (await load(requireCompanyId('companyProfileFilled'))).address !== null;

/**
 * Sửa theo `version`, lệch thì 409 `version_conflict` kèm `current`. Ghi bằng role chủ bảng như `setCompanyLock`.
 * Chỉ ghi ô có giá trị khác hiện tại; không ô nào đổi thì trả hồ sơ, không tăng version, không ghi nhật ký.
 * Nhật ký mang `company_id` của công ty nên trang nhật ký nền tảng (chỉ lấy `company_id` null) không hiện.
 * `taxCode` (#459, Documents/21 mục 2.1): chỉ nhập được khi đang trống (sau khi quản trị nền tảng gỡ); trùng công ty
 * khác thì 409 `tax_code_taken` (CSDL ép unique).
 */
export async function updateCompanyProfile(actorId: string, companyId: string, input: CompanyProfilePatch & { version: number }) {
  try {
    return await saveCompanyProfile(actorId, companyId, input);
  } catch (err) {
    const { code, constraint } = pgError(err);
    if (code === '23505' && constraint === 'companies_tax_code_unique') {
      throw new AppError(409, 'tax_code_taken', TAX_CODE_TAKEN_MESSAGE, { errors: { taxCode: TAX_CODE_TAKEN_MESSAGE } });
    }
    throw err;
  }
}

function saveCompanyProfile(actorId: string, companyId: string, input: CompanyProfilePatch & { version: number }) {
  const { version, ...requested } = input;
  return inTransaction(async () => {
    const before = await load(companyId);
    const keys = (Object.keys(requested) as (keyof CompanyProfilePatch)[]).filter((k) => requested[k] !== before[k]);
    if (keys.includes('taxCode') && before.taxCode !== null) {
      throw new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
        errors: { taxCode: 'Công ty đã có mã số thuế; chỉ nhập được khi đang trống' },
      });
    }
    // Mã quản trị nền tảng vừa gỡ khỏi chính công ty này thì công ty không tự gán lại được
    if (keys.includes('taxCode') && requested.taxCode && (await wasTaxCodeReleasedFrom(companyId, requested.taxCode))) {
      throw new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
        errors: { taxCode: 'Mã số thuế này đã bị quản trị Commerio gỡ khỏi công ty; liên hệ hỗ trợ nếu đây là mã của bạn' },
      });
    }
    const patch: CompanyProfilePatch = Object.fromEntries(keys.map((k) => [k, requested[k]]));
    const saved = keys.length === 0 && before.version === version ? before : await saveProfile(companyId, version, patch);
    if (!saved) {
      throw new AppError(409, 'version_conflict', 'Hồ sơ công ty vừa được đổi ở một phiên khác', {
        current: toView(await load(companyId)),
      });
    }
    if (saved === before) return toView(before);
    await recordAudit({
      companyId,
      actorId,
      action: 'update',
      entityType: 'core.companies',
      entityId: companyId,
      label: before.name,
      before: Object.fromEntries(keys.map((k) => [k, before[k]])),
      after: patch,
    });
    return toView(saved);
  });
}
