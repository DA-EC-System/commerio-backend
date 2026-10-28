// Nhà cung cấp (Documents/21 mục 16.2). Ngừng giao dịch thì `active = false`, không xoá (N8).
import { recordAudit } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import {
  findSupplier,
  findSuppliers,
  insertSupplier,
  type SupplierRow,
  type SupplierValues,
  updateSupplierIfVersion,
} from '../repository/suppliers.ts';
import { type Actor, invalid, notFound } from './request-views.ts';

export interface SupplierInput {
  name: string;
  phone: string;
  email: string;
  address: string;
  note: string;
  active: boolean;
}

const ENTITY = 'product.suppliers';

export function toSupplier(s: SupplierRow) {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone ?? '',
    email: s.email ?? '',
    address: s.address ?? '',
    note: s.note ?? '',
    active: s.active,
    version: s.version,
    createdAt: s.createdAt.toISOString(),
  };
}

const values = (input: SupplierInput): SupplierValues => ({
  name: input.name,
  phone: input.phone || null,
  email: input.email || null,
  address: input.address || null,
  note: input.note || null,
  active: input.active,
});

/** Tên trùng (chữ thường) chạm index unique: giao dịch đã hỏng, báo theo ô sau khi rollback. */
function nameRace(err: unknown): never {
  if (pgError(err).constraint === 'suppliers_company_lower_name_uq') throw invalid({ name: 'Đã có nhà cung cấp tên này' });
  throw err;
}

export async function listSuppliers(companyId: string, q: { search?: string | undefined; active?: boolean | undefined }) {
  return withCompany(companyId, async () => (await findSuppliers(q)).map(toSupplier));
}

export async function createSupplier(actor: Actor, input: SupplierInput) {
  return withCompany(actor.companyId, async () => {
    const row = await insertSupplier(actor.companyId, values(input));
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'create',
      entityType: ENTITY,
      entityId: row.id,
      before: null,
      after: values(input),
    });
    return toSupplier(row);
  }).catch(nameRace);
}

export async function updateSupplier(actor: Actor, id: string, input: SupplierInput & { version: number }) {
  return withCompany(actor.companyId, async () => {
    const before = isUuid(id) ? await findSupplier(id) : undefined;
    if (!before) throw notFound('nhà cung cấp');
    const row = await updateSupplierIfVersion(id, input.version, values(input));
    if (!row) {
      throw new AppError(409, 'version_conflict', 'Nhà cung cấp vừa được người khác sửa', { current: toSupplier(before) });
    }
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: ENTITY,
      entityId: id,
      before: { name: before.name, phone: before.phone, email: before.email, address: before.address, note: before.note, active: before.active },
      after: values(input),
    });
    return toSupplier(row);
  }).catch(nameRace);
}
