// API công khai của module `catalog`: nhóm hàng, cài đặt sản phẩm, thuộc tính, sản phẩm, biến thể, quy tắc SKU.
// Module khác chỉ được import từ file này.
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerCatalogOpenApi } from './api/openapi.ts';
import { catalogRouter } from './api/routes.ts';

export const catalogModule: ModuleDefinition = {
  name: 'catalog',
  router: catalogRouter,
  openapi: registerCatalogOpenApi,
};

export { getVariants, type VariantSummary } from './service/variants.ts';
export { hasCatalogData } from './repository/variants.ts';
// Dữ liệu có sẵn của công ty mới (#447, Documents/21 mục 11.3); core gọi qua `ModuleContext` lúc đăng ký.
export { seedCompanyDefaults } from './service/seed.ts';
export { DEFAULT_ATTRIBUTES, DEFAULT_GROUPS } from './domain/defaults.ts';
/** Độ hoàn thiện theo SKU (#204); `product/index.ts` ghép với ngưỡng tồn thành `variantReadiness` cho channel. */
export { variantReadinessOf } from './service/labels.ts';
// Sửa hàng loạt có gợi ý (#242): dữ liệu của purchasing, inventory, sales vào qua cổng này (src/modules/product/index.ts).
export type { BulkEditContext, BulkEditPorts } from './service/bulk-edit.ts';
// Sản phẩm mới từ đề nghị nhập (#108, #243): purchasing kiểm khi lập, tạo khi duyệt, trong giao dịch của purchasing.
export {
  groupNames,
  createPurchaseProducts,
  normalizeName,
  type NewProductErrors,
  type NewProductItem,
  type NewProductOption,
  parentProducts,
  validateNewProducts,
} from './service/purchase-products.ts';
// Giá chuẩn và giá muốn bán là cột của SKU (Documents/19 D9); channel đọc giá muốn bán cho bộ lọc giá (#225).
export { standardPricesOf, targetNetPricesOf } from './service/standard-price.ts';
// `ctx` của catalog: nguồn lý do chặn lưu trữ SKU do `product/index.ts` và `src/wiring.ts` nối (#204).
export type { ArchiveBlockerSource, CatalogContext } from './service/usage.ts';
// Link ảnh sản phẩm cho channel (ảnh đại diện của listing, ảnh đẩy lên sàn; #303).
export { productImageUrls, productSizeChartUrls } from './service/product-images.ts';
// Hệ thống tự khôi phục SKU lưu trữ khi có hàng vào; inventory gọi trong `applyChange` (#204).
export { restoreArchivedBySystem } from './service/business-status.ts';
// Tạo SKU kho từ SKU sàn lúc thiết lập gian hàng (#500); channel gọi qua `ProductPort` trong giao dịch hoàn tất.
export {
  createProductsFromPlatform,
  type CreateFromPlatformResult,
  PLATFORM_SKU_MAX,
  type PlatformProductInput,
} from './service/platform-products.ts';
export { fillProductFacts, productMediaGaps, type FactsSource, type ProductFacts, type VariantFacts } from './service/product-facts.ts';
// Thông số sản phẩm (#510, Documents/21 mục 11.3): channel đọc giá trị, thư viện (ánh xạ, đẩy sàn) trong `withCompany` của mình.
export { getProductSpecs } from './service/product-specs.ts';
export { getSpecFields } from './service/spec-fields.ts';
export { DEFAULT_GROUP_TEMPLATES, DEFAULT_SPEC_FIELDS, type DefaultSpecField } from './domain/spec-defaults.ts';
export { PLATFORM_KINDS, type PlatformKind, SPEC_INPUTS } from './domain/specs.ts';
