// Dữ liệu SKU và số khả dụng từ module `product`, đi qua cổng §11.1 (#104 Q2). Gọi trong `withCompany`.
// Trường cân nặng, kích thước, mô tả do #110 thêm vào `getVariants`; chưa có thì đọc ra null: đẩy sản phẩm báo
// `dimensions_missing`. Khả dụng là cổng `availableOf` của inventory (Documents/21 mục 11.1).
import type { Decimal } from 'decimal.js';
import {
  availableOf,
  countedOf,
  type CreateFromPlatformResult,
  createProductsFromPlatform,
  fillProductFacts,
  productMediaGaps,
  visibleGroupIds,
  type FactsSource,
  getProductSpecs,
  getSpecFields,
  getVariants,
  type PlatformKind as CatalogPlatformKind,
  type PlatformProductInput,
  type ProductFacts,
  productImageUrls,
  productSizeChartUrls,
  standardPricesOf,
  type VariantSummary,
  attributeKindsOf,
} from '../../../product/index.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import type { CatalogSpecValue } from '../domain/spec-resolve.ts';
import type { PlatformKind } from '../domain/product-spec.ts';

/** Thông số của công ty (cổng `getSpecFields` của catalog, Documents/21 §11.3). */
export interface SpecFieldInfo {
  id: string;
  code: string;
  name: string;
  input: CatalogSpecValue['input'];
  unit: string | null;
  allowCustom: boolean;
  options: { id: string; value: string; position: number; scope?: DataScope }[];
  /** Tầng dữ liệu (dữ liệu chung, chốt 22/11/2026): `platform` là thông số chuẩn, ánh xạ sang sàn chỉ nền tảng sửa. */
  scope?: DataScope;
}

/** Dòng chuẩn của nền tảng (dùng chung mọi công ty) hay dòng riêng của công ty; thiếu thì coi là `company`. */
export type DataScope = 'platform' | 'company';

