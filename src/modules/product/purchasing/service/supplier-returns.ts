// Phiếu trả NCC (sơ đồ B4). Lập nháp từ hàng chờ xử lý cho inventory gọi qua `product/index.ts` (#208: phần trả NCC
// của kiểm hàng về, xuất huỷ bị từ chối chọn trả NCC). Máy trạng thái của phiếu làm ở #210.
import { recordTransition } from '../../../core/index.ts';
import { currentCompanyId } from '../../../../shared/db/client.ts';
import { nextDocNumber } from '../../inventory/index.ts';
import { docNumber } from '../domain/request.ts';
import { insertDraftReturn, insertReturnLines } from '../repository/returns.ts';

export interface SupplierReturnDraftInput {
  source: 'quarantine' | 'customer_return' | 'write_off_rejected';
  /** Phiếu kho sinh ra phiếu trả. */
  sourceId: string;
  lines: readonly { variantId: string; quantity: number; unitCost: string | null; sourceLineId: string | null }[];
  note: string;
}

/** Phiếu trả NCC nháp chưa chọn NCC (mua hàng chọn sau), trong giao dịch của bên gọi. */
export async function draftSupplierReturn(input: SupplierReturnDraftInput): Promise<{ id: string; number: string }> {
  const companyId = currentCompanyId()!;
  const number = docNumber('TN', await nextDocNumber('supplier_return'));
  const id = await insertDraftReturn({ companyId, number, supplierId: null, sourceId: input.sourceId, source: input.source, note: input.note });
  await insertReturnLines(companyId, id, input.lines.filter((l) => l.quantity > 0));
  await recordTransition({ entityType: 'supplier_returns', entityId: id, from: null, to: 'draft', action: 'create', actorId: null });
  return { id, number };
}
