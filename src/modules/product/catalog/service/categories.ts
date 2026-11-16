// Danh mục và quy tắc SKU (UC-CP-01; Documents/21 5.1–5.3, P3, P4, V24, V25).
import { withCompany } from '../../../../shared/db/client.ts';
import { recordAudit } from '../../../core/index.ts';
import {
  type CategoryRow,
  categoryNameExists,
  deleteCategoryIfVersion,
  findCategories,
  insertCategory,
  updateCategoryIfVersion,
} from '../repository/categories.ts';
import { auditOf, type Caller, inUse, isUuid, nameTaken, notFound, pgError, versionConflict } from './errors.ts';

/** Cấu hình gợi ý khi sửa hàng loạt (#242); `null` là chưa đặt. Hệ số là số thực (1,4 = lãi 40%). */
export interface SuggestConfig {
  marginCoefficient: number | null;
  priceRounding: number | null;
  reorderLeadDays: number | null;
  reorderSafetyQty: number | null;
  reorderDefaultQty: number | null;
}

export interface CategoryInput {
  name: string;
  skuPattern: string;
  /** Bỏ trống là giữ cấu hình đang lưu (tạo mới thì là chưa đặt); gửi là thay cả năm giá trị. */
  suggest?: SuggestConfig | undefined;
}

const ENTITY = 'product.categories';
const collator = new Intl.Collator('vi');
const taken = () => nameTaken('Đã có danh mục cùng tên');

/** Cấu hình gợi ý của một dòng danh mục, hệ số ra số thực. */
export function suggestOf(c: CategoryRow): SuggestConfig {
  return {
    marginCoefficient: c.marginCoefficient === null ? null : Number(c.marginCoefficient),
    priceRounding: c.priceRounding,
    reorderLeadDays: c.reorderLeadDays,
    reorderSafetyQty: c.reorderSafetyQty,
    reorderDefaultQty: c.reorderDefaultQty,
  };
}

function toView(c: CategoryRow) {
  return {
    id: c.id,
    name: c.name,
    skuPattern: c.skuPattern,
    skuNextSeq: c.skuNextSeq,
    suggest: suggestOf(c),
    productCount: c.productCount,
    version: c.version,
    updatedAt: c.updatedAt.toISOString(),
  };
}
export type CategoryView = ReturnType<typeof toView>;

const NO_SUGGEST: SuggestConfig = {
  marginCoefficient: null,
  priceRounding: null,
  reorderLeadDays: null,
  reorderSafetyQty: null,
  reorderDefaultQty: null,
};
const columnsOf = (s: SuggestConfig) => ({ ...s, marginCoefficient: s.marginCoefficient === null ? null : s.marginCoefficient.toFixed(2) });

/** Nhật ký chỉ nêu cấu hình gợi ý khi có giá trị nào đặt, để danh mục chưa dùng tính năng này giữ nguyên dạng cũ. */
const snapshot = (c: { name: string; skuPattern: string }, suggest: SuggestConfig) => ({
  name: c.name,
  skuPattern: c.skuPattern,
  ...(Object.values(suggest).some((v) => v !== null) && { suggest }),
});

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
    const suggest = input.suggest ?? NO_SUGGEST;
    const id = await insertCategory(caller.companyId, input.name, input.skuPattern, columnsOf(suggest));
    await recordAudit({ ...auditOf(caller, 'create', ENTITY, id), after: snapshot(input, suggest) });
    return toView(await findCategory(id));
  }).catch(nameRace);
}

export async function updateCategory(caller: Caller, id: string, input: CategoryInput & { version: number }) {
  return withCompany(caller.companyId, async () => {
    const category = await findCategory(id);
    if (category.version !== input.version) throw conflict(category);
    if (await categoryNameExists(input.name, id)) throw taken();
    // Đổi quy tắc chỉ áp dụng cho SKU sinh sau; SKU đã cấp giữ nguyên (P3).
    const suggest = input.suggest ?? suggestOf(category);
    if (!(await updateCategoryIfVersion(id, input.version, input.name, input.skuPattern, columnsOf(suggest)))) await lostRace(id);
    await recordAudit({
      ...auditOf(caller, 'update', ENTITY, id),
      before: snapshot(category, suggestOf(category)),
      after: snapshot(input, suggest),
    });
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
    await recordAudit({ ...auditOf(caller, 'delete', ENTITY, id), before: snapshot(category, suggestOf(category)) });
  }).catch((err: unknown) => {
    // Người khác vừa tạo sản phẩm trong danh mục này: khoá ngoại chặn xoá.
    if (pgError(err).code === '23503') throw inUse('Danh mục đang có sản phẩm dùng');
    throw err;
  });
}
