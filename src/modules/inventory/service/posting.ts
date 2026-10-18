// Khung ghi sổ chung cho mọi phiếu (docs/16 #10 Template Method, plan #16 A6): khoá tồn → kiểm → giá vốn → cập nhật
// tồn → thẻ kho → ngưỡng và sự kiện. Từng loại phiếu chỉ khác chiều và luật giá. Chạy trong `withCompany`.
import type { Decimal } from 'decimal.js';
import { AppError } from '../../../shared/errors/app-error.ts';
import { publishEvent } from '../../platform/index.ts';
import { nextAlertState, weightedAvgCost } from '../domain/stock.ts';
import {
  companyOfTransaction,
  findRule,
  insertMove,
  type LevelRow,
  lockLevels,
  setLineCost,
  setRuleAlert,
  updateLevel,
} from '../repository/levels.ts';

export interface MoveLine {
  variantId: string;
  quantity: number;
  /** Dòng phiếu nhập (`in`) hoặc phiếu xuất (`out`) mà dòng thẻ kho trỏ về. */
  lineId: string;
  /** Giá nhập, chỉ dùng với `cost: 'weighted'`. */
  unitCost?: Decimal.Value;
}

export interface PostInput {
  /** `in`: phiếu nhập; `out`: phiếu xuất. */
  direction: 'in' | 'out';
  /** `weighted`: nhập tay, tính lại bình quân (K2); `current`: xuất và nhập hoàn, lấy giá vốn hiện tại. */
  cost: 'weighted' | 'current';
  /** Xuất theo đơn: lấy từ phần đang giữ (trừ cả `reserved`), không từ phần khả dụng. */
  fromReserved?: boolean;
  doneBy: string | null;
  lines: readonly MoveLine[];
}

const available = (l: LevelRow) => l.onHand - l.reserved;

/**
 * Ghi sổ các dòng của một phiếu đã chuyển trạng thái `done`. Xuất vượt khả dụng → 422 `insufficient_stock` kèm lỗi
 * theo dòng (`lines.<i>.quantity`, i theo thứ tự `lines`) trước khi đổi gì. Trả giá vốn đã ghi của từng dòng.
 */
export async function applyStockMoves(input: PostInput): Promise<Map<string, string>> {
  companyOfTransaction();
  if (new Set(input.lines.map((l) => l.variantId)).size !== input.lines.length) {
    throw new Error('Một phiếu chỉ có một dòng mỗi biến thể');
  }
  const levels = await lockLevels(
    input.lines.map((l) => l.variantId),
    input.direction === 'in',
  );

  if (input.direction === 'out') {
    const errors: Record<string, string> = {};
    input.lines.forEach((line, i) => {
      const level = levels.get(line.variantId);
      const left = !level ? 0 : input.fromReserved ? level.reserved : available(level);
      if (line.quantity > left) errors[`lines.${i}.quantity`] = `Chỉ còn ${Math.max(left, 0)} khả dụng`;
    });
    if (Object.keys(errors).length > 0) {
      throw new AppError(422, 'insufficient_stock', 'Không đủ hàng khả dụng để xuất', { errors });
    }
  }

  const costs = new Map<string, string>();
  for (const line of input.lines) {
    const level = levels.get(line.variantId);
    if (!level) throw new AppError(404, 'not_found', 'Không tìm thấy tồn của biến thể');
    const before = { ...level };
    let unitCost = level.avgCost;
    if (input.direction === 'in') {
      if (input.cost === 'weighted') {
        if (line.unitCost === undefined) throw new Error('Phiếu nhập tay cần giá nhập');
        unitCost = String(line.unitCost);
        level.avgCost = weightedAvgCost(level.onHand, level.avgCost, line.quantity, line.unitCost).toFixed(2);
      }
      level.onHand += line.quantity;
    } else {
      level.onHand -= line.quantity;
      if (input.fromReserved) level.reserved -= line.quantity;
    }
    await updateLevel(level);
    await insertMove({
      variantId: line.variantId,
      qtyChange: input.direction === 'in' ? line.quantity : -line.quantity,
      onHandAfter: level.onHand,
      ...(input.direction === 'in' ? { receiptLineId: line.lineId } : { issueLineId: line.lineId }),
      unitCost,
      doneBy: input.doneBy,
    });
    if (input.direction === 'out') await setLineCost('issue', line.lineId, unitCost);
    else if (input.cost === 'current') await setLineCost('receipt', line.lineId, unitCost);
    costs.set(line.variantId, unitCost);
    await applyAvailableChange(level, available(before));
  }
  return costs;
}

/** Giữ thêm (`delta` > 0) hoặc trả (`delta` < 0) hàng trên dòng tồn đã khoá; chỗ duy nhất ngoài ghi sổ đổi `reserved`. */
export async function changeReserved(level: LevelRow, delta: number): Promise<void> {
  const availableBefore = available(level);
  level.reserved += delta;
  await updateLevel(level);
  await applyAvailableChange(level, availableBefore);
}

/**
 * Sau mỗi lần đổi tồn của một biến thể (đã khoá dòng tồn): khả dụng đổi thì phát `inventory.stock_changed`; tính lại
 * cảnh báo ngưỡng và phát `inventory.below_threshold` khi vừa xuống dưới (V31, plan #16 A9).
 */
export async function applyAvailableChange(level: LevelRow, availableBefore: number): Promise<void> {
  const now = available(level);
  if (now === availableBefore) return;
  await publishEvent({
    type: 'inventory.stock_changed',
    aggregateId: level.variantId,
    payload: { variantId: level.variantId, onHand: level.onHand, reserved: level.reserved, available: now },
  });
  await syncThreshold(level.variantId, now);
}

/** Đưa `alert_active` của ngưỡng về đúng khả dụng hiện tại; vừa xuống dưới thì phát cảnh báo (V31). */
export async function syncThreshold(variantId: string, availableNow: number): Promise<void> {
  const rule = await findRule(variantId);
  if (!rule) return;
  const next = nextAlertState({ available: availableNow, minQty: rule.minQty, alertActive: rule.alertActive });
  if (next.alertActive !== rule.alertActive) await setRuleAlert(rule.id, next.alertActive);
  if (next.fire) {
    await publishEvent({
      type: 'inventory.below_threshold',
      aggregateId: variantId,
      payload: { variantId, available: availableNow, minQty: rule.minQty },
    });
  }
}
