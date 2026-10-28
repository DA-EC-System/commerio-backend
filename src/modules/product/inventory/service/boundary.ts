// Hàm cho sales (#24) và fulfillment (#25) gọi (Documents/21 §11; chữ ký A11 duyệt 18/10). Gọi trong `withCompany`
// của bên gọi; ngữ nghĩa idempotent ở plan #16 A10, ghi ở src/modules/product/inventory/CLAUDE.md.
import { Decimal } from 'decimal.js';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { publishEvent } from '../../../core/index.ts';
import { docNumber } from '../domain/stock.ts';
import {
  findOrderIssue,
  findOrderReturn,
  insertIssueLines,
  insertOrderIssue,
  insertReceiptLines,
  insertReturnReceipt,
  issueLines,
  nextDocSeq,
} from '../repository/documents.ts';
import {
  closeActiveReservations,
  companyOfTransaction,
  lockLevels,
  activeReservations,
  upsertActiveReservation,
} from '../repository/levels.ts';
import { applyStockMoves, changeReserved } from './posting.ts';

export interface StockLine {
  variantId: string;
  quantity: number;
}

/** Cộng dồn dòng trùng biến thể. */
function byVariant(lines: readonly StockLine[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 0) throw new Error(`Số lượng không hợp lệ: ${l.quantity}`);
    map.set(l.variantId, (map.get(l.variantId) ?? 0) + l.quantity);
  }
  return map;
}

/**
 * Giữ hàng cho đơn **tới** số yêu cầu (gọi lại không cộng dồn, có hàng thêm thì giữ bù). Dòng chưa đủ trả trong
 * `shortLines` với `available` = số đang giữ được cho đơn. Biến thể chưa có dòng tồn coi như khả dụng 0, không tạo
 * dòng tồn (A17).
 */
export async function reserve(
  orderId: string,
  lines: readonly StockLine[],
): Promise<{ shortLines: { variantId: string; requested: number; available: number }[] }> {
  companyOfTransaction();
  const requested = byVariant(lines);
  const levels = await lockLevels([...requested.keys()], false);
  // Đọc sau khoá: mọi lần ghi giữ chỗ của một biến thể đứng sau khoá dòng tồn của nó (A6), nên hai lần reserve
  // cùng đơn chạy song song không cùng thấy "chưa giữ".
  const held = new Map((await activeReservations(orderId)).map((r) => [r.variantId, r.quantity]));
  const shortLines = [];
  for (const [variantId, want] of [...requested].sort(([a], [b]) => a.localeCompare(b))) {
    const already = held.get(variantId) ?? 0;
    const level = levels.get(variantId);
    const add = level ? Math.max(0, Math.min(want - already, level.onHand - level.reserved)) : 0;
    const placed = add > 0 && (await upsertActiveReservation(orderId, variantId, already + add));
    if (placed) await changeReserved(level!, add);
    const got = already + (placed ? add : 0);
    if (got < want) shortLines.push({ variantId, requested: want, available: got });
  }
  return { shortLines };
}

/** Trả mọi giữ chỗ `active` của đơn (huỷ đơn); không còn gì để trả thì không làm gì. */
export async function release(orderId: string): Promise<void> {
  companyOfTransaction();
  const active = await activeReservations(orderId);
  if (active.length === 0) return;
  const levels = await lockLevels(
    active.map((r) => r.variantId),
    false,
  );
  const closed = await closeActiveReservations(orderId, 'released');
  const missing = closed.map((r) => r.variantId).filter((v) => !levels.has(v));
  for (const [v, l] of await lockLevels(missing, false)) levels.set(v, l);
  for (const r of closed) {
    const level = levels.get(r.variantId);
    if (level) await changeReserved(level, -r.quantity);
  }
}

/**
 * Lập và ghi sổ phiếu xuất theo đơn từ phần đang giữ, giá vốn lúc xuất (K2). Đơn đã có phiếu chưa huỷ thì trả phiếu
 * đó (gọi lại, kể cả đồng thời, an toàn). Không có giữ chỗ → 409 `not_reserved`.
 */
