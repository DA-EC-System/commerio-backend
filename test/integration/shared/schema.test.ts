import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

/** Bảng của từng schema module lớn (Documents/19 mục 3, 79 bảng). Thêm bảng thì thêm vào đây. */
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
    'role_permissions',
    'roles',
    'state_transitions',
  ],
  product: [
    'attribute_values',
    'attributes',
    'categories',
    'doc_counters',
    'goods_receipt_lines',
    'goods_receipts',
    'product_channel_specs',
    'product_images',
    'product_variants',
    'products',
    'purchase_request_lines',
    'purchase_requests',
    'stock_document_lines',
    'stock_documents',
    'stock_levels',
    'stock_moves',
    'supplier_return_lines',
    'supplier_returns',
    'suppliers',
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
    'unmatched_return_parcels',
  ],
  finance: [
    'bank_matches',
    'config_versions',
    'doc_counters',
    'gateway_configs',
    'ledger_entries',
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
    'category_maps',
    'conversation_notes',
    'conversation_tags',
    'conversations',
    'listings',
    'message_channels',
    'messages',
    'price_calculations',
    'raw_orders',
    'shops',
    'tags',
    'webhook_events',
  ],
  insight: [
    'daily_channel_summary',
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
  const PERCENT_COLUMNS = ['product.product_variants.min_margin_pct', 'channel.price_calculations.margin_pct'];

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

  it.each([
    ['"order".order_source', 'insight.order_source'],
  ])('enum %s và %s cùng giá trị, cùng thứ tự (A5)', async (a, b) => {
    const labels = async (name: string) => {
      const res = await testPool().query<{ label: string }>(
        'select enumlabel as label from pg_enum where enumtypid = $1::regtype order by enumsortorder',
        [name],
      );
      return res.rows.map((r) => r.label);
    };
    const left = await labels(a);
    expect(left.length).toBeGreaterThan(0);
    expect(await labels(b)).toEqual(left);
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
