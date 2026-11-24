// npm run db:reset -- --dry-run   chạy hết rồi rollback, chỉ in số dòng sẽ xoá
// npm run db:reset -- --yes       xoá sạch dữ liệu của mọi công ty trên DATABASE_URL, giữ dữ liệu chuẩn của nền tảng.
// Dùng để test lại từ đầu (kết nối sàn, đơn, kiện) trên staging. Staging chỉ có dữ liệu thử (CLAUDE.md gốc).
// Chạy xong thì `npm run db:seed` để tạo lại Demo, Cách Ly, QA Hộp Đen A/B; workflow `Reset staging` làm cả hai bước.
//
// Giữ:
// - KEEP: bảng chuẩn của nền tảng, giữ nguyên cả bảng.
// - SHARED: bảng hai tầng (dữ liệu chuẩn dùng chung có company_id NULL, dòng công ty tự thêm có company_id).
//   Chỉ xoá dòng có company_id. Các bảng này không có khoá ngoại tới core.companies nên TRUNCATE công ty không lan sang.
// Xoá (TRUNCATE): mọi bảng còn lại trong các schema module, gồm công ty, tài khoản, gian hàng, đơn, kiện, tồn, sổ tiền.
// pg-boss: xoá mọi job, xoá lịch cron gắn shopId/companyId; giữ lịch chung (purge, category_sync).
//
// Bảng mới không có company_id mà chưa xếp vào danh sách nào thì dừng: có thể là dữ liệu chuẩn, không đoán.
// Cả việc chạy trong một transaction: lỗi giữa chừng thì không mất gì.
import pg from 'pg';

const MODULE_SCHEMAS = ['core', 'product', 'order', 'finance', 'channel', 'insight'];

const KEEP = new Set([
  'channel.marketplaces',
  'channel.platform_categories',
  'channel.platform_category_attributes',
  'core.permissions',
  'core.role_permissions', // dòng của vai công ty tự tạo đi theo ON DELETE CASCADE khi xoá vai
]);

// Thứ tự xoá: bảng con trước bảng cha (khoá ngoại RESTRICT ở group_spec_fields, product_groups).
const SHARED = [
  'channel.spec_option_mappings',
  'channel.spec_field_mappings',
  'product.group_spec_fields',
  'product.group_allowed_attributes',
  'product.product_groups',
  'product.spec_field_options',
  'product.attribute_values',
  'product.spec_fields',
  'product.attributes',
  'core.roles',
];

// Bảng không có company_id nhưng là dữ liệu của người dùng, xoá hết.
const TENANT_WITHOUT_COMPANY_ID = new Set([
  'core.accounts',
  'core.companies',
  'core.processed_events',
  'core.registrations',
]);

const quote = (qualified: string) =>
  qualified
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu DATABASE_URL.');
  process.exit(1);
}
const host = new URL(url).hostname;
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--yes')) {
  console.error(`Sẽ xoá dữ liệu của mọi công ty trên ${host}. Chạy lại với --yes nếu chắc chắn.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows: tables } = await client.query<{ name: string; has_company: boolean }>(
    `select t.table_schema || '.' || t.table_name as name,
            exists (select 1 from information_schema.columns c
                    where c.table_schema = t.table_schema and c.table_name = t.table_name
                      and c.column_name = 'company_id') as has_company
       from information_schema.tables t
      where t.table_type = 'BASE TABLE' and t.table_schema = any($1)
      order by 1`,
    [MODULE_SCHEMAS],
  );

  const names = new Set(tables.map((t) => t.name));
  const missing = [...KEEP, ...SHARED, ...TENANT_WITHOUT_COMPANY_ID].filter((n) => !names.has(n));
  if (missing.length) throw new Error(`Danh sách trong script trỏ tới bảng không còn: ${missing.join(', ')}`);

  const unclassified = tables.filter(
    (t) => !t.has_company && !KEEP.has(t.name) && !SHARED.includes(t.name) && !TENANT_WITHOUT_COMPANY_ID.has(t.name),
  );
  if (unclassified.length) {
    throw new Error(
      `Bảng chưa xếp loại (không có company_id): ${unclassified.map((t) => t.name).join(', ')}. ` +
        'Thêm vào KEEP nếu là dữ liệu chuẩn, TENANT_WITHOUT_COMPANY_ID nếu là dữ liệu người dùng.',
    );
  }

  const truncate = tables.map((t) => t.name).filter((n) => !KEEP.has(n) && !SHARED.includes(n));

  const count = async (table: string, where = '') =>
    (await client.query<{ n: number }>(`select count(*)::int as n from ${quote(table)} ${where}`)).rows[0]!.n;

  await client.query('begin');
  const report: Record<string, number> = {};
  for (const t of truncate) {
    const n = await count(t);
    if (n) report[t] = n;
  }
  // Không CASCADE: bảng nào ngoài danh sách còn trỏ tới bảng bị xoá thì PostgreSQL báo lỗi, transaction huỷ.
  await client.query(`truncate ${truncate.map(quote).join(', ')} restart identity`);

  for (const t of SHARED) {
    const { rowCount } = await client.query(`delete from ${quote(t)} where company_id is not null`);
    if (rowCount) report[`${t} (dòng của công ty)`] = rowCount;
  }

  const hasPgBoss = (await client.query(`select 1 from pg_namespace where nspname = 'pgboss'`)).rowCount;
  if (hasPgBoss) {
    const jobs = await client.query('delete from pgboss.job');
    const schedules = await client.query(`delete from pgboss.schedule where data ? 'shopId' or data ? 'companyId'`);
    if (jobs.rowCount) report['pgboss.job'] = jobs.rowCount;
    if (schedules.rowCount) report['pgboss.schedule (gắn shop/công ty)'] = schedules.rowCount;
  }
  await client.query(dryRun ? 'rollback' : 'commit');

  console.log(dryRun ? `Chạy thử trên ${host}, đã rollback. Số dòng sẽ xoá:` : `Đã reset ${host}. Số dòng đã xoá:`);
  for (const [table, n] of Object.entries(report)) console.log(`  ${table}: ${n}`);
  console.log(`Giữ nguyên: ${[...KEEP].join(', ')}; dòng company_id NULL của ${SHARED.join(', ')}.`);
  console.log('Bước tiếp: npm run db:seed (cần SEED_PASSWORD) để tạo lại tài khoản demo và QA.');
} catch (error) {
  await client.query('rollback').catch(() => {});
  // Lỗi của pg không chứa chuỗi kết nối; vẫn chỉ in message.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
