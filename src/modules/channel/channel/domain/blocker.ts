// BẢN TẠM (#567): chép kiểu của #564 (acn-26, feature/564-readiness, file này); rebase lên #564 thì bỏ bản này, dùng bản gốc.
/**
 * Chỗ sửa của một mục chặn hay một lỗi đẩy (Documents/21 §18.10 `BlockerTarget`, luật "Lỗi phải chỉ chỗ sửa"). FE đọc
 * `kind` để mở đúng hộp, đúng ô; dùng chung cho lỗi đẩy của sàn (#567) và độ sẵn sàng đăng (#564).
 */
export type BlockerTarget =
  | { kind: 'category' }
  | { kind: 'spec_attribute'; attributeCode: string }
  | { kind: 'axis'; attributeId?: string }
  | { kind: 'variant_field'; field: 'price' | 'weight' | 'dimensions' }
  | { kind: 'product_field'; field: 'images' | 'variantImages' | 'sizeChart' | 'name' }
  | { kind: 'shop'; field: 'fee_config' | 'category_permission' }
  | { kind: 'platform_product'; externalProductIds: string[] }
  | { kind: 'listing'; listingId: string | null };