export interface ListingVariant {
  id: string;
  productId: string;
  productName: string;
  /** Mã cha của sản phẩm (#400 A5). */
  productCode: string;
  /** Nhóm hàng của sản phẩm (#448: category cùng nhóm). */
  groupId: string;
  sku: string;
  /** "Đen / M"; rỗng khi không có thuộc tính. */
  attributesLabel: string;
  /** Giá trị thuộc tính theo `position` (#400: ánh xạ trục biến thể sang sales attribute của sàn). */
  attributes: {
    attributeId: string;
    attributeName: string;
    platformKind: PlatformKind | null;
    valueId: string;
    value: string;
  }[];
  archived: boolean;
  /**
   * Trạng thái kinh doanh của SKU. Tới khi #204 trả `readiness`, `paused` là SKU chưa sẵn sàng đẩy (`sku_not_ready`, #219
   * A2; Documents/25 §6.3).
   */
  businessStatus: 'selling' | 'paused' | 'discontinued' | 'archived';
  description: string | null;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** Xuất xứ (ISO alpha-2), thương hiệu của sản phẩm cha ở catalog (#340); adapter đổi sang giá trị sàn (#400 A1). */
  originCountry?: string | null;
  brand?: string | null;
  /**
   * Ảnh phân loại theo giá trị ở thuộc tính gắn ảnh của catalog (#340); đẩy lên sàn làm ảnh của giá trị trục (#295). `url`
   * rỗng (máy chủ chưa cấu hình link ảnh) coi như không có.
   */
  image?: { attributeValueId: string; url: string } | null;
}

export interface ProductPort {
  /** Thuộc tính phân loại của công ty (#448); thiếu (bản giả của test) thì coi là không có thuộc tính nào. */
  attributes?(): Promise<{ id: string; name: string; platformKind: PlatformKind | null; scope?: DataScope }[]>;
  /** Bỏ trống `ids` = mọi biến thể của công ty; `opts.productIds` lọc theo sản phẩm, `[]` là rỗng (#400 A13). */
  variants(ids?: readonly string[], opts?: { productIds?: readonly string[] }): Promise<ListingVariant[]>;
  standardPrices(ids: readonly string[]): Promise<Map<string, Decimal | null>>;
  /** Có mọi biến thể của công ty (chưa có tồn thì 0); id lạ không có trong Map thì không đẩy tồn (#222). */
  availableOf(ids: readonly string[]): Promise<Map<string, number>>;
  /** SKU kho đã có số (#460); thiếu (bản giả của test) thì coi mọi SKU đã có số. */
  countedOf?(ids: readonly string[]): Promise<Set<string>>;
  /**
   * Link ảnh catalog theo sản phẩm (#303), tối đa `max` ảnh đầu theo thứ tự; sản phẩm chưa có ảnh (hoặc máy chủ chưa
   * cấu hình link ảnh) không có trong Map.
   */
  productImageUrls(productIds: readonly string[], max: number): Promise<Map<string, string[]>>;
  /** Link ảnh bảng kích cỡ theo sản phẩm (#347); sản phẩm chưa có ảnh không có trong Map. */
  productSizeChartUrls?(productIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Điền trường dùng chung đang trống của sản phẩm từ sàn (#497, Documents/21 §11.3); trả tên trường đã ghi. Thiếu (bản giả của
   * test) thì ghép không điền gì.
   */
  fillProductFacts?(productId: string, facts: ProductFacts, source: FactsSource): Promise<{ filled: string[] }>;
  /**
   * Tạo sản phẩm, biến thể từ SKU sàn (#500, Documents/21 §18.7.5) trong giao dịch của bên gọi. Thiếu (bản giả của test) thì
   * thiết lập trả 422 cho dòng `create`.
   */
  createFromPlatform?(
    caller: { companyId: string; accountId: string },
    groupId: string,
    products: readonly PlatformProductInput[],
    source: { shopId: string; shopName: string },
  ): Promise<CreateFromPlatformResult>;
  /**
   * Giá trị thông số của sản phẩm cha (cổng `getProductSpecs`, #509, Documents/21 §11.3), đã xếp theo mẫu nhóm. Thiếu (catalog
   * chưa có cổng, bản giả của test) thì không có thông số catalog nào để tự điền.
   */
  productSpecs?(productIds: readonly string[]): Promise<Map<string, { groupId: string | null; values: CatalogSpecValue[] }>>;
  /** Thư viện thông số của công ty (cổng `getSpecFields`, #509). Thiếu thì trang ánh xạ rỗng. */
  /** `companyId` khi gọi ngoài `withCompany` (seed lúc tạo công ty): lọc tường minh, không dựa vào RLS. */
  specFields?(opts?: { companyId?: string }): Promise<SpecFieldInfo[]>;
  /** Sản phẩm thiếu ảnh, thiếu bảng size (#498); thiếu (bản giả của test) thì ghép không tải ảnh sàn. */
  productMediaGaps?(productIds: readonly string[]): Promise<Map<string, { images: boolean; sizeChart: boolean }>>;
  /**
   * Danh mục còn và không bị công ty ẩn trong số `ids` (#569, gợi ý danh mục chuẩn theo category sàn). Gọi trong `withCompany`.
   * Cổng giả của test không có thì coi mọi id đều dùng được.
   */
  visibleGroupIds?(ids: readonly string[]): Promise<Set<string>>;
}

// Trường #110 sẽ thêm; đọc tuỳ chọn để code không đổi khi Khang merge.
type Extended = VariantSummary &
  Partial<Record<'description', string | null> & Record<'weightG' | 'lengthMm' | 'widthMm' | 'heightMm', number | null>>;

// Union kind của channel phải trùng catalog: catalog thêm kind mà channel chưa có (hay ngược lại) thì typecheck đỏ ở đây.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameKinds: Same<CatalogPlatformKind, PlatformKind> = true;
void sameKinds;

function toListingVariant(v: Extended): ListingVariant {
  return {
    id: v.id,
    productId: v.productId,
    productName: v.productName,
    productCode: v.productCode,
    groupId: v.groupId,
    sku: v.sku,
    attributesLabel: v.attributes.map((a) => a.value).join(' / '),
    attributes: v.attributes.map(({ attributeId, attributeName, platformKind, valueId, value }) => ({
      attributeId,
      attributeName,
      platformKind,
      valueId,
      value,
    })),
    archived: v.archived,
    businessStatus: v.businessStatus,
    description: v.description ?? null,
    weightG: v.weightG ?? null,
    lengthMm: v.lengthMm ?? null,
    widthMm: v.widthMm ?? null,
    heightMm: v.heightMm ?? null,
    originCountry: v.originCountry,
    brand: v.brand,
    image: v.image ? { attributeValueId: v.image.attributeValueId, url: v.image.url } : null,
  };
}

let override: ProductPort | null = null;

/**
 * Cổng thông số của catalog (#509, Documents/21 §11.3): `getProductSpecs`, `getSpecFields`. Không cần `ctx`, nên seed ánh xạ
 * (gọi từ core lúc tạo công ty) dùng được. Bản giả của test (`override`) thắng.
 */
export function catalogSpecPort(): Pick<ProductPort, 'productSpecs' | 'specFields'> {
  if (override) return override;
  return { productSpecs: getProductSpecs, specFields: getSpecFields };
}

export function productPort(ctx: ModuleContext): ProductPort {
  return (
    override ?? {
      attributes: attributeKindsOf,
      variants: async (ids, opts) => (await getVariants(ids, opts)).map(toListingVariant),
      standardPrices: (ids) => standardPricesOf(ctx, ids),
      availableOf,
      countedOf,
      productImageUrls,
      productSizeChartUrls,
      fillProductFacts,
      ...catalogSpecPort(),
      createFromPlatform: createProductsFromPlatform,
      productMediaGaps,
      visibleGroupIds,
    }
  );
}

/** Test thay cổng bằng bản giả, như `registerAdapter`. */
export function setProductPort(port: ProductPort | null): void {
  override = port;
}