export async function issueForOrder(
  orderId: string,
  opts: { actorId?: string } = {},
): Promise<{ issueId: string; number: string; lines: { variantId: string; quantity: number; unitCost: Decimal }[] }> {
  companyOfTransaction();
  const existing = await findOrderIssue(orderId);
  if (existing) return existingIssue(existing);
  const active = await activeReservations(orderId);
  if (active.length === 0) throw notReserved();

  const number = docNumber('issue', await nextDocSeq('issue'));
  // Bộ đếm `issue` khoá tuần tự mọi lần lập phiếu xuất của công ty: lần gọi đồng thời thấy phiếu vừa commit ở đây.
  const raced = await findOrderIssue(orderId);
  if (raced) return existingIssue(raced);
  await lockLevels(
    active.map((r) => r.variantId),
    false,
  );
  // Tiêu giữ chỗ trước khi chèn phiếu: giữ chỗ vừa bị trả thì 409, không để lại phiếu rỗng.
  const consumed = await closeActiveReservations(orderId, 'consumed');
  if (consumed.length === 0) throw notReserved();
  const actorId = opts.actorId ?? null;
  const issueId = await insertOrderIssue({ orderId, number, actorId });
  if (!issueId) throw new Error('Phiếu xuất của đơn vừa được lập ở giao dịch khác');
  const lines = await insertIssueLines(issueId, consumed);
  const costs = await applyStockMoves({
    direction: 'out',
    cost: 'current',
    fromReserved: true,
    doneBy: actorId,
    lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, lineId: l.id })),
  });
  await publishEvent({
    type: 'inventory.issue_posted',
    aggregateId: issueId,
    payload: { issueId, number, kind: 'order', orderId, postedAt: new Date().toISOString() },
  });
  return {
    issueId,
    number,
    lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCost: new Decimal(costs.get(l.variantId)!) })),
  };
}

async function existingIssue(issue: { id: string; number: string }) {
  const lines = await issueLines(issue.id);
  return {
    issueId: issue.id,
    number: issue.number,
    lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCost: new Decimal(l.unitCost ?? 0) })),
  };
}

/**
 * Phiếu nhập hoàn đã ghi sổ cho đơn giao thất bại (UC-IN-03, K8): dòng số 0 bị bỏ; số nhận tối đa bằng số đã xuất;
 * khác số đã xuất thì bắt buộc ghi chú; giá vốn hiện tại, không đổi bình quân (K2). Mỗi đơn một phiếu chưa huỷ.
 */
export async function receiveReturn(
  orderId: string,
  lines: readonly StockLine[],
  opts: { note?: string; actorId?: string } = {},
): Promise<{ receiptId: string; number: string }> {
  companyOfTransaction();
  const already = await findOrderReturn(orderId);
  if (already) throw alreadyProcessed(already.number);
  const issue = await findOrderIssue(orderId);
  if (!issue || issue.status !== 'done') {
    throw new AppError(409, 'not_issued', 'Đơn chưa có phiếu xuất đã ghi sổ nên chưa nhập hoàn được');
  }
  const issued = new Map((await issueLines(issue.id)).map((l) => [l.variantId, l.quantity]));
  const note = opts.note?.trim() || null;

  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (!Number.isInteger(l.quantity) || l.quantity < 0) errors[`lines.${i}.quantity`] = 'Số lượng là số nguyên không âm';
    else if (!issued.has(l.variantId)) errors[`lines.${i}.variantId`] = 'Biến thể không có trong phiếu xuất của đơn';
    else if (seen.has(l.variantId)) errors[`lines.${i}.variantId`] = 'Biến thể bị lặp';
    else if (l.quantity > issued.get(l.variantId)!) errors[`lines.${i}.quantity`] = `Tối đa ${issued.get(l.variantId)} đã xuất`;
    seen.add(l.variantId);
  });
  const kept = lines.filter((l) => l.quantity > 0);
  if (Object.keys(errors).length === 0 && kept.length === 0) errors.lines = 'Nhập ít nhất một dòng có số lượng';
  const matchesIssue = [...issued].every(([v, q]) => lines.find((l) => l.variantId === v)?.quantity === q);
  if (Object.keys(errors).length === 0 && !matchesIssue && !note) {
    errors.note = 'Ghi lý do khi số nhận khác số đã xuất';
  }
  if (Object.keys(errors).length > 0) {
    throw new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors });
  }

  const number = docNumber('receipt', await nextDocSeq('receipt'));
  const actorId = opts.actorId ?? null;
  const receiptId = await insertReturnReceipt({ orderId, number, note, actorId });
  if (!receiptId) throw alreadyProcessed((await findOrderReturn(orderId))?.number ?? '');
  const rows = await insertReceiptLines(receiptId, kept);
  await applyStockMoves({
    direction: 'in',
    cost: 'current',
    doneBy: actorId,
    lines: rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity, lineId: r.id })),
  });
  await publishEvent({
    type: 'inventory.receipt_posted',
    aggregateId: receiptId,
    payload: { receiptId, number, kind: 'delivery_return', lines: kept.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) },
  });
  return { receiptId, number };
}

const notReserved = () => new AppError(409, 'not_reserved', 'Đơn chưa giữ hàng nên chưa xuất kho được');

const alreadyProcessed = (number: string) =>
  new AppError(409, 'already_processed', `Đơn đã có phiếu nhập hoàn ${number}`);
