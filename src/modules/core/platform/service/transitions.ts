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
  await recordAudit({
    companyId: requireCompanyId('recordTransition'),
    actorId: input.actorId,
    action: 'update',
    entityType: input.audit?.entityType ?? input.entityType,
    entityId: input.entityId,
    before: { status: input.from },
    after: {
      ...(input.audit?.label && { code: input.audit.label }),
      status: input.to,
      action: input.action,
      selfApproved: true,
    },
  });
}
