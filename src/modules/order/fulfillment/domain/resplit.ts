// Luật thuần: sàn chia lại kiện (spec #238 §5.6, D22). Lập kế hoạch từ mọi kiện của đơn (kể cả đã huỷ, cần cho mã) và
// các nhóm món sàn xét chia lại; `service/resplit.ts` thi hành trong giao dịch kéo đơn.
//
// Từ ngữ: *kiện sống* là kiện khác `cancelled`; *dòng sống* là dòng kiện có `pendingDropQty = 0`; *chủ* của một dòng
// đơn là kiện sống có dòng sống của dòng đơn đó (đơn sàn mỗi món một dòng đơn số lượng 1, trigger kiểm bằng giữ tối đa
// một chủ).
import { isHandedOver, isSealed } from './package.ts';
import type { PackageStatus } from './package.ts';

export interface ResplitLine {
  id: string;
  orderLineId: string;
  quantity: number;
  pendingDropQty: number;
}

export interface ResplitPackage {
  id: string;
  /** Mã kiện app (`KH-…`): hoà số món thì kiện mã nhỏ hơn là kiện được thay. */
  code: string;
  status: PackageStatus;
  platformPackageCode: string | null;
  lines: readonly ResplitLine[];
}

/** Nhóm xét chia lại: có mã sàn, trạng thái biết và khác `cancelled` (bên gọi lọc). */
export interface ResplitGroup {
  code: string;
  lines: readonly { orderLineId: string; quantity: number }[];
}

export type ResplitStep =
  | { kind: 'clear_code'; packageId: string }
  | { kind: 'relabel'; packageId: string; code: string }
  | { kind: 'flag'; packageId: string }
  | { kind: 'cancel_open'; packageId: string }
  | { kind: 'move_out'; packageId: string; orderLineIds: string[] }
  | { kind: 'mark_drop'; packageId: string; orderLineIds: string[] }
  | { kind: 'create'; code: string; replacesPackageId: string; awaitingOpen: boolean };

export interface ResplitPlan {
  /** Mã nhóm → id kiện đã có nhận nhóm (khớp theo tập, hoặc giữ mã cũ). Nhóm `create` không có ở đây. */
  targets: Map<string, string>;
  steps: ResplitStep[];
  /** Có phần app không tự xử lý (D29): bên gọi bật Cần xử lý trên đơn. */
  resplit: boolean;
}

/** Thứ tự thi hành (§5.6 bước 4): gỡ mã trước khi gắn mã, huỷ và bớt dòng trước khi lập kiện mới. */
const STEP_ORDER: readonly ResplitStep['kind'][] = ['clear_code', 'relabel', 'flag', 'cancel_open', 'move_out', 'mark_drop', 'create'];

const isLive = (p: ResplitPackage) => p.status !== 'cancelled';
const liveLines = (p: ResplitPackage) => p.lines.filter((l) => l.pendingDropQty === 0);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Số lượng theo dòng đơn của một tập dòng. */
function quantities(lines: readonly { orderLineId: string; quantity: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.orderLineId, (out.get(l.orderLineId) ?? 0) + l.quantity);
  return out;
}

/** Khoá chuẩn hoá của tập (dòng đơn, số lượng): cặp `orderLineId:quantity` sắp xếp. */
const setKey = (lines: readonly { orderLineId: string; quantity: number }[]) =>
  [...quantities(lines)].map(([id, q]) => `${id}:${q}`).sort(byText).join('|');

/** Không lập kế hoạch cho đơn (D22 bước 0, 2.2): giữ nguyên, bên gọi bật Cần xử lý. */
const noPlan = (): ResplitPlan => ({ targets: new Map(), steps: [], resplit: true });

/**
 * Lập kế hoạch chia lại (spec #238 §5.6 "Luật thuần"):
 * 0. Một dòng đơn ở hai nhóm → không lập.
 * 1. Khớp theo tập dòng sống với kiện sống → `targets`; kiện chưa bàn giao mà mã khác thì `relabel`.
 * 2. Nhóm chưa khớp (mã tăng dần): món của kiện đã bàn giao → `flag`, bỏ nhóm; kiện sống mang mã nhóm (holder) chứa
 *    trọn nhóm → `targets`, không chứa trọn → không lập; còn lại `create` (thay kiện chứa nhiều món nhất, hoà thì mã app
 *    nhỏ hơn; chờ thay khi có món của kiện đã đóng).
 * 3. Kiện sống chưa bàn giao có dòng chuyển sang nhóm `create`: chưa đóng → `cancel_open` (mọi dòng sống đi) hoặc
 *    `move_out`; đã đóng → `mark_drop`.
 * Mã sắp gắn (relabel, create) đang nằm ở kiện khác không nhận mã mới: gỡ (`clear_code`, unique
 * `packages_platform_code_order_uq` không lọc trạng thái); kiện đó đã bàn giao (không gỡ được) thì không lập.
 * Chạy lại trên dữ liệu đã áp: mọi nhóm khớp ở bước 1, `steps` rỗng.
 */
