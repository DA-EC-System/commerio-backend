// Nhóm hàng (Documents/19 D11; 21 mục 5.2, 5.3, P6, V24, V25): một cấp, không gắn sàn, không gắn SKU.
import { withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import {
  deleteGroupIfVersion,
  findGroups,
  type GroupRow,
  groupNameExists,
  insertGroup,
  lockGroupProducts,
  setGroupHidden,
  setProductsGroup,
  updateGroupIfVersion,
  upsertGroupSettingsIfVersion,
} from '../repository/groups.ts';
import { copyTemplate, findGroupAxes } from '../repository/specs.ts';
import {
  auditOf,
  type Caller,
  inUse,
  invalid,
  isUuid,
  nameTaken,
  notFound,
  pgError,
  platformManaged,
  scopeOf,
  versionConflict,
} from './errors.ts';
import { columnsOf, mergeSuggest, NO_SUGGEST, type SuggestConfig, type SuggestPatch, suggestOf, withSuggest } from './suggest-config.ts';

export interface GroupInput {
  /** Bắt buộc với nhóm của công ty; nhóm nền tảng không đổi tên được (gửi thì 422). */
  name?: string | undefined;
  /** Bỏ trống là giữ cấu hình đang lưu (tạo mới là chưa đặt, tức theo công ty); gửi là thay cả năm giá trị. */
  suggest?: SuggestPatch | undefined;
  /** Chép trục chuẩn và mẫu thông số của nhóm này (#510, Documents/21 mục 5.5); `PUT` thay mẫu cũ. */
  copyTemplateFromGroupId?: string | undefined;
}

const ENTITY = 'product.product_groups';
const SETTINGS_ENTITY = 'product.company_group_settings';
const PRODUCT_ENTITY = 'product.products';
const collator = new Intl.Collator('vi');
const taken = () => nameTaken('Đã có nhóm hàng cùng tên');
const notInGroup = () => invalid({ productIds: 'Có sản phẩm không thuộc nhóm này' });
const badTarget = (message: string) => invalid({ targetGroupId: message });

type Axes = Awaited<ReturnType<typeof findGroupAxes>>;

function toView(g: GroupRow, axes: Axes) {
  return {
    id: g.id,
    name: g.name,
    scope: scopeOf(g.companyId),
    // Nhóm của công ty luôn `false` (chỉ ẩn được nhóm nền tảng).
    hidden: g.hidden,
    productCount: g.productCount,
    axes: (axes.get(g.id) ?? []).map((a) => ({ attributeId: a.attributeId, name: a.name, platformKind: a.platformKind, scope: scopeOf(a.companyId) })),
    specFieldCount: g.specFieldCount,
    requiredCount: g.requiredCount,
    renamedFrom: g.renamedFrom,
    splitInto: g.splitInto,
    suggest: suggestOf(g),
    updatedAt: g.updatedAt.toISOString(),
    version: g.version,
  };
}
export type GroupView = ReturnType<typeof toView>;

const snapshot = (name: string, suggest: SuggestConfig) => withSuggest({ name }, suggest);

async function findGroup(id: string): Promise<GroupRow> {
  const [group] = isUuid(id) ? await findGroups(id) : [];
  if (!group) throw notFound('nhóm hàng');
  return group;
}

const viewOf = async (g: GroupRow) => toView(g, await findGroupAxes([g.id]));
const conflict = async (current: GroupRow) => versionConflict('Nhóm hàng vừa được người khác sửa', await viewOf(current));

/** Nhóm nguồn để chép mẫu: đọc qua RLS, khác nhóm đích. */
async function templateSource(sourceId: string | undefined, targetId?: string): Promise<GroupRow | undefined> {
  if (sourceId === undefined) return undefined;
  const [source] = isUuid(sourceId) && sourceId !== targetId ? await findGroups(sourceId) : [];
  if (!source) throw invalid({ copyTemplateFromGroupId: 'Chọn nhóm khác để chép mẫu' });
  return source;
}

/** Ghi có điều kiện version không trúng: người khác vừa sửa (409 kèm bản mới) hoặc vừa xoá (404). */
async function lostRace(id: string): Promise<never> {
  const [current] = await findGroups(id);
  throw current ? await conflict(current) : notFound('nhóm hàng');
}

/** Tên trùng lọt qua bước kiểm (hai người cùng tạo): unique index chặn người sau. */
function nameRace(err: unknown): never {
  throw pgError(err).code === '23505' ? taken() : err;
}

/**
 * Nhóm nền tảng và nhóm của công ty, sắp theo tên tiếng Việt (không theo collation của DB, khác giữa máy và staging).
 * Mặc định bỏ nhóm nền tảng công ty đã ẩn; `includeHidden` thì trả cả (trang cài đặt bật lại).
 */
export async function listGroups(companyId: string, opts: { includeHidden?: boolean } = {}): Promise<{ items: GroupView[] }> {
  return withCompany(companyId, async () => {
    const rows = await findGroups(undefined, { includeHidden: opts.includeHidden ?? false });
    const axes = await findGroupAxes(rows.map((r) => r.id));
    return { items: rows.sort((a, b) => collator.compare(a.name, b.name)).map((g) => toView(g, axes)) };
  });
}

const NAME_REQUIRED = () => invalid({ name: 'Nhập tên nhóm hàng' });

export async function createGroup(caller: Caller, input: GroupInput): Promise<GroupView> {
  return withCompany(caller.companyId, async () => {
    if (input.name === undefined) throw NAME_REQUIRED();
    // Đọc qua RLS gồm cả nhóm nền tảng: tên trùng nhóm chuẩn cũng là trùng (khác tầng, service chặn).
    if (await groupNameExists(input.name)) throw taken();
    const source = await templateSource(input.copyTemplateFromGroupId);
    const suggest = mergeSuggest(NO_SUGGEST, input.suggest);
    const id = await insertGroup(caller.companyId, input.name, columnsOf(suggest));
    if (source) await copyTemplate(caller.companyId, source.id, id);
    await recordAudit({
      ...auditOf(caller, 'create', ENTITY, id),
      label: input.name,
      after: { ...snapshot(input.name, suggest), ...(source && { templateFrom: source.name }) },
    });
    return viewOf(await findGroup(id));
  }).catch(nameRace);
}

/** Nhóm nền tảng: công ty chỉ đặt gợi ý của mình (`company_group_settings`); không đổi tên, không chép mẫu. */
async function updatePlatformGroup(caller: Caller, group: GroupRow, input: GroupInput & { version: number }): Promise<GroupView> {
  const errors: Record<string, string> = {};
  if (input.name !== undefined) errors.name = 'Nhóm chuẩn không đổi tên được';
  if (input.copyTemplateFromGroupId !== undefined) errors.copyTemplateFromGroupId = 'Mẫu của nhóm chuẩn do nền tảng đặt';
  if (Object.keys(errors).length) throw invalid(errors);
  if (group.version !== input.version) throw await conflict(group);
  const suggest = mergeSuggest(suggestOf(group), input.suggest);
  if (!(await upsertGroupSettingsIfVersion(caller.companyId, group.id, input.version, columnsOf(suggest)))) await lostRace(group.id);
  await recordAudit({
    ...auditOf(caller, 'update', SETTINGS_ENTITY, group.id),
    label: group.name,
    before: snapshot(group.name, suggestOf(group)),
    after: snapshot(group.name, suggest),
  });
  return viewOf(await findGroup(group.id));
}

export async function updateGroup(caller: Caller, id: string, input: GroupInput & { version: number }): Promise<GroupView> {
  return withCompany(caller.companyId, async () => {
    const group = await findGroup(id);
    if (group.companyId === null) return updatePlatformGroup(caller, group, input);
    if (input.name === undefined) throw NAME_REQUIRED();
    if (group.version !== input.version) throw await conflict(group);
    if (await groupNameExists(input.name, id)) throw taken();
    const source = await templateSource(input.copyTemplateFromGroupId, id);
    const suggest = mergeSuggest(suggestOf(group), input.suggest);
    const name = input.name;
    if (!(await updateGroupIfVersion(id, input.version, name, columnsOf(suggest)))) await lostRace(id);
    if (source) await copyTemplate(caller.companyId, source.id, id);
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, id),
      label: name,
      before: snapshot(group.name, suggestOf(group)),
      after: { ...snapshot(name, suggest), ...(source && { templateFrom: source.name }) },
    });
    return viewOf(await findGroup(id));
  }).catch(nameRace);
}

