import type { PackageStatus } from './package.ts';

export interface PackLine {
  variantId: string | null;
  quantity: number;
}
export interface ScannedLine {
  variantId: string;
  quantity: number;
}

export function scanMismatch(lines: readonly PackLine[], scanned: readonly ScannedLine[]): Record<string, string> | null {
  const expected = new Map<string, number>();
  for (const { variantId, quantity } of lines) {
    if (variantId) expected.set(variantId, (expected.get(variantId) ?? 0) + quantity);
  }
  const actual = new Map(scanned.map(({ variantId, quantity }) => [variantId, quantity]));
  const errors: Record<string, string> = {};
  for (const [id, quantity] of expected) {
    const scannedQty = actual.get(id) ?? 0;
    if (scannedQty !== quantity) errors[`lines.${id}`] = `Kiện cần ${quantity}, đã quét ${scannedQty}`;
  }
  for (const id of actual.keys()) {
    if (!expected.has(id)) errors[`lines.${id}`] = 'Món này không có trong kiện';
  }
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

export interface PickRow extends PackLine {
  packageId: string;
  sku: string;
  productName: string;
  attributesLabel: string;
}

export type PickListLine = Omit<PickRow, 'packageId'> & { packageCount: number };

export function buildPickList(rows: readonly PickRow[]): PickListLine[] {
  const groups = new Map<string, { item: Omit<PickRow, 'packageId'>; packages: Set<string> }>();
  for (const { packageId, ...row } of rows) {
    const key = row.variantId ? `variant:${row.variantId}` : `sku:${row.sku}`;
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
