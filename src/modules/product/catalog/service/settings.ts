// Cài đặt sản phẩm của công ty (Documents/19 D11, 21 mục 5.2): mẫu SKU, số {SEQ} kế tiếp, gợi ý mặc định.
import { withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import { findSettings, type SettingsRow, updateSettingsIfVersion } from '../repository/settings.ts';
import { auditOf, type Caller, versionConflict } from './errors.ts';
import { columnsOf, type SuggestConfig, suggestOf, withSuggest } from './suggest-config.ts';

const ENTITY = 'product.company_product_settings';

function toView(s: SettingsRow) {
  return { skuPattern: s.skuPattern, skuNextSeq: s.skuNextSeq, suggest: suggestOf(s), version: s.version };
}
export type SettingsView = ReturnType<typeof toView>;

const conflict = (row: SettingsRow) => versionConflict('Cài đặt sản phẩm vừa được người khác sửa', toView(row));

export async function getSettings(companyId: string): Promise<SettingsView> {
  return toView(await withCompany(companyId, findSettings));
}

/** Đổi mẫu chỉ áp cho SKU sinh sau (P3); `skuNextSeq` chỉ đọc. `suggest` không gửi thì giữ. */
export async function updateSettings(
  caller: Caller,
  input: { skuPattern: string; suggest?: SuggestConfig | undefined; version: number },
): Promise<SettingsView> {
  return withCompany(caller.companyId, async () => {
    const current = await findSettings();
    if (current.version !== input.version) throw conflict(current);
    const suggest = input.suggest ?? suggestOf(current);
    if (!(await updateSettingsIfVersion(caller.companyId, input.version, input.skuPattern, columnsOf(suggest)))) {
      throw conflict(await findSettings());
    }
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, caller.companyId),
      label: 'Cài đặt sản phẩm',
      before: withSuggest({ skuPattern: current.skuPattern }, suggestOf(current)),
      after: withSuggest({ skuPattern: input.skuPattern }, suggest),
    });
    return toView(await findSettings());
  });
}
