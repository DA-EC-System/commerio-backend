import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { purchaseRequests, suppliers } from './schema.ts';

// Mọi hàm chạy trong `withCompany` của service: RLS chỉ cho thấy NCC của công ty đang chọn.

const columns = {
  id: suppliers.id,
  name: suppliers.name,
  phone: suppliers.phone,
  email: suppliers.email,
  address: suppliers.address,
  note: suppliers.note,
  active: suppliers.active,
  version: suppliers.version,
  createdAt: suppliers.createdAt,
};

export type SupplierRow = Awaited<ReturnType<typeof findSuppliers>>[number];

export interface SupplierValues {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  active: boolean;
}

/** Tên hoặc số điện thoại chứa `search` (không phân biệt hoa thường, không ký tự đại diện); xếp theo tên. */
export function findSuppliers(filter: { search?: string | undefined; active?: boolean | undefined } = {}) {
  return getDb()
    .select(columns)
    .from(suppliers)
    .where(
      and(
        filter.active ? eq(suppliers.active, true) : undefined,
        filter.search
          ? sql`(strpos(lower(${suppliers.name}), lower(${filter.search})) > 0 or strpos(${suppliers.phone}, ${filter.search}) > 0)`
          : undefined,
      ),
    )
    .orderBy(asc(suppliers.name), asc(suppliers.id));
}

export async function findSupplier(id: string): Promise<SupplierRow | undefined> {
  const [row] = await getDb().select(columns).from(suppliers).where(eq(suppliers.id, id));
  return row;
}

export async function insertSupplier(companyId: string, values: SupplierValues): Promise<SupplierRow> {
  const [row] = await getDb()
    .insert(suppliers)
    .values({ companyId, ...values })
    .returning(columns);
  return row!;
}

/** Sửa khi `version` còn khớp; không khớp (người khác vừa sửa) thì trả `undefined`. */
export async function updateSupplierIfVersion(id: string, version: number, values: SupplierValues): Promise<SupplierRow | undefined> {
  const [row] = await getDb()
    .update(suppliers)
    .set({ ...values, version: sql`${suppliers.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(suppliers.id, id), eq(suppliers.version, version)))
    .returning(columns);
  return row;
}

/** Công ty đang chọn đã có NCC hoặc đề nghị nhập chưa: có thì không tắt được phân hệ Mua hàng (#152, QT-04). */
export async function hasPurchasingData(): Promise<boolean> {
  const [supplier] = await getDb().select({ one: sql`1` }).from(suppliers).limit(1);
  if (supplier) return true;
  const [request] = await getDb().select({ one: sql`1` }).from(purchaseRequests).limit(1);
  return !!request;
}
