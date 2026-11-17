// Hồ sơ công ty: tổ chức chịu trách nhiệm hàng hoá cho thuộc tính sàn (#292, Documents/21 mục 4, 11.3).
import { inTransaction } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import {
  type CompanyProfilePatch,
  type CompanyProfileRow,
  findCompanyProfile,
  updateCompanyProfile as saveProfile,
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

/**
 * Sửa theo `version`, lệch thì 409 `version_conflict` kèm `current`. Ghi bằng role chủ bảng như `setCompanyLock`.
 * Không gửi ô nào thì trả hồ sơ, không ghi. Nhật ký chỉ mang các ô đổi, không có `status` nên trang nhật ký nền tảng không lấy dòng này.
 */
export function updateCompanyProfile(actorId: string, companyId: string, input: CompanyProfilePatch & { version: number }) {
  const { version, ...patch } = input;
  const keys = Object.keys(patch) as (keyof CompanyProfilePatch)[];
  return inTransaction(async () => {
    const before = await load(companyId);
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
      before: Object.fromEntries(keys.map((k) => [k, before[k]])),
      after: patch,
    });
    return toView(saved);
  });
}
