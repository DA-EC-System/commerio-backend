// Thư viện thông số của công ty (Documents/21 mục 5.5, 19 §3.2): CRUD, cổng `getSpecFields` cho channel.
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { publishEvent, recordAudit } from '../../../core/index.ts';
import { specCodeFromName, type SpecInputKind, uniqueSpecCode } from '../domain/specs.ts';
import {
  deleteOptions,
  deleteSpecFieldIfVersion,
  fieldHasValues,
  findSpecFields,
  groupsUsingField,
  insertOptions,
  insertSpecField,
  specCodesLike,
  specFieldNameExists,
  updateOption,
  updateSpecFieldIfVersion,
} from '../repository/specs.ts';
import { auditOf, type Caller, inUse, invalid, isUuid, nameTaken, notFound, pgError, versionConflict } from './errors.ts';

export interface SpecFieldCreate {
  code?: string | undefined;
  name: string;
  input: SpecInputKind;
  unit?: string | null | undefined;
  allowCustom: boolean;
  options?: { value: string }[] | undefined;
}

export interface SpecFieldUpdate {
  name: string;
  unit?: string | null | undefined;
  allowCustom: boolean;
  options?: { id?: string | undefined; value: string }[] | undefined;
  version: number;
}

type Row = Awaited<ReturnType<typeof findSpecFields>>[number];

const ENTITY = 'product.spec_fields';
const collator = new Intl.Collator('vi');
const taken = () => nameTaken('Đã có thông số cùng tên');
const codeTaken = () =>
  new AppError(409, 'code_taken', 'Mã đã được dùng', {
    errors: { code: 'Đã có thông số cùng mã' },
  });
const hasOptions = (input: SpecInputKind) => input === 'select' || input === 'multiselect';

function toView(r: Row) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    input: r.input,
    unit: r.unit,
    allowCustom: r.allowCustom,
    options: r.options.map((o) => ({
      id: o.id,
      value: o.value,
      position: o.position,
      inUse: o.inUse,
    })),
    groupCount: r.groupCount,
    productCount: r.productCount,
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}
export type SpecFieldView = ReturnType<typeof toView>;

const snapshot = (f: {
  name: string;
  unit?: string | null | undefined;
  allowCustom: boolean;
  options?: { value: string }[] | undefined;
}) => ({
  name: f.name,
  unit: f.unit ?? null,
  allowCustom: f.allowCustom,
  options: (f.options ?? []).map((o) => o.value),
});

async function findField(id: string): Promise<Row> {
  const [row] = isUuid(id) ? await findSpecFields(id) : [];
  if (!row) throw notFound('thông số');
  return row;
}

const conflict = (current: Row) => versionConflict('Thông số vừa được người khác sửa', toView(current));

async function lostRace(id: string): Promise<never> {
  const [current] = await findSpecFields(id);
  throw current ? conflict(current) : notFound('thông số');
}

function race(err: unknown): never {
  const { code, constraint } = pgError(err);
  if (code === '23505' && constraint === 'spec_fields_company_lower_name_uq') throw taken();
  if (code === '23505' && constraint === 'spec_fields_company_code_uq') throw codeTaken();
  if (code === '23505') throw invalid({ options: 'Có lựa chọn bị trùng' });
  if (code === '23503') throw inUse('Thông số hoặc lựa chọn đang được dùng');
  throw err;
}

/** Luật theo kiểu nhập mà Zod không biết hết: đơn vị chỉ cho `number`, lựa chọn chỉ cho select/multiselect. */
function shapeErrors(input: SpecInputKind, unit: string | null | undefined, options: unknown[] | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  if (unit && input !== 'number') errors.unit = 'Chỉ thông số kiểu số mới có đơn vị';
  if (options?.length && !hasOptions(input)) errors.options = 'Chỉ thông số chọn từ danh sách mới có lựa chọn';
  return errors;
}

/** Lựa chọn trùng nhau trong danh sách gửi lên (theo `lower(trim)`). */
function duplicateOption(options: readonly { value: string }[]): Record<string, string> {
  const seen = new Map<string, number>();
  for (const [i, o] of options.entries()) {
    const k = o.value.trim().toLowerCase();
    if (seen.has(k)) return { [`options.${i}`]: 'Trùng lựa chọn khác' };
    seen.set(k, i);
  }
  return {};
}

export async function listSpecFields(companyId: string): Promise<{ items: SpecFieldView[] }> {
  const rows = await withCompany(companyId, () => findSpecFields());
  return {
    items: rows.sort((a, b) => collator.compare(a.name, b.name)).map(toView),
  };
}

/** Cổng cho channel (Documents/21 mục 11.3): thư viện thông số, gọi trong `withCompany` của bên gọi. */
export async function getSpecFields() {
  const rows = await findSpecFields();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    input: r.input,
    unit: r.unit,
    allowCustom: r.allowCustom,
    options: r.options.map((o) => ({
      id: o.id,
      value: o.value,
      position: o.position,
    })),
  }));
}

