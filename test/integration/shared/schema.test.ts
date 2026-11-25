import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

/** Bảng của từng schema module lớn (Documents/19 mục 3; #510 thêm 4 bảng thông số ở `product`). Thêm bảng thì thêm vào đây. */
const EXPECTED_TABLES: Record<string, readonly string[]> = {
  core: [
    'accounts',
    'attachments',
    'audit_logs',
    'companies',
    'company_modules',
    'files',
    'invitations',
    'member_roles',
    'memberships',
    'outbox_messages',
    'permissions',
    'processed_events',
    'refresh_tokens',
    'registrations',
    'role_permissions',
    'roles',
    'state_transitions',
  ],
  product: [
    'attribute_values',
    'attributes',
    'company_group_settings',
    'company_product_settings',
    'doc_counters',
    'goods_receipt_lines',
    'goods_receipts',
    'group_allowed_attributes',
    'group_spec_fields',
    'product_attribute_value_images',
    'product_groups',
    'product_images',
    'product_spec_values',
    'product_variants',
    'products',
    'purchase_product_drafts',
    'purchase_request_lines',
    'purchase_requests',
    'spec_field_options',
    'spec_fields',
    'stock_document_lines',
    'stock_documents',
    'stock_levels',
    'stock_moves',
    'supplier_return_lines',
    'supplier_returns',
    'suppliers',
    // Bảng tạm của migration hai tầng (#521); migration channel đọc rồi xoá.
    'variant_attribute_values',
  ],
  order: [
    'customer_identities',
    'customers',
    'doc_counters',
    'order_lines',
    'orders',
    'package_lines',
    'packages',
    'return_request_lines',
    'return_requests',
    'unmatched_return_parcel_lines',
    'unmatched_return_parcels',
  ],
  finance: [
    'bank_matches',
    'config_versions',
    'doc_counters',
    'fee_templates',
    'gateway_configs',
    'ledger_entries',
    'ledger_package_lines',
    'ledger_replacements',
    'order_payments',
    'order_settlements',
    'payment_links',
    'payment_transactions',
    'payment_vouchers',
    'receipts',
    'sales_invoice_lines',
    'sales_invoices',
    'settlement_batches',
    'settlement_lines',
    'settlement_statements',
    'supplier_invoices',
    'unmatched_receipts',
    'webhook_events',
  ],
  channel: [
    'api_usage',
    'axis_mappings',
    'conversation_notes',
    'conversation_tags',
    'conversations',
    'listing_sync_runs',
    'listings',
    'marketplaces',
    'message_channels',
    'messages',
    'platform_categories',
    'platform_category_attributes',
    'platform_category_group_maps',
    'price_calculations',
    'product_specs',
    'raw_orders',
    'remote_skus',
    'shop_category_permissions',
    'shop_products',
    'shop_reauth_mails',
    'shops',
    'spec_field_mappings',
    'spec_option_mappings',
    'tags',
    'webhook_events',
  ],
  insight: [
    'document_chunks',
    'document_roles',
    'documents',
  ],
};

// Hình dạng schema sau khi chạy đủ migration trên DB trống (AC-7).
describe('schema sau migration', () => {
  it.each(Object.entries(EXPECTED_TABLES))('schema %s có đủ bảng theo ERD', async (schema, expected) => {
    const res = await testPool().query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE' order by 1`,
      [schema],
    );
    expect(res.rows.map((r) => r.table_name)).toEqual(expected);
  });

  // Cột tỉ lệ phần trăm (biên lãi) không phải tiền.
  const PERCENT_COLUMNS = [
    'product.product_variants.min_margin_pct',
    'channel.price_calculations.margin_pct',
    'channel.price_calculations.fee_pct',
    'channel.price_calculations.tax_pct',
    'channel.price_calculations.min_margin_pct',
  ];

  it('mọi cột numeric là numeric(18,2), trừ cột tỉ lệ phần trăm', async () => {
    const res = await testPool().query<{ col: string; p: number | null; s: number | null }>(
      `select table_schema || '.' || table_name || '.' || column_name as col,
              numeric_precision as p, numeric_scale as s
       from information_schema.columns
       where data_type = 'numeric' and table_schema not in ('pg_catalog', 'information_schema')`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
    const odd = res.rows.filter((r) => r.p !== 18 || r.s !== 2).map((r) => r.col);
    expect(odd.sort()).toEqual([...PERCENT_COLUMNS].sort());
  });

  it('không có khoá ngoại chéo schema (19-D1)', async () => {
    const res = await testPool().query<{ name: string }>(
      `select conname as name from pg_constraint c
       join pg_class src on src.oid = c.conrelid
       join pg_class dst on dst.oid = c.confrelid
       where c.contype = 'f' and src.relnamespace <> dst.relnamespace`,
    );
    expect(res.rows.map((r) => r.name)).toEqual([]);
  });
});
