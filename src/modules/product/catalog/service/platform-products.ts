// Tạo SKU kho từ SKU sàn ở bước thiết lập gian hàng (#500, Documents/21 §18.7.5). Channel gọi trong giao dịch hoàn tất
// thiết lập (`withCompany` của bên gọi), trước khi ghép listing. Mã SKU là SKU người bán trên sàn, không cấp theo mẫu.
import { recordAudit } from '../../../core/index.ts';
import { findGroups } from '../repository/groups.ts';
import { insertProduct, productCodeTaken, productNameExists } from '../repository/products.ts';
import { insertVariant, lockVariants, skuTaken } from '../repository/variants.ts';
import { checkAxes, createAxes } from './axes.ts';

/** Độ dài tối đa của SKU biến thể (`product_variants_sku_length`). */
export const PLATFORM_SKU_MAX = 50;
/** Trục của sản phẩm nhiều SKU tạo từ sàn: sàn không cho tên thuộc tính bán, chỉ có nhãn ("Trắng, M"). */
const AXIS_NAME = 'Phân loại';

export interface PlatformVariantInput {
  /** Khoá của bên gọi (mã SKU sàn) để trả lỗi, id biến thể theo dòng. */
  key: string;
  sku: string;
  /** Nhãn biến thể trên sàn; null thì dùng SKU làm giá trị trục. */
  label: string | null;
  /** Giá chuẩn: giá niêm yết trên sàn (chuỗi số, đồng); null là chưa đặt. */
  standardPrice: string | null;
  /** Giá muốn bán tính ngược từ giá sàn theo phí của gian hàng (bên gọi tính); null là chưa đặt. */
  targetNetPrice: string | null;
}

export interface PlatformProductInput {
  name: string;
  variants: PlatformVariantInput[];
}

export type CreateFromPlatformResult =
  | { ok: true; variantIds: Map<string, string>; productIds: string[] }
  | { ok: false; groupError: string | null; errors: Map<string, string> };

const lower = (s: string) => s.trim().toLowerCase();

async function freeName(name: string, firstSku: string, taken: Set<string>): Promise<string> {
  const base = name.trim();
  const free = async (n: string) => !taken.has(lower(n)) && !(await productNameExists(n));
  if (await free(base)) return base;
  const withSku = `${base} (${firstSku})`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? withSku : `${withSku}-${n}`;
    if (await free(candidate)) return candidate;
  }
}

async function freeCode(firstSku: string, taken: Set<string>): Promise<string> {
  for (let n = 1; ; n++) {
    const code = n === 1 ? firstSku : `${firstSku}-${n}`;
    if (!taken.has(code) && !(await productCodeTaken(code))) return code;
  }
}

/**
 * Mỗi phần tử `products` là một sản phẩm cha (các SKU cùng sản phẩm trên sàn). Kiểm dưới khoá SKU của công ty: nhóm
 * thuộc công ty, SKU chưa có trong công ty, không quá 50 ký tự, không trùng trong lô. Có lỗi thì không ghi gì. Tên trùng
 * sản phẩm đã có thì thêm ` (<SKU đầu>)`; mã cha là SKU đầu, trùng thì `-2`… Sản phẩm một SKU không có trục; nhiều SKU thì
 * trục "Phân loại", giá trị là nhãn, nhãn trống hoặc trùng trong sản phẩm thì là SKU. Ghi nhật ký mỗi sản phẩm.
 */
export async function createProductsFromPlatform(
  caller: { companyId: string; accountId: string },
  groupId: string,
  products: readonly PlatformProductInput[],
  source: { shopId: string; shopName: string },
): Promise<CreateFromPlatformResult> {
  await lockVariants(caller.companyId);
  const errors = new Map<string, string>();
  const group = (await findGroups()).find((g) => g.id === groupId);
  const seen = new Set<string>();
  for (const v of products.flatMap((p) => p.variants)) {
    const error = !v.sku
      ? 'SKU sàn chưa có SKU người bán'
      : v.sku.length > PLATFORM_SKU_MAX
        ? `SKU người bán dài quá ${PLATFORM_SKU_MAX} ký tự`
        : seen.has(v.sku)
          ? 'Hai SKU sàn cùng SKU người bán'
          : (await skuTaken(v.sku))
            ? 'SKU người bán đã là SKU kho, chọn liên kết thay vì tạo'
            : null;
    seen.add(v.sku);
    if (error) errors.set(v.key, error);
  }
  const groupError = group ? null : 'Nhóm hàng không thuộc công ty';
  if (groupError || errors.size) return { ok: false, groupError, errors };

  const variantIds = new Map<string, string>();
  const productIds: string[] = [];
  const names = new Set<string>();
  const codes = new Set<string>();
  for (const p of products) {
    const first = p.variants[0]!;
    const name = await freeName(p.name, first.sku, names);
    const code = await freeCode(first.sku, codes);
    names.add(lower(name));
    codes.add(code);
    let combos: string[][] = p.variants.map(() => []);
    if (p.variants.length > 1) {
      const labels = p.variants.map((v) => v.label?.trim() || v.sku);
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(lower(l), (counts.get(lower(l)) ?? 0) + 1);
      const values = labels.map((l, i) => (counts.get(lower(l))! > 1 ? p.variants[i]!.sku : l));
      const axes = [{ name: AXIS_NAME, values: values.map((value) => ({ value })) }];
      const checked = await checkAxes(axes);
      const axisError = Object.values(checked.errors)[0];
      if (axisError) return { ok: false, groupError: null, errors: new Map(p.variants.map((v) => [v.key, axisError])) };
      const [axis] = await createAxes(caller.companyId, axes, checked.found);
      combos = values.map((value) => [axis!.values.get(lower(value))!.id]);
    }
    const productId = await insertProduct(caller.companyId, groupId, name, '', code);
    productIds.push(productId);
    for (const [k, v] of p.variants.entries()) variantIds.set(
        v.key,
        // Không phát `catalog.variant_price_changed`: giá đặt lúc tạo, không phải đổi giá (channel không chạy lại bộ lọc).
        await insertVariant(caller.companyId, productId, v.sku, combos[k]!, k, null, {
          standardPrice: v.standardPrice,
          targetNetPrice: v.targetNetPrice,
        }),
      );
    await recordAudit({
      companyId: caller.companyId,
      actorId: caller.accountId,
      action: 'create',
      entityType: 'product.products',
      entityId: productId,
      label: name,
      before: null,
      after: {
        name,
        code,
        group: group!.name,
        variants: p.variants.map((v) => ({ sku: v.sku, standardPrice: v.standardPrice, targetNetPrice: v.targetNetPrice })),
        fromShop: { id: source.shopId, name: source.shopName },
      },
    });
  }
  return { ok: true, variantIds, productIds };
}
