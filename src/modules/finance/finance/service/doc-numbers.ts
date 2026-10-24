// Số chứng từ theo Documents/21 T2: `HD-000001` (hoá đơn), `PT-…` (phiếu thu), `PC-…` (phiếu chi), riêng mỗi công ty.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { takeNextNumber } from '../repository/doc-counters.ts';

const PREFIX = { invoice: 'HD', receipt: 'PT', payment_voucher: 'PC' } as const;

export type DocKind = keyof typeof PREFIX;

/** Số kế tiếp, trong giao dịch `withCompany` của bên gọi. */
export async function nextDocNumber(kind: DocKind): Promise<string> {
  const companyId = requireCompanyId('nextDocNumber');
  const n = await takeNextNumber(companyId, kind);
  return `${PREFIX[kind]}-${String(n).padStart(6, '0')}`;
}