/** Ẩn, hiện nhóm nền tảng cho công ty (chốt 2); không đụng sản phẩm đang ở nhóm. Nhóm của công ty: 422. */
export async function setHidden(caller: Caller, id: string, hidden: boolean): Promise<GroupView> {
  return withCompany(caller.companyId, async () => {
    const group = await findGroup(id);
    if (group.companyId !== null) throw invalid({ hidden: 'Chỉ ẩn được nhóm chuẩn của nền tảng' });
    if (group.hidden !== hidden) {
      await setGroupHidden(caller.companyId, id, hidden);
      await recordAudit({
        ...auditOf(caller, 'update', SETTINGS_ENTITY, id),
        label: group.name,
        before: { hidden: group.hidden },
        after: { hidden },
      });
    }
    return viewOf(await findGroup(id));
  });
}

export async function deleteGroup(caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    const group = await findGroup(id);
    if (group.companyId === null) throw platformManaged();
    if (group.version !== version) throw await conflict(group);
    // Kể cả sản phẩm đã lưu trữ (V25): chuyển sang nhóm khác bằng `move-products` rồi xoá.
    if (group.productCount > 0) {
      throw inUse(`Không xoá được nhóm ${group.name} vì có ${group.productCount} sản phẩm, chuyển sản phẩm sang nhóm khác trước`);
    }
    if (!(await deleteGroupIfVersion(id, version))) await lostRace(id);
    await recordAudit({ ...auditOf(caller, 'delete', ENTITY, id), label: group.name, before: snapshot(group.name, suggestOf(group)) });
  }).catch((err: unknown) => {
    // Người khác vừa thêm sản phẩm vào nhóm: khoá ngoại chặn xoá.
    if (pgError(err).code === '23503') throw inUse('Nhóm hàng đang có sản phẩm');
    throw err;
  });
}

