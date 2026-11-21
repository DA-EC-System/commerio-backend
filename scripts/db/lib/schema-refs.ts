// Cột uuid trỏ sang bảng khác mà không có khoá ngoại (Documents/19 D1: không đặt khoá ngoại chéo schema, chéo module
// con), cho tài liệu schema (db:docs).
//
// Thêm cột uuid tên `*_id` không có khoá ngoại thì khai bảng đích ở LOGICAL_REFS, hoặc lý do không trỏ bảng cố định ở
// NOT_REFS. Chưa khai thì db:docs báo lỗi; mục khai không còn khớp cột nào cũng báo (xoá đi). Cột `*_by` và
// ACTOR_COLUMNS là người thao tác (`core.accounts`), `company_id` là công ty (`core.companies`), không cần khai.

/**
 * Bảng đích của cột tham chiếu. Khoá theo tên cột chỉ dùng cho tên đúng quy ước `<tên bảng số ít>_id` (cột mới cùng tên
 * ở bảng khác tự nhận cùng bảng đích); tên mang nghĩa riêng khoá theo `<schema>.<bảng>.<cột>`, cột trùng tên ở bảng khác
 * sẽ phải khai lại. Khoá đầy đủ thắng khoá theo tên.
 */
export const LOGICAL_REFS: Readonly<Record<string, string>> = {
  // Theo quy ước tên.
  account_id: 'core.accounts',
  conversation_id: 'channel.conversations',
  customer_identity_id: 'order.customer_identities',
  file_id: 'core.files',
  membership_id: 'core.memberships',
  order_id: 'order.orders',
  order_line_id: 'order.order_lines',
  package_id: 'order.packages',
  payment_transaction_id: 'finance.payment_transactions',
  product_id: 'product.products',
  purchase_request_id: 'product.purchase_requests',
  return_request_id: 'order.return_requests',
  role_id: 'core.roles',
  shop_id: 'channel.shops',
  supplier_id: 'product.suppliers',
  variant_id: 'product.product_variants',
  // Ánh xạ thông số sang sàn (#509): thông số, lựa chọn ở schema product, channel dọn theo sự kiện catalog.
  'channel.spec_field_mappings.field_id': 'product.spec_fields',
  'channel.spec_option_mappings.option_id': 'product.spec_field_options',
  // Tên mang nghĩa riêng.
  'channel.axis_mappings.attribute_id': 'product.attributes',
  'channel.listings.pending_variant_id': 'product.product_variants',
  'channel.price_calculations.fee_version_id': 'finance.config_versions',
  'channel.price_calculations.min_margin_version_id': 'finance.config_versions',
  'channel.price_calculations.tax_regime_version_id': 'finance.config_versions',
  'channel.price_calculations.tax_version_id': 'finance.config_versions',
  'channel.shops.allocation_stocktake_id': 'product.stock_documents',
  'channel.shops.opening_stocktake_id': 'product.stock_documents',
  'finance.ledger_entries.config_version_id': 'finance.config_versions',
  'finance.unmatched_receipts.assigned_order_id': 'order.orders',
  'order.return_requests.inspection_id': 'product.stock_documents',
  'order.unmatched_return_parcels.inspection_id': 'product.stock_documents',
  'product.goods_receipts.follow_up_receipt_id': 'product.goods_receipts',
  'product.goods_receipts.follows_up_receipt_id': 'product.goods_receipts',
  'product.product_variants.source_request_line_id': 'product.purchase_request_lines',
  'product.products.size_chart_file_id': 'core.files',
  'product.purchase_product_drafts.size_chart_file_id': 'core.files',
  'product.purchase_request_lines.new_group_id': 'product.product_groups',
  'product.purchase_request_lines.new_parent_product_id': 'product.products',
  'product.purchase_requests.source_return_id': 'product.supplier_returns',
  'product.stock_document_lines.actual_variant_id': 'product.product_variants',
  'product.supplier_returns.replacement_request_id': 'product.purchase_requests',
};

/** Cột uuid không trỏ một bảng cố định, kèm lý do cho người đọc. Khoá như LOGICAL_REFS. */
export const NOT_REFS: Readonly<Record<string, string>> = {
  entity_id: 'đa hình: bảng đích theo cột `entity_type`',
  event_id: 'mã sự kiện của outbox, không phải khoá của bảng nào',
  family_id: 'họ refresh token: các token sinh từ cùng một lần đăng nhập',
  source_id: 'đa hình: chứng từ nguồn theo cột loại nguồn của bảng',
  source_line_id: 'đa hình: dòng của chứng từ nguồn',
  'channel.messages.sender_id': 'chưa có code ghi; tin đến (`inbound`) là của khách nên không trỏ cố định `core.accounts`',
};

/** Cột người thao tác không theo đuôi `_by`. */
export const ACTOR_COLUMNS: ReadonlySet<string> = new Set(['actor_id', 'assignee_id', 'author_id']);
export const ACTOR_TABLE = 'core.accounts';
export const TENANT_COLUMN = 'company_id';
export const TENANT_TABLE = 'core.companies';

/** Mã bên ngoài (sàn, cổng thanh toán), không phải khoá trong CSDL. */
const EXTERNAL = /^(external_|pending_external_|parent_external_)|^(gateway_txn_id|reverse_order_id|reject_reason_id|notification_id)$/;

export type ColumnRef =
  | { kind: 'logical'; table: string; key: string }
  | { kind: 'actor' | 'tenant'; table: string }
  | { kind: 'not-ref'; note: string; key: string }
  | { kind: 'external' }
  | { kind: 'unknown' }
  | { kind: 'plain' };

/**
 * Xếp loại một cột chưa có khoá ngoại. `type` là kiểu SQL như trong snapshot (`uuid`, `text`…). `soleKey`: cột là khoá
 * chính một cột của bảng (`id`), không phải tham chiếu; cột trong khoá chính ghép vẫn có thể trỏ bảng khác.
 * `unknown`: cột uuid tên `*_id` chưa khai ở LOGICAL_REFS hay NOT_REFS.
 */
export function classifyColumn(tableId: string, column: string, type: string, soleKey: boolean): ColumnRef {
  if (column === TENANT_COLUMN) return { kind: 'tenant', table: TENANT_TABLE };
  if (type === 'uuid' && !soleKey) {
    const full = `${tableId}.${column}`;
    if (LOGICAL_REFS[full]) return { kind: 'logical', table: LOGICAL_REFS[full], key: full };
    if (NOT_REFS[full]) return { kind: 'not-ref', note: NOT_REFS[full], key: full };
    if (column.endsWith('_by') || ACTOR_COLUMNS.has(column)) return { kind: 'actor', table: ACTOR_TABLE };
    if (LOGICAL_REFS[column]) return { kind: 'logical', table: LOGICAL_REFS[column], key: column };
    if (NOT_REFS[column]) return { kind: 'not-ref', note: NOT_REFS[column], key: column };
    if (column.endsWith('_id')) return { kind: 'unknown' };
  }
  if (EXTERNAL.test(column)) return { kind: 'external' };
  return { kind: 'plain' };
}

/** Mục khai trong LOGICAL_REFS, NOT_REFS không khớp cột nào (`used` là các `key` classifyColumn đã trả). */
export function unusedRefKeys(used: ReadonlySet<string>): string[] {
  return [...Object.keys(LOGICAL_REFS), ...Object.keys(NOT_REFS)].filter((k) => !used.has(k));
}
