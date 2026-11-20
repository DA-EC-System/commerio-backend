// Quan hệ giữa các bảng cho tài liệu schema (db:docs): khoá ngoại viết tay trong migration (drizzle-kit không thấy nên
// snapshot không có), và cột uuid trỏ sang bảng khác mà không có khoá ngoại (Documents/19 D1: không đặt khoá ngoại chéo
// schema, chéo module con).
//
// Thêm cột uuid tên `*_id` không có khoá ngoại thì khai ở LOGICAL_REFS (trỏ tới bảng nào) hoặc NOT_REFS (không trỏ bảng
// cố định); db:docs báo lỗi cột chưa khai. Cột `*_by` và ACTOR_COLUMNS là người thao tác (`core.accounts`), `company_id`
// là công ty (`core.companies`), không cần khai.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from './journal.ts';

/**
 * Cột trỏ sang bảng khác không có khoá ngoại. Khoá là tên cột, hoặc `<schema>.<bảng>.<cột>` khi một bảng dùng tên cột đó
 * với nghĩa khác (khoá đầy đủ thắng).
 */
export const LOGICAL_REFS: Readonly<Record<string, string>> = {
  account_id: 'core.accounts',
  actual_variant_id: 'product.product_variants',
  allocation_stocktake_id: 'product.stock_documents',
  assigned_order_id: 'order.orders',
  attribute_id: 'product.attributes',
  attribute_value_id: 'product.attribute_values',
  config_version_id: 'finance.config_versions',
  conversation_id: 'channel.conversations',
  customer_identity_id: 'order.customer_identities',
  fee_version_id: 'finance.config_versions',
  file_id: 'core.files',
  follow_up_receipt_id: 'product.goods_receipts',
  follows_up_receipt_id: 'product.goods_receipts',
  inspection_id: 'product.stock_documents',
  membership_id: 'core.memberships',
  min_margin_version_id: 'finance.config_versions',
  new_category_id: 'product.categories',
  opening_stocktake_id: 'product.stock_documents',
  order_id: 'order.orders',
  order_line_id: 'order.order_lines',
  package_id: 'order.packages',
  payment_transaction_id: 'finance.payment_transactions',
  pending_variant_id: 'product.product_variants',
  product_id: 'product.products',
  purchase_request_id: 'product.purchase_requests',
  replacement_request_id: 'product.purchase_requests',
  return_request_id: 'order.return_requests',
  role_id: 'core.roles',
  shop_id: 'channel.shops',
  size_chart_file_id: 'core.files',
  source_request_line_id: 'product.purchase_request_lines',
  source_return_id: 'product.supplier_returns',
  supplier_id: 'product.suppliers',
  tax_regime_version_id: 'finance.config_versions',
  tax_version_id: 'finance.config_versions',
  variant_id: 'product.product_variants',
};

/** Cột uuid tên `*_id` không trỏ một bảng cố định, kèm lý do để người đọc biết. */
export const NOT_REFS: Readonly<Record<string, string>> = {
  entity_id: 'đa hình: bảng đích theo cột `entity_type`',
  event_id: 'mã sự kiện của outbox, không phải khoá của bảng nào',
  family_id: 'họ refresh token: các token sinh từ cùng một lần đăng nhập',
  source_id: 'đa hình: chứng từ nguồn theo cột loại nguồn của bảng',
  source_line_id: 'đa hình: dòng của chứng từ nguồn',
};

/** Cột người thao tác không theo đuôi `_by`. */
export const ACTOR_COLUMNS: ReadonlySet<string> = new Set(['actor_id', 'assignee_id', 'author_id', 'sender_id']);
export const ACTOR_TABLE = 'core.accounts';
export const TENANT_COLUMN = 'company_id';
export const TENANT_TABLE = 'core.companies';

/** Mã bên ngoài (sàn, cổng thanh toán), không phải khoá trong CSDL. */
const EXTERNAL = /^(external_|pending_external_|parent_external_)|^(gateway_txn_id|reverse_order_id|reject_reason_id|notification_id)$/;