/**
 * Chuyển sản phẩm (kể cả đã lưu trữ) sang nhóm khác (21 mục 5.2): một giao dịch, không tăng `version` của hai nhóm,
 * tăng `version` từng sản phẩm, ghi nhật ký `update` từng sản phẩm. SKU không đổi.
 */
export async function moveProducts(
  caller: Caller,
  sourceId: string,
  input: { targetGroupId: string; productIds?: string[] | undefined },
): Promise<{ moved: number }> {
  return withCompany(caller.companyId, async () => {
    const source = await findGroup(sourceId);
    if (input.targetGroupId === source.id) throw badTarget('Chọn nhóm khác nhóm hiện tại');
    // Đọc qua RLS: khoá ngoại bỏ qua RLS nên nhóm của công ty khác phải chặn ở đây.
    const [target] = isUuid(input.targetGroupId) ? await findGroups(input.targetGroupId) : [];
    if (!target) throw badTarget('Không tìm thấy nhóm hàng đích');
    const ids = input.productIds && [...new Set(input.productIds)];
    if (ids && !ids.every(isUuid)) throw notInGroup();
    const rows = await lockGroupProducts(source.id, ids);
    if (ids && rows.length !== ids.length) throw notInGroup();
    await setProductsGroup(
      rows.map((r) => r.id),
      target.id,
    );
    for (const r of rows) {
      await recordAudit({
        ...auditOf(caller, 'update', PRODUCT_ENTITY, r.id),
        label: r.name,
        before: { group: source.name },
        after: { group: target.name },
      });
    }
    return { moved: rows.length };
  }).catch((err: unknown) => {
    // Nhóm đích vừa bị xoá giữa lúc đọc và ghi.
    if (pgError(err).code === '23503') throw badTarget('Không tìm thấy nhóm hàng đích');
    throw err;
  });
}