export function planResplit(packages: readonly ResplitPackage[], groups: readonly ResplitGroup[]): ResplitPlan {
  const seen = new Set<string>();
  for (const g of groups) {
    for (const id of new Set(g.lines.map((l) => l.orderLineId))) {
      if (seen.has(id)) return noPlan();
      seen.add(id);
    }
  }

  const live = packages.filter(isLive);
  const owner = new Map<string, ResplitPackage>();
  for (const p of live) for (const l of liveLines(p)) owner.set(l.orderLineId, p);
  const sorted = groups.filter((g) => g.lines.length > 0).sort((a, b) => byText(a.code, b.code));

  const targets = new Map<string, string>();
  const steps: ResplitStep[] = [];
  let resplit = false;

  // Bước 1: khớp theo tập.
  const keyOf = new Map(live.map((p) => [p.id, setKey(liveLines(p))]));
  const matched = new Set<string>();
  const relabeled = new Map<string, string>();
  const unmatched: ResplitGroup[] = [];
  for (const g of sorted) {
    const key = setKey(g.lines);
    const pkg = live.find((p) => !matched.has(p.id) && keyOf.get(p.id) === key);
    if (!pkg) {
      unmatched.push(g);
      continue;
    }
    matched.add(pkg.id);
    targets.set(g.code, pkg.id);
    if (!isHandedOver(pkg.status) && pkg.platformPackageCode !== g.code) {
      relabeled.set(pkg.id, g.code);
      steps.push({ kind: 'relabel', packageId: pkg.id, code: g.code });
    }
  }

  // Bước 2: nhóm chưa khớp.
  const flagged = new Set<string>();
  const creates: ResplitGroup[] = [];
  for (const g of unmatched) {
    const owners = g.lines.map((l) => owner.get(l.orderLineId)).filter((p): p is ResplitPackage => p !== undefined);
    const handed = owners.filter((p) => isHandedOver(p.status));
    if (handed.length) {
      for (const p of handed) {
        if (flagged.has(p.id)) continue;
        flagged.add(p.id);
        steps.push({ kind: 'flag', packageId: p.id });
      }
      resplit = true;
      continue;
    }
    const holder = live.find((p) => p.platformPackageCode === g.code && !relabeled.has(p.id));
    if (holder) {
      // Holder đã khớp nhóm khác mà không đổi mã (đã bàn giao): mã nhóm kẹt ở kiện đó.
      if (matched.has(holder.id)) return noPlan();
      const mine = quantities(liveLines(holder));
      const contained = [...quantities(g.lines)].every(([id, q]) => mine.get(id) === q);
      if (!contained) return noPlan();
      targets.set(g.code, holder.id);
      continue;
    }
    if (!owners.length) continue;
    creates.push(g);
  }

  const createSteps: ResplitStep[] = [];
  const moving = new Set<string>();
  for (const g of creates) {
    const count = new Map<string, number>();
    for (const l of g.lines) {
      const p = owner.get(l.orderLineId);
      if (p) count.set(p.id, (count.get(p.id) ?? 0) + 1);
      moving.add(l.orderLineId);
    }
    const codeOf = (id: string) => live.find((p) => p.id === id)!.code;
    const [replaces] = [...count].sort((a, b) => b[1] - a[1] || byText(codeOf(a[0]), codeOf(b[0])));
    const awaitingOpen = g.lines.some((l) => {
      const p = owner.get(l.orderLineId);
      return p !== undefined && isSealed(p.status);
    });
    createSteps.push({ kind: 'create', code: g.code, replacesPackageId: replaces![0], awaitingOpen });
  }

  // Bước 3: kiện có dòng chuyển sang nhóm `create`.
  for (const p of live) {
    if (isHandedOver(p.status)) continue;
    const lines = liveLines(p);
    const out = [...new Set(lines.filter((l) => moving.has(l.orderLineId)).map((l) => l.orderLineId))];
    if (!out.length) continue;
    if (isSealed(p.status)) steps.push({ kind: 'mark_drop', packageId: p.id, orderLineIds: out });
    else if (lines.every((l) => moving.has(l.orderLineId))) steps.push({ kind: 'cancel_open', packageId: p.id });
    else steps.push({ kind: 'move_out', packageId: p.id, orderLineIds: out });
  }

  // Mã sắp gắn: kiện khác đang mang mà không nhận mã mới thì gỡ trước.
  const wanted = new Map<string, string | null>([...relabeled].map(([id, code]) => [code, id]));
  for (const g of creates) wanted.set(g.code, null);
  const cleared = new Set<string>();
  for (const p of packages) {
    if (p.platformPackageCode === null || !wanted.has(p.platformPackageCode)) continue;
    if (wanted.get(p.platformPackageCode) === p.id || relabeled.has(p.id)) continue;
    if (isLive(p) && isHandedOver(p.status)) return noPlan();
    if (!cleared.has(p.id)) steps.push({ kind: 'clear_code', packageId: p.id });
    cleared.add(p.id);
  }

  steps.push(...createSteps);
  steps.sort((a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind));
  return { targets, steps, resplit };
}

export interface ReplacementPair {
  newLineId: string;
  oldLineId: string;
  oldPackageId: string;
}

/**
 * Dòng sống của kiện ghép với dòng chờ bỏ cùng dòng đơn ở kiện khác đang đóng (D9). Rỗng: không phải kiện chờ thay.
 * "Kiện chờ thay" suy ra, không lưu cờ: kiện cũ mở xong, bị xác nhận mất hay rời kho thì kiện thay tự hết chờ.
 */
export function replacementPairs(packages: readonly ResplitPackage[], packageId: string): ReplacementPair[] {
  const pkg = packages.find((p) => p.id === packageId);
  if (!pkg || !isLive(pkg)) return [];
  const used = new Set<string>();
  const pairs: ReplacementPair[] = [];
  for (const line of liveLines(pkg)) {
    for (const other of packages) {
      if (other.id === pkg.id || !isSealed(other.status)) continue;
      const old = other.lines.find((l) => l.orderLineId === line.orderLineId && l.pendingDropQty > 0 && !used.has(l.id));
      if (!old) continue;
      used.add(old.id);
      pairs.push({ newLineId: line.id, oldLineId: old.id, oldPackageId: other.id });
      break;
    }
  }
  return pairs;
}
