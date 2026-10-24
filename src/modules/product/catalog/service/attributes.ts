// Thuộc tính và giá trị (UC-CP-01; Documents/21 5.2, 5.3, V21, V24).
import { withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import {
  attributeNameExists,
  deleteAttributeIfVersion,
  deleteValues,
  findAttributes,
  insertAttribute,
  insertValues,
  updateAttributeIfVersion,
  updateValue,
} from '../repository/attributes.ts';
import { auditOf, type Caller, inUse, invalid, isUuid, nameTaken, notFound, pgError, versionConflict } from './errors.ts';

/** `code` đã chuẩn hoá ở `api/schemas.ts` (bỏ trống thì sinh từ giá trị). */
export interface AttributeInput {
  name: string;
  values: { id?: string | undefined; value: string; code: string }[];
}

export type AttributeView = Awaited<ReturnType<typeof findAttributes>>[number];

const ENTITY = 'catalog.attributes';
const taken = () => nameTaken('Đã có thuộc tính cùng tên');
const snapshot = (a: AttributeInput | AttributeView) => ({ name: a.name, values: a.values.map((v) => `${v.value} (${v.code})`) });

async function findAttribute(id: string): Promise<AttributeView> {
  const [attribute] = isUuid(id) ? await findAttributes(id) : [];
  if (!attribute) throw notFound('thuộc tính');
  return attribute;
}

const conflict = (current: AttributeView) => versionConflict('Thuộc tính vừa được người khác sửa', current);

async function lostRace(id: string): Promise<never> {
  const [current] = await findAttributes(id);
  throw current ? conflict(current) : notFound('thuộc tính');
}

/** Chạy đua với bước kiểm trước: unique tên → 409; unique giá trị/mã → 422; khoá ngoại khi xoá → `in_use`. */
function race(err: unknown): never {
  const { code, constraint } = pgError(err);
  if (code === '23505' && constraint === 'attributes_company_lower_name_uq') throw taken();
  if (code === '23505') throw invalid({ values: 'Có giá trị hoặc mã bị trùng' });
  if (code === '23503') throw inUse('Giá trị đang có biến thể dùng');
  throw err;
}

export async function listAttributes(companyId: string): Promise<AttributeView[]> {
  return withCompany(companyId, () => findAttributes());
}

export async function createAttribute(caller: Caller, input: AttributeInput): Promise<AttributeView> {
  return withCompany(caller.companyId, async () => {
    if (await attributeNameExists(input.name)) throw taken();
    const id = await insertAttribute(caller.companyId, input.name);
    await insertValues(caller.companyId, id, input.values);
    await recordAudit({ ...auditOf(caller, 'create', ENTITY, id), after: snapshot(input) });
    return findAttribute(id);
  }).catch(race);
}

export async function updateAttribute(caller: Caller, id: string, input: AttributeInput & { version: number }) {
  return withCompany(caller.companyId, async () => {
    const attribute = await findAttribute(id);
    if (attribute.version !== input.version) throw conflict(attribute);
    const current = new Map(attribute.values.map((v) => [v.id, v]));
    if (input.values.some((v) => v.id !== undefined && !current.has(v.id))) {
      throw invalid({ values: 'Có giá trị không thuộc thuộc tính này' });
    }
    if (await attributeNameExists(input.name, id)) throw taken();
    const kept = new Set(input.values.map((v) => v.id));
    const removed = attribute.values.filter((v) => !kept.has(v.id));
    const removedInUse = removed.filter((v) => v.inUse);
    if (removedInUse.length) {
      throw inUse(`Không xoá được ${removedInUse.map((v) => v.value).join(', ')} vì đã có biến thể dùng`);
    }
    if (!(await updateAttributeIfVersion(id, input.version, input.name))) await lostRace(id);

    await deleteValues(removed.map((v) => v.id));
    // Unique (thuộc tính, chữ) và (thuộc tính, mã) kiểm từng dòng, nên đổi chéo hai giá trị trong một câu sẽ lỗi:
    // ghi chữ và mã tạm cho các dòng đổi trước, rồi mới ghi giá trị thật (ground-truth #12).
    const changed = input.values.filter((v): v is typeof v & { id: string } => {
      const old = v.id === undefined ? undefined : current.get(v.id);
      return old !== undefined && (old.value !== v.value || old.code !== v.code);
    });
    const codes = new Set([...attribute.values.map((v) => v.code), ...input.values.map((v) => v.code)]);
    const temporary = temporaryCodes(codes, changed.length);
    for (const [i, v] of changed.entries()) await updateValue(v.id, `~${v.id}`, temporary[i]!);
    for (const v of changed) await updateValue(v.id, v.value, v.code);
    await insertValues(caller.companyId, id, input.values.filter((v) => v.id === undefined));

    await recordAudit({ ...auditOf(caller, 'update', ENTITY, id), before: snapshot(attribute), after: snapshot(input) });
    return findAttribute(id);
  }).catch(race);
}

export async function deleteAttribute(caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    const attribute = await findAttribute(id);
    if (attribute.version !== version) throw conflict(attribute);
    if (attribute.productCount > 0) {
      throw inUse(`Không xoá được thuộc tính ${attribute.name} vì có ${attribute.productCount} sản phẩm đang dùng`);
    }
    if (!(await deleteAttributeIfVersion(id, version))) await lostRace(id);
    await recordAudit({ ...auditOf(caller, 'delete', ENTITY, id), before: snapshot(attribute) });
  }).catch(race);
}

/** Mã tạm qua được CHECK `^[A-Z0-9]{1,6}$` và không trùng mã nào đang có hay sắp ghi. */
function temporaryCodes(taken: ReadonlySet<string>, count: number): string[] {
  const result: string[] = [];
  for (let n = 0; result.length < count; n++) {
    const code = `Z${String(n).padStart(5, '0')}`;
    if (!taken.has(code)) result.push(code);
  }
  return result;
}
