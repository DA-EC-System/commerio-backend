// Ghi lịch sử chuyển trạng thái (Documents/21 mục 14.1). Lần tự duyệt ghi thêm một dòng nhật ký thao tác để CEO
// thấy nhãn "Tự duyệt" ở nhật ký (US-CT-10, #246); bước bình thường chỉ có trong lịch sử của bản ghi.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../audit/index.ts';
import { insertTransition, type TransitionRecord } from '../repository/transitions.ts';

/**
 * Ghi một lần chuyển trạng thái trong giao dịch của bên gọi, ngay sau câu UPDATE trạng thái (N4).
 * `selfApproved` lấy nguyên từ `assertTransition`.
 */
export async function recordTransition(input: TransitionRecord): Promise<void> {
  await insertTransition(input);
  if (!input.selfApproved) return;
  const { audit } = input;
  await recordAudit({
    companyId: requireCompanyId('recordTransition'),
    actorId: input.actorId,
    action: 'update',
    operation: input.action,
    entityType: audit.entityType,
    entityId: input.entityId,
    label: 'code' in audit ? audit.code : audit.label,
    before: { status: input.from },
    after: {
      ...('code' in audit && { code: audit.code }),
      status: input.to,
      action: input.action,
      selfApproved: true,
    },
  });
}
