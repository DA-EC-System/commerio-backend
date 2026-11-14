// Tách kiện trong app (spec 205 §5.4, Documents/21 §19.2): kiện cũ giữ phần còn lại, mỗi phần của `parts` thành một kiện
// mới. Không là mũi tên của máy trạng thái (D3). Cả luồng trong khoá phiên theo kiện (như đóng gói):
//   Bước 1 kiểm trong giao dịch ngắn; `splitLevel` của gian hàng hỏi ngoài giao dịch (D6, D15).
//   Bước 2b xin mã kiện mới trong giao dịch riêng, commit ngay (D15: không giữ bộ đếm khi khoá dòng tồn).
//   Bước 3 một giao dịch, thứ tự khoá của spec 199b §5.10: advisory phân hàng → kiện của đơn → dòng tồn (`runAllocation`).
// Hàng đã giữ đi theo dòng, không gọi cổng tồn (D4): inventory chỉ giữ tổng theo SKU.
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isSealed } from '../domain/package.ts';
import { carveLine, type LineMove, planSplit, type SplitLevel, type SplitPart } from '../domain/split.ts';
import { takeAllocationLock } from '../repository/allocation.ts';
import { insertPackage, lockOrderPackages, updatePackage } from '../repository/packages.ts';
import { carveLineInto, liveSiblingCount, moveLines, platformLineIds, readSplitSource, type SplitSource } from '../repository/split.ts';
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

/**
 * Ghi tách (Bước 3, sau khi đã khoá): kiện mới, chuyển dòng, lịch sử, sự kiện; kiện cũ `backordered` thì phân hàng.
 * `platformCodes` (nhánh `sku`): mã kiện sàn theo thứ tự nhóm, nhóm đầu là kiện cũ.
 */
async function writeSplit(
  ctx: FulfillmentContext, actor: Actor, source: SplitSource, moves: readonly LineMove[][], codes: readonly string[],
  platformCodes: readonly string[] | null,
) {
  const status = source.status;
  // Sửa mã của kiện cũ trước khi chèn kiện mới: lượt kéo chen giữa có thể đã gắn cho kiện cũ mã của một nhóm khác, chèn
  // kiện mới mang đúng mã đó trước sẽ vướng unique `packages_platform_code_order_uq` (spec 205 §5.4 bước 4).
  if (platformCodes) await updatePackage(source.id, { platformPackageCode: platformCodes[0]! });
  // Số còn lại của từng dòng: một dòng lớn có thể bị lấy một phần ở nhiều kiện mới (D12).
  const left = new Map(source.lines.map((line) => [line.id, { quantity: line.quantity, reservedQty: line.reservedQty }]));
  for (const [i, part] of moves.entries()) {
    const packageId = await insertPackage({
      code: codes[i]!,
      orderId: source.orderId,
      shopId: source.shopId,
      platformPackageCode: platformCodes ? platformCodes[i + 1]! : null,
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
  if (!platformCodes) await updatePackage(source.id, {});
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
    const moves = plan(checked, input.parts, level);

    // Nhánh `sku`: sàn tách trước, ngoài giao dịch (D7); sàn từ chối thì app chưa ghi gì.
    const target = level === 'sku' ? await withCompany(companyId, async () => {
      if (await liveSiblingCount(checked.orderId, id) > 0) throw notSupported('Đơn đã có nhiều kiện trên sàn, chưa tách tiếp được trong app');
      return platformGroups(checked, moves, await platformLineIds(id));
    }) : null;
    const platformCodes = target ? await marketplacePackagesOf(ctx).split(companyId, checked.shopId!, target.externalOrderId, target.groups) : null;

    try {
      if (platformCodes && platformCodes.length !== target!.groups.length) {
        throw new Error(`Sàn trả ${platformCodes.length} mã kiện cho ${target!.groups.length} nhóm`);
      }
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
        if (platformCodes) {
          // D7: sàn đã tách, không so `version` (lượt kéo vừa cập nhật vận đơn không được làm lỡ lần ghi). Kiện còn chưa
          // đóng gói và còn đúng các dòng đã gửi sàn thì ghi.
          const again = source.status === 'reserved' || source.status === 'backordered' ? planSplit(source.lines, input.parts, 'sku') : null;
          if (!again?.ok || !sameMoves(again.moves, moves)) await versionConflict(ctx, id);
          await writeSplit(ctx, actor, source, moves, codes, platformCodes);
          return;
        }
        checkStatus(source);
        if (source.version !== input.version) await versionConflict(ctx, id);
        await writeSplit(ctx, actor, source, plan(source, input.parts, level), codes, null);
      });
    } catch (err) {
      if (platformCodes) await flagUnsynced(companyId, id, checked.orderId, platformCodes, err);
      throw err;
    }
    return withCompany(companyId, () => orderViewLookupOf(ctx)(checked.orderId));
  });
}

const sameMoves = (a: readonly LineMove[][], b: readonly LineMove[][]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Nhóm mã món sàn cho cổng tách: nhóm của kiện cũ (phần còn lại, kể cả dòng chưa ghép) đứng đầu, rồi từng kiện mới theo
 * thứ tự `parts`. Thiếu mã đơn hay mã món sàn thì 409 `item_not_packable`.
 */
function platformGroups(
  source: SplitSource, moves: readonly LineMove[][], ids: Awaited<ReturnType<typeof platformLineIds>>,
): { externalOrderId: string; groups: string[][] } {
  const lines = new Map(source.lines.map((line) => [line.id, line]));
  const moved = new Set(moves.flat().map((move) => move.lineId));
  const external = (lineId: string) => ids.byOrderLine.get(lines.get(lineId)!.orderLineId) ?? null;
  const groups = [
    source.lines.filter((line) => !moved.has(line.id)).map((line) => external(line.id)),
    ...moves.map((part) => part.map((move) => external(move.lineId))),
  ];
  if (!ids.externalOrderId || groups.some((group) => group.some((code) => !code))) {
    throw new AppError(409, 'item_not_packable', 'Kiện thiếu mã đơn hoặc mã món trên sàn');
  }
  return { externalOrderId: ids.externalOrderId, groups: groups as string[][] };
}

/** D14: sàn đã tách mà app chưa ghi được; lượt kéo đơn không tự phát hiện ca này nên bật Cần xử lý trên kiện cũ. */
async function flagUnsynced(companyId: string, packageId: string, orderId: string, platformPackageCodes: readonly string[], err: unknown) {
  logger.error({ err, packageId, orderId, platformPackageCodes }, 'sàn đã tách kiện, app chưa ghi được');
  await withCompany(companyId, () => updatePackage(packageId, { needsAttention: true, flagNote: SPLIT_UNSYNCED_NOTE })).catch((flagError: unknown) => {
    logger.error({ err: flagError, packageId }, 'không lưu được cờ tách kiện lệch sàn');
  });
}