export type ColumnRef =
  | { kind: 'logical' | 'actor' | 'tenant'; table: string }
  | { kind: 'not-ref'; note: string }
  | { kind: 'external' }
  | { kind: 'unknown' }
  | { kind: 'plain' };

/**
 * Xếp loại một cột chưa có khoá ngoại. `unknown`: cột uuid tên `*_id` chưa khai ở LOGICAL_REFS hay NOT_REFS.
 * `type` là kiểu SQL như trong snapshot (`uuid`, `text`…).
 */
export function classifyColumn(tableId: string, column: string, type: string, primaryKey: boolean): ColumnRef {
  if (column === TENANT_COLUMN) return { kind: 'tenant', table: TENANT_TABLE };
  if (type === 'uuid' && !primaryKey) {
    if (column.endsWith('_by') || ACTOR_COLUMNS.has(column)) return { kind: 'actor', table: ACTOR_TABLE };
    const target = LOGICAL_REFS[`${tableId}.${column}`] ?? LOGICAL_REFS[column];
    if (target) return { kind: 'logical', table: target };
    const note = NOT_REFS[`${tableId}.${column}`] ?? NOT_REFS[column];
    if (note) return { kind: 'not-ref', note };
    if (column.endsWith('_id')) return { kind: 'unknown' };
  }
  if (EXTERNAL.test(column)) return { kind: 'external' };
  return { kind: 'plain' };
}

export interface SqlForeignKey {
  name: string;
  from: string;
  fromCols: string[];
  to: string;
  toCols: string[];
  onDelete: string | null;
  /** Tên file migration (không đuôi) thêm khoá ngoại. */
  migration: string;
}

const IDENT = String.raw`(?:"[^"]+"|\w+)`;
const QUALIFIED = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const ADD_FK = new RegExp(
  String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?${QUALIFIED}\s+ADD\s+CONSTRAINT\s+(${IDENT})\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+${QUALIFIED}\s*\(([^)]*)\)` +
    String.raw`(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))?`,
  'gi',
);
const DROP_CONSTRAINT = new RegExp(String.raw`DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, 'gi');

const unquote = (s: string): string => s.trim().replace(/^"|"$/g, '');
const qualified = (s: string): string => s.split('.').map(unquote).join('.');
const columnList = (s: string): string[] => s.split(',').map(unquote).filter(Boolean);

/** Khoá ngoại thêm bằng `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` trong một file SQL, theo thứ tự xuất hiện. */
export function parseForeignKeys(sql: string, migration: string): { added: SqlForeignKey[]; dropped: string[] } {
  const added: SqlForeignKey[] = [];
  for (const m of sql.matchAll(ADD_FK)) {
    added.push({
      from: qualified(m[1]!),
      name: unquote(m[2]!),
      fromCols: columnList(m[3]!),
      to: qualified(m[4]!),
      toCols: columnList(m[5]!),
      onDelete: m[6] ? m[6].toLowerCase().replace(/\s+/g, ' ') : null,
      migration,
    });
  }
  const dropped = [...sql.matchAll(DROP_CONSTRAINT)].map((m) => unquote(m[1]!));
  return { added, dropped };
}

/**
 * Khoá ngoại viết tay còn hiệu lực: thêm trong migration theo thứ tự journal, chưa bị `DROP CONSTRAINT`, cả hai bảng còn
 * trong `tableIds`, tên không trùng khoá ngoại drizzle đã biết (`knownNames`, lấy từ snapshot).
 */
export function handWrittenForeignKeys(dir: string, tableIds: ReadonlySet<string>, knownNames: ReadonlySet<string>): SqlForeignKey[] {
  const live = new Map<string, SqlForeignKey>();
  for (const entry of readJournal(dir).entries) {
    const { added, dropped } = parseForeignKeys(readFileSync(join(dir, `${entry.tag}.sql`), 'utf8'), entry.tag);
    for (const name of dropped) live.delete(name);
    for (const fk of added) live.set(fk.name, fk);
  }
  return [...live.values()].filter((fk) => !knownNames.has(fk.name) && tableIds.has(fk.from) && tableIds.has(fk.to));
}