export async function createSpecField(caller: Caller, input: SpecFieldCreate): Promise<SpecFieldView> {
  const options = input.options ?? [];
  const errors = {
    ...shapeErrors(input.input, input.unit, options),
    ...duplicateOption(options),
  };
  if (Object.keys(errors).length) throw invalid(errors);
  return withCompany(caller.companyId, async () => {
    if (await specFieldNameExists(input.name)) throw taken();
    let code = input.code;
    if (code) {
      if ((await specCodesLike(code)).has(code)) throw codeTaken();
    } else {
      const base = specCodeFromName(input.name);
      code = uniqueSpecCode(base, await specCodesLike(base));
    }
    const unit = input.input === 'number' ? (input.unit ?? null) : null;
    const id = await insertSpecField(caller.companyId, {
      code,
      name: input.name,
      input: input.input,
      unit,
      allowCustom: input.allowCustom,
    });
    await insertOptions(
      caller.companyId,
      id,
      options.map((o, position) => ({ value: o.value.trim(), position })),
    );
    await recordAudit({
      ...auditOf(caller, 'create', ENTITY, id),
      label: input.name,
      after: { code, input: input.input, ...snapshot(input) },
    });
    return toView(await findField(id));
  }).catch(race);
}

export async function updateSpecField(caller: Caller, id: string, input: SpecFieldUpdate): Promise<SpecFieldView> {
  return withCompany(caller.companyId, async () => {
    const field = await findField(id);
    if (field.version !== input.version) throw conflict(field);
    const options = input.options ?? [];
    const errors = {
      ...shapeErrors(field.input, input.unit, options),
      ...duplicateOption(options),
    };
    const current = new Map(field.options.map((o) => [o.id, o]));
    for (const [i, o] of options.entries()) {
      if (o.id !== undefined && !current.has(o.id)) errors[`options.${i}`] = 'Lựa chọn không thuộc thông số này';
    }
    const unit = field.input === 'number' ? (input.unit ?? null) : null;
    if (unit !== field.unit && (await fieldHasValues(id))) errors.unit = 'Đã có sản phẩm nhập số theo đơn vị cũ, tạo thông số mới';
    if (Object.keys(errors).length) throw invalid(errors);
    if (await specFieldNameExists(input.name, id)) throw taken();

    // Không gửi `options` (thông số chữ, số, ngày) thì giữ; gửi thì lựa chọn cũ vắng mặt là xoá.
    const kept = new Set(options.map((o) => o.id));
    const removed = hasOptions(field.input) && input.options !== undefined ? field.options.filter((o) => !kept.has(o.id)) : [];
    const removedInUse = removed.filter((o) => o.inUse);
    if (removedInUse.length) {
      throw new AppError(409, 'in_use', `Không xoá được ${removedInUse.map((o) => o.value).join(', ')} vì có sản phẩm đang dùng`, {
        errors: Object.fromEntries(removedInUse.map((o) => [`options.${field.options.indexOf(o)}`, 'Có sản phẩm đang dùng'])),
      });
    }
    if (
      !(await updateSpecFieldIfVersion(id, input.version, {
        name: input.name,
        unit,
        allowCustom: input.allowCustom,
      }))
    )
      await lostRace(id);

    if (hasOptions(field.input) && input.options !== undefined) {
      await deleteOptions(removed.map((o) => o.id));
      // Unique `(field_id, lower(value))` kiểm từng dòng: ghi chữ tạm cho dòng đổi chữ trước, rồi mới ghi chữ thật.
      const changed = options
        .map((o, position) => ({ ...o, position, value: o.value.trim() }))
        .filter((o): o is typeof o & { id: string } => o.id !== undefined);
      const renamed = changed.filter((o) => current.get(o.id)!.value !== o.value);
      for (const o of renamed) await updateOption(o.id, `~${o.id}`, o.position);
      for (const o of changed) {
        const old = current.get(o.id)!;
        if (old.value !== o.value || old.position !== o.position) await updateOption(o.id, o.value, o.position);
      }
      await insertOptions(
        caller.companyId,
        id,
        options.flatMap((o, position) => (o.id === undefined ? [{ value: o.value.trim(), position }] : [])),
      );
      if (removed.length) {
        await publishEvent({
          type: 'catalog.spec_option_deleted',
          aggregateId: id,
          payload: { fieldId: id, optionIds: removed.map((o) => o.id) },
        });
      }
    }
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, id),
      label: input.name,
      before: snapshot(field),
      after: snapshot({
        ...input,
        unit,
        options: input.options ?? field.options,
      }),
    });
    return toView(await findField(id));
  }).catch(race);
}

export async function deleteSpecField(caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    const field = await findField(id);
    if (field.version !== version) throw conflict(field);
    if (field.groupCount > 0 || field.productCount > 0) {
      throw new AppError(409, 'in_use', `Không xoá được thông số ${field.name} vì đang được dùng`, {
        groupCount: field.groupCount,
        productCount: field.productCount,
        groups: await groupsUsingField(id),
      });
    }
    if (!(await deleteSpecFieldIfVersion(id, version))) await lostRace(id);
    await publishEvent({
      type: 'catalog.spec_field_deleted',
      aggregateId: id,
      payload: { fieldId: id },
    });
    await recordAudit({
      ...auditOf(caller, 'delete', ENTITY, id),
      label: field.name,
      before: { code: field.code, ...snapshot(field) },
    });
  }).catch(race);
}
