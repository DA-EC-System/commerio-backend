// Danh mục và quy tắc SKU (UC-CP-01; Documents/21 5.1–5.3, P3, P4, V24, V25).
import { withCompany } from '../../../shared/db/client.ts';
import { recordAudit } from '../../audit/index.ts';
import {
  type CategoryRow,
  categoryNameExists,
  deleteCategoryIfVersion,
  findCategories,
  insertCategory,
  updateCategoryIfVersion,
} from '../repository/categories.ts';
import { auditOf, type Caller, inUse, isUuid, nameTaken, notFound, pgError, versionConflict } from './errors.ts';

export interface CategoryInput {
  name: string;
  skuPattern: string;
}

const ENTITY = 'catalog.categories';
const collator = new Intl.Collator('vi');
const taken = () => nameTaken('Đã có danh mục cùng tên');

function toView(c: CategoryRow) {
  return { ...c, updatedAt: c.updatedAt.toISOString() };
}
export type CategoryView = ReturnType<typeof toView>;

const snapshot = (c: CategoryInput) => ({ name: c.name, skuPattern: c.skuPattern });

async function findCategory(id: string): Promise<CategoryRow> {
  const [category] = isUuid(id) ? await findCategories(id) : [];
  if (!category) throw notFound('danh mục');
  return category;
}

const conflict = (current: CategoryRow) => versionConflict('Danh mục vừa được người khác sửa', toView(current));

/** Ghi có điều kiện version không trúng: người khác vừa sửa (409 kèm bản mới) hoặc vừa xoá (404). */
async function lostRace(id: string): Promise<never> {
  const [current] = await findCategories(id);
  throw current ? conflict(current) : notFound('danh mục');
}

/** Tên trùng lọt qua bước kiểm (hai người cùng tạo): unique index chặn người sau. */
function nameRace(err: unknown): never {
  throw pgError(err).code === '23505' ? taken() : err;
}

/** Sắp theo tên tiếng Việt như mock FE, không theo collation của DB (khác giữa máy và staging). */
export async function listCategories(companyId: string): Promise<CategoryView[]> {
  const rows = await withCompany(companyId, () => findCategories());
  return rows.sort((a, b) => collator.compare(a.name, b.name)).map(toView);
}

export async function createCategory(caller: Caller, input: CategoryInput): Promise<CategoryView> {
  return withCompany(caller.companyId, async () => {
    if (await categoryNameExists(input.name)) throw taken();
    const id = await insertCategory(caller.companyId, input.name, input.skuPattern);
    await recordAudit({ ...auditOf(caller, 'create', ENTITY, id), after: snapshot(input) });
    return toView(await findCategory(id));
  }).catch(nameRace);
}

export async function updateCategory(caller: Caller, id: string, input: CategoryInput & { version: number }) {
  return withCompany(caller.companyId, async () => {
    const category = await findCategory(id);
    if (category.version !== input.version) throw conflict(category);
    if (await categoryNameExists(input.name, id)) throw taken();
    // Đổi quy tắc chỉ áp dụng cho SKU sinh sau; SKU đã cấp giữ nguyên (P3).
    if (!(await updateCategoryIfVersion(id, input.version, input.name, input.skuPattern))) await lostRace(id);
    await recordAudit({ ...auditOf(caller, 'update', ENTITY, id), before: snapshot(category), after: snapshot(input) });
    return toView(await findCategory(id));
  }).catch(nameRace);
}

export async function deleteCategory(caller: Caller, id: string, version: number): Promise<void> {
  await withCompany(caller.companyId, async () => {
    const category = await findCategory(id);
    if (category.version !== version) throw conflict(category);
    // Kể cả sản phẩm đã lưu trữ: SKU đã cấp theo danh mục này (V25).
    if (category.productCount > 0) {
      throw inUse(`Không xoá được danh mục ${category.name} vì có ${category.productCount} sản phẩm đang dùng`);
    }
    if (!(await deleteCategoryIfVersion(id, version))) await lostRace(id);
    await recordAudit({ ...auditOf(caller, 'delete', ENTITY, id), before: snapshot(category) });
  }).catch((err: unknown) => {
    // Người khác vừa tạo sản phẩm trong danh mục này: khoá ngoại chặn xoá.
    if (pgError(err).code === '23503') throw inUse('Danh mục đang có sản phẩm dùng');
    throw err;
  });
}
