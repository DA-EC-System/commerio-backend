// db/VERSIONS.md: mỗi migration một phiên bản V<n> (vị trí trong journal), tóm tắt thay đổi từ chênh lệch giữa snapshot
// của nó và snapshot liền trước; migration viết tay (snapshot không đổi) tóm tắt từ nội dung SQL.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationKinds, readJournal, readSnapshot, snapshotName, versionLabel } from './journal.ts';
import type { DbSnapshot, SnapTable } from './schema-doc.ts';

const c = (s: string): string => `\`${s}\``;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Thêm, bỏ, đổi theo tên giữa hai tập đối tượng có tên (index, unique, check, khoá ngoại). */
function named<T>(label: string, before: Record<string, T> | undefined, after: Record<string, T> | undefined): string[] {
  const a = before ?? {};
  const b = after ?? {};
  const out: string[] = [];
  const added = Object.keys(b).filter((k) => !(k in a));
  const removed = Object.keys(a).filter((k) => !(k in b));
  const changed = Object.keys(b).filter((k) => k in a && canonical(a[k]) !== canonical(b[k]));
  if (added.length) out.push(`+ ${label} ${added.map(c).join(', ')}`);
  if (removed.length) out.push(`− ${label} ${removed.map(c).join(', ')}`);
  if (changed.length) out.push(`đổi ${label} ${changed.map(c).join(', ')}`);
  return out;
}

function tableDiff(before: SnapTable, after: SnapTable): string[] {
  const out: string[] = [];
  const colsA = before.columns;
  const colsB = after.columns;
  const added = Object.keys(colsB).filter((k) => !(k in colsA));
  const removed = Object.keys(colsA).filter((k) => !(k in colsB));
  if (added.length) out.push(`+ cột ${added.map(c).join(', ')}`);
  if (removed.length) out.push(`− cột ${removed.map(c).join(', ')}`);
  for (const name of Object.keys(colsB).filter((k) => k in colsA)) {
    const x = colsA[name]!;
    const y = colsB[name]!;
    const what: string[] = [];
    const typeOf = (col: typeof x): string => (col.typeSchema ? `${col.typeSchema}.${col.type}` : col.type);
    if (typeOf(x) !== typeOf(y)) what.push(`kiểu ${typeOf(x)} → ${typeOf(y)}`);
    if (x.notNull !== y.notNull) what.push(y.notNull ? 'thành not null' : 'thành null');
    if (canonical(x.default) !== canonical(y.default)) what.push(y.default === undefined ? 'bỏ mặc định' : `mặc định ${c(String(y.default))}`);
    if (x.primaryKey !== y.primaryKey) what.push(y.primaryKey ? 'thành khoá chính' : 'bỏ khoá chính');
    if (canonical(x.generated) !== canonical(y.generated)) what.push('đổi cột sinh');
    if (what.length) out.push(`đổi cột ${c(name)} (${what.join(', ')})`);
  }
  out.push(...named('khoá chính', before.compositePrimaryKeys, after.compositePrimaryKeys));
  out.push(...named('khoá ngoại', before.foreignKeys, after.foreignKeys));
  out.push(...named('unique', before.uniqueConstraints, after.uniqueConstraints));
  out.push(...named('index', before.indexes, after.indexes));
  out.push(...named('check', before.checkConstraints, after.checkConstraints));
  return out;
}

/** Nhóm tên theo schema: `+ 3 bảng `core`: a, b, c`. */
function grouped(sign: string, noun: string, ids: string[]): string[] {
  const bySchema = new Map<string, string[]>();
  for (const id of ids) {
    const [schema, name] = [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)];
    bySchema.set(schema, [...(bySchema.get(schema) ?? []), name]);
  }
  return [...bySchema].map(([schema, names]) =>
    names.length === 1 ? `${sign} ${noun} ${c(`${schema}.${names[0]}`)}` : `${sign} ${names.length} ${noun} ${c(schema)}: ${names.join(', ')}`,
  );
}

/** Thay đổi schema giữa hai snapshot, mỗi phần tử một dòng cho người đọc. */
export function diffSnapshots(prev: DbSnapshot | null, cur: DbSnapshot): string[] {
  const ta = prev?.tables ?? {};
  const tb = cur.tables;
  const out: string[] = [];
  out.push(...grouped('+', 'bảng', Object.keys(tb).filter((k) => !(k in ta))));
  out.push(...grouped('−', 'bảng', Object.keys(ta).filter((k) => !(k in tb))));
  for (const id of Object.keys(tb).filter((k) => k in ta)) {
    const parts = tableDiff(ta[id]!, tb[id]!);
    if (parts.length) out.push(`${c(id)}: ${parts.join('; ')}`);
  }
  const ea = prev?.enums ?? {};
  const eb = cur.enums;
  out.push(...grouped('+', 'enum', Object.keys(eb).filter((k) => !(k in ea))));
  out.push(...grouped('−', 'enum', Object.keys(ea).filter((k) => !(k in eb))));
  for (const id of Object.keys(eb).filter((k) => k in ea)) {
    const va = ea[id]!.values;
    const vb = eb[id]!.values;
    const added = vb.filter((v) => !va.includes(v));
    const removed = va.filter((v) => !vb.includes(v));
    const parts: string[] = [];
    if (added.length) parts.push(`+ ${added.map(c).join(', ')}`);
    if (removed.length) parts.push(`− ${removed.map(c).join(', ')}`);
    if (!parts.length && canonical(va) !== canonical(vb)) parts.push('đổi thứ tự giá trị');
    if (parts.length) out.push(`enum ${c(id)}: ${parts.join('; ')}`);
  }
  return out;
}

