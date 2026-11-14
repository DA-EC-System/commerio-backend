// Tách kiện trong app (spec 205 §5.4, Documents/21 §19.2): kiện cũ giữ phần còn lại, mỗi phần của `parts` thành một kiện
// mới. Không là mũi tên của máy trạng thái (D3). Cả luồng trong khoá phiên theo kiện (như đóng gói):
//   Bước 1 kiểm trong giao dịch ngắn; `splitLevel` của gian hàng hỏi ngoài giao dịch (D6, D15).
//   Bước 2b xin mã kiện mới trong giao dịch riêng, commit ngay (D15: không giữ bộ đếm khi khoá dòng tồn).
//   Bước 3 một giao dịch, thứ tự khoá của spec 199b §5.10: advisory phân hàng → kiện của đơn → dòng tồn (`runAllocation`).
// Hàng đã giữ đi theo dòng, không gọi cổng tồn (D4): inventory chỉ giữ tổng theo SKU.
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isSealed } from '../domain/package.ts';
import { carveLine, type LineMove, planSplit, type SplitLevel, type SplitPart } from '../domain/split.ts';
import { takeAllocationLock } from '../repository/allocation.ts';
import { insertPackage, lockOrderPackages, updatePackage } from '../repository/packages.ts';
import { carveLineInto, moveLines, readSplitSource, type SplitSource } from '../repository/split.ts';
import type { Actor } from './actor.ts';
import { runAllocation } from './allocation.ts';
import { type FulfillmentContext, marketplacePackagesOf, orderViewLookupOf, packageCodeLookupOf } from './packages.ts';
import { versionConflict, withPackageLock } from './packing.ts';

/** Cờ Cần xử lý trên kiện cũ khi sàn đã tách mà app chưa ghi được (D14). */
export const SPLIT_UNSYNCED_NOTE = 'Sàn đã tách kiện, app chưa ghi được: kiểm lại kiện trên sàn';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');
const notSupported = (message: string) => new AppError(422, 'split_not_supported', message);

async function readSource(id: string): Promise<SplitSource> {
  const source = await readSplitSource(id);
  if (!source) throw notFound();
  return source;
}

/** Trạng thái kiểm trước `version`, như bàn giao (spec 205 §5.4 Bước 1). */
function checkStatus(source: SplitSource) {
  if (isSealed(source.status)) throw new AppError(409, 'package_sealed', 'Kiện đã đóng gói, dỡ kiện về kệ trước khi tách');
  if (source.status !== 'reserved' && source.status !== 'backordered') {
    throw new AppError(409, 'invalid_transition', 'Chỉ tách được kiện chờ hàng hoặc đã giữ hàng', { current: source.status });
  }
}

function plan(source: SplitSource, parts: readonly (readonly SplitPart[])[], level: 'unit' | 'sku'): LineMove[][] {
  const result = planSplit(source.lines, parts, level);
  if (result.ok) return result.moves;
  if (result.code === 'validation_failed') throw new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors: result.errors });
  throw notSupported(result.message);
}

/** Ghi tách (Bước 3, sau khi đã khoá): kiện mới, chuyển dòng, lịch sử, sự kiện; kiện cũ `backordered` thì phân hàng. */
async function writeSplit(ctx: FulfillmentContext, actor: Actor, source: SplitSource, moves: readonly LineMove[][], codes: readonly string[]) {
  const status = source.status;
  // Số còn lại của từng dòng: một dòng lớn có thể bị lấy một phần ở nhiều kiện mới (D12).
  const left = new Map(source.lines.map((line) => [line.id, { quantity: line.quantity, reservedQty: line.reservedQty }]));
  for (const [i, part] of moves.entries()) {
    const packageId = await insertPackage({
      code: codes[i]!,
      orderId: source.orderId,
      shopId: source.shopId,
      platformPackageCode: null,
      trackingCode: null,
      status,
      shipBy: source.shipBy,
      ...source.shipping,
      reservedAt: status === 'reserved' ? source.reservedAt : null,
    });
    const whole: string[] = [];
    for (const move of part) {
      const line = left.get(move.lineId)!;
      if (move.quantity === line.quantity) {
        whole.push(move.lineId);
        continue;
      }
      const { keep, moved } = carveLine(line, move.quantity);
      await carveLineInto(move.lineId, keep, moved, packageId);
      left.set(move.lineId, keep);
    }
    await moveLines(packageId, whole);
    await recordTransition({
      entityType: 'packages', entityId: packageId, from: null, to: status, action: 'create', actorId: actor.accountId,
      reason: `Tách từ ${source.code}`,
    });
    await publishEvent({
      type: 'fulfillment.package_status_changed',
      aggregateId: source.orderId,
      payload: { packageId, orderId: source.orderId, from: null, to: status },
    });
  }
  await updatePackage(source.id, {});
  await recordTransition({
    entityType: 'packages', entityId: source.id, from: status, to: status, action: 'split', actorId: actor.accountId,
    reason: `Tách ra ${codes.join(', ')}`,
  });
  // Kiện con đủ hàng sang `reserved` qua lượt phân hàng chung (D4, mũi tên `hold`); lượt tự phát `allocation_done`.
  if (status === 'backordered') {
    const variantIds = [...new Set(source.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])))].sort();
    if (variantIds.length) await runAllocation(ctx, { variantIds });
  }
}

export async function splitPackage(
  ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; parts: SplitPart[][] },
): Promise<object> {
  const { companyId } = actor;
  return withPackageLock(ctx, companyId, id, async () => {
    const checked = await withCompany(companyId, async () => {
      const source = await readSource(id);
      checkStatus(source);
      if (source.version !== input.version) await versionConflict(ctx, id);
      return source;
    });

    // Đơn tay không có gian hàng: chia trong app như `unit` (D6).
    const level: SplitLevel = checked.shopId ? await marketplacePackagesOf(ctx).splitLevel(companyId, checked.shopId) : 'unit';
    if (level === 'none') throw notSupported('Sàn này không cho tách kiện');
    if (level === 'sku') throw notSupported('Sàn chỉ cho tách theo SKU, chưa tách được trong app');
    plan(checked, input.parts, level);

    const codes = await withCompany(companyId, async () => {
      const next = packageCodeLookupOf(ctx);
      const out: string[] = [];
      for (let i = 0; i < input.parts.length; i++) out.push(await next());
      return out;
    });

    await withCompany(companyId, async () => {
      await takeAllocationLock(companyId);
      await lockOrderPackages(checked.orderId);
      const source = await readSource(id);
      checkStatus(source);
      if (source.version !== input.version) await versionConflict(ctx, id);
      await writeSplit(ctx, actor, source, plan(source, input.parts, level), codes);
    });
    return withCompany(companyId, () => orderViewLookupOf(ctx)(checked.orderId));
  });
}
