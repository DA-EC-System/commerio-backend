import type { PackageStatus } from './package.ts';

/** Dòng kiện đem so: `id` là id dòng kiện; dòng "không quản tồn" không có biến thể, quét theo `id`. */
export interface PackLine {
  id: string;
  variantId: string | null;
  stockUntracked: boolean;
  quantity: number;
}
export interface ScannedLine {
  variantId: string;
  quantity: number;
}
/** Số đã cho vào hộp của một dòng "không quản tồn" (Documents/21 §19.2 `pack.untrackedLines`). */
export interface ScannedUntrackedLine {
  lineId: string;
  quantity: number;
}

function compareScan(
  errors: Record<string, string>, prefix: string, want: ReadonlyMap<string, number>, got: readonly (readonly [string, number])[], unknown: string,
) {
  const actual = new Map(got);
  for (const [key, quantity] of want) {
    const scannedQty = actual.get(key) ?? 0;
    if (scannedQty !== quantity) errors[`${prefix}.${key}`] = `Kiện cần ${quantity}, đã quét ${scannedQty}`;
  }
  for (const key of actual.keys()) {
    if (!want.has(key)) errors[`${prefix}.${key}`] = unknown;
  }
}

/**
 * So số quét với kiện. Dòng đã ghép gộp theo biến thể (`lines.<variantId>`); dòng "không quản tồn" so từng dòng theo id
 * (`untrackedLines.<lineId>`), phải đủ như dòng thường. Dòng chưa ghép SKU không so (kho chưa biết quét gì).
 */
export function scanMismatch(
  lines: readonly PackLine[],
  scanned: readonly ScannedLine[],
  scannedUntracked: readonly ScannedUntrackedLine[] = [],
): Record<string, string> | null {
  const expected = new Map<string, number>();
  const expectedUntracked = new Map<string, number>();
  for (const { id, variantId, stockUntracked, quantity } of lines) {
    if (variantId) expected.set(variantId, (expected.get(variantId) ?? 0) + quantity);
    else if (stockUntracked) expectedUntracked.set(id, quantity);
  }
  const errors: Record<string, string> = {};
  compareScan(errors, 'lines', expected, scanned.map((l) => [l.variantId, l.quantity] as const), 'Món này không có trong kiện');
  compareScan(
    errors, 'untrackedLines', expectedUntracked, scannedUntracked.map((l) => [l.lineId, l.quantity] as const),
    'Dòng này không phải dòng "không quản tồn" của kiện',
  );
  return Object.keys(errors).length ? errors : null;
}

export interface GroupMember {
  code: string;
  status: PackageStatus;
  orderStatus: 'unpaid' | 'processing' | 'completed' | 'cancelled';
}

export function packGroupBlockers(others: readonly GroupMember[]): string[] {
  return others.filter(({ status, orderStatus }) => (status !== 'reserved' && status !== 'packed') || orderStatus !== 'processing')
    .map(({ code }) => code);
}

export function readyGroupBlockers(others: readonly Pick<GroupMember, 'code' | 'status'>[]): string[] {
  return others.filter(({ status }) => status !== 'packed').map(({ code }) => code);
}

/** Một dòng kiện để nhặt: dòng đã ghép mang SKU, tên, nhãn của biến thể app; chưa ghép hay "không quản tồn" mang của sàn. */
export interface PickRow {
  packageId: string;
  variantId: string | null;
  untracked: boolean;
  quantity: number;
  sku: string;
  productName: string;
  attributesLabel: string;
}

export type PickListLine = Omit<PickRow, 'packageId'> & { packageCount: number };

export function buildPickList(rows: readonly PickRow[]): PickListLine[] {
  const groups = new Map<string, { item: Omit<PickRow, 'packageId'>; packages: Set<string> }>();
  for (const { packageId, ...row } of rows) {
    const key = row.variantId ? `variant:${row.variantId}` : `${row.untracked ? 'untracked' : 'sku'}:${row.sku}`;
    const group = groups.get(key);
    if (group) {
      group.item.quantity += row.quantity;
      group.packages.add(packageId);
    } else {
      groups.set(key, { item: row, packages: new Set([packageId]) });
    }
  }
  return [...groups.values()].map(({ item, packages }) => ({ ...item, packageCount: packages.size }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}