const DRIZZLE_PLACEHOLDER = /Custom SQL migration file, put your code below!/i;
/** Câu sửa dữ liệu ở đầu dòng; CTE thì phải có `<tên> AS (`, để không khớp `WITH CHECK` của `CREATE POLICY`. */
const DML = /^\s*(update|insert\s+into|delete\s+from)\b|^\s*with\s+(recursive\s+)?\w+\s+as\s*\(/im;
const SQL_KINDS: [string, RegExp][] = [
  ['extension', /\bcreate\s+extension\b/i],
  ['schema', /\bcreate\s+schema\b/i],
  ['RLS', /\benable\s+row\s+level\s+security\b|\bcreate\s+policy\b/i],
  ['quyền', /^\s*(grant|revoke)\b/im],
  ['hàm', /\bcreate\s+(or\s+replace\s+)?function\b/i],
  ['trigger', /\bcreate\s+(constraint\s+)?trigger\b/i],
  ['khoá ngoại', /\bforeign\s+key\b/i],
  ['EXCLUDE', /\bexclude\s+using\b/i],
  ['index', /\bcreate\s+(unique\s+)?index\b/i],
  ['dữ liệu', DML],
];

const lf = (s: string): string => s.replace(/\r\n?/g, '\n');

function stripSqlComments(sql: string): string {
  return lf(sql)
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

/** Câu đầu của khối comment `--` mở đầu file SQL (bỏ dòng mẫu của drizzle-kit). */
export function leadingSqlComment(sql: string): string {
  const lines: string[] = [];
  for (const raw of lf(sql).split('\n')) {
    const line = raw.trim();
    if (!line || DRIZZLE_PLACEHOLDER.test(line)) {
      if (lines.length) break;
      continue;
    }
    if (!line.startsWith('--')) break;
    lines.push(line.replace(/^--\s?/, ''));
  }
  const text = lines.join(' ').trim();
  const end = text.search(/\.(\s|$)/);
  const first = end >= 0 ? text.slice(0, end + 1) : text;
  return first.length > 240 ? `${first.slice(0, 239).trimEnd()}…` : first;
}

/** Loại câu lệnh trong một migration viết tay: RLS, quyền, trigger, dữ liệu… */
export function sqlKinds(sql: string): string[] {
  const body = stripSqlComments(sql);
  return SQL_KINDS.filter(([, re]) => re.test(body)).map(([label]) => label);
}

function vnDate(when: number): string {
  const d = new Date(when + 7 * 3600_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** Nội dung db/VERSIONS.md cho bộ migration `dir`, mới nhất trước. */
export function renderVersions(dir: string): string {
  const entries = readJournal(dir).entries;
  const kinds = migrationKinds(dir);
  const sections: string[][] = [];
  let prev: DbSnapshot | null = null;
  for (const entry of entries) {
    const snapshot = readSnapshot(dir, snapshotName(entry.tag)) as unknown as DbSnapshot;
    const sql = lf(readFileSync(join(dir, `${entry.tag}.sql`), 'utf8'));
    const kind = kinds.get(entry.tag);
    const comment = leadingSqlComment(sql);
    const lines: string[] = [];
    if (kind === 'custom') {
      const found = sqlKinds(sql);
      lines.push(`- viết tay${found.length ? `: ${found.join(', ')}` : ''}`);
    } else {
      const diff = diffSnapshots(prev, snapshot);
      if (diff.length) {
        lines.push(...diff.map((d) => `- ${d}`));
        if (DML.test(stripSqlComments(sql))) lines.push('- kèm câu sửa dữ liệu viết tay');
      } else {
        const found = sqlKinds(sql);
        lines.push(`- không đổi bảng, enum${found.length ? `; câu lệnh: ${found.join(', ')}` : ''}`);
      }
    }
    if (comment) lines.push(`- ${comment}`);
    const slug = entry.tag.slice(entry.tag.indexOf('_') + 1);
    sections.push([
      `## ${versionLabel(entry)} · ${vnDate(entry.when)} · ${slug}`,
      '',
      `${c(`db/migrations/${entry.tag}.sql`)} · ${kind === 'custom' ? 'viết tay' : 'sinh từ schema'}`,
      '',
      ...lines,
    ]);
    prev = snapshot;
  }
  const last = entries.at(-1);
  const out = [
    '# Phiên bản CSDL',
    '',
    '<!-- Sinh tự động bởi `npm run db:docs` từ db/migrations. Không sửa tay. -->',
    '',
    '`V<n>` là migration thứ n trong `db/migrations/meta/_journal.json`. Số không đổi sau khi merge vào `main`; migration của nhánh chưa merge mang số tạm, `npm run db:regen` có thể đẩy số lên.',
    `Mới nhất: **${last ? versionLabel(last) : 'chưa có'}**. Schema hiện tại: [SCHEMA.md](SCHEMA.md).`,
    '',
    ...sections.reverse().flatMap((s) => [...s, '']),
  ];
  return `${out.join('\n').trimEnd()}\n`;
}
