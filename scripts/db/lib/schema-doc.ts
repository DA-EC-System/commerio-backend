// Tài liệu schema cho người và agent (db:docs): db/SCHEMA.md (mục lục, bảng đã bỏ) và db/schema/<schema>.md (cột,
// ràng buộc, quan hệ). Nguồn: snapshot của migration mới nhất (khớp schema.ts nhờ db:ci-check), comment trong schema.ts,
// khoá ngoại, trigger, index, EXCLUDE viết tay trong migration (sql-objects.ts), cột tham chiếu khai ở schema-refs.ts.
import { readJournal, readSnapshot, snapshotName, versionLabel } from './journal.ts';
import { classifyColumn, TENANT_COLUMN, unusedRefKeys } from './schema-refs.ts';
import { readSchemaSources, type SourceDoc } from './schema-source.ts';
import { handWrittenObjects, type SqlIndex, type SqlTableObject } from './sql-objects.ts';

/** Chuỗi đánh dấu file do db:docs sinh (docs.ts dựa vào đây để biết file nào được xoá). */
export const GENERATED_MARK = 'Sinh tự động bởi `npm run db:docs`';

/** Tên và lớp của module lớn (src/modules/CLAUDE.md). Schema chưa khai đứng cuối, tên là chính nó. */
export const MODULES: Readonly<Record<string, { label: string; layer: number }>> = {
  core: { label: 'Lõi', layer: 1 },
  product: { label: 'Sản phẩm', layer: 2 },
  order: { label: 'Đơn hàng', layer: 3 },
  finance: { label: 'Tài chính', layer: 4 },
  channel: { label: 'Kênh bán', layer: 5 },
  insight: { label: 'Phân tích', layer: 5 },
};
const MODULE_ORDER = Object.keys(MODULES);

export interface SnapColumn {
  name: string;
  type: string;
  typeSchema?: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: unknown;
  generated?: { as: string };
}
export interface SnapIndex {
  name: string;
  columns: { expression: string }[];
  isUnique: boolean;
  method?: string;
  where?: string;
}
export interface SnapForeignKey {
  name: string;
  tableTo: string;
  schemaTo?: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
}
export interface SnapTable {
  name: string;
  schema: string;
  columns: Record<string, SnapColumn>;
  indexes: Record<string, SnapIndex>;
  foreignKeys: Record<string, SnapForeignKey>;
  compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
  uniqueConstraints: Record<string, { name: string; columns: string[]; nullsNotDistinct?: boolean }>;
  checkConstraints: Record<string, { name: string; value: string }>;
}
export interface DbSnapshot {
  tables: Record<string, SnapTable>;
  enums: Record<string, { name: string; schema: string; values: string[] }>;
}

export type RelationKind = 'fk' | 'fk-sql' | 'logical' | 'actor' | 'tenant';
export interface Relation {
  from: string;
  fromCols: string[];
  to: string;
  toCols: string[];
  kind: RelationKind;
  onDelete: string | null;
  /** Migration viết tay chứa khoá ngoại (`fk-sql`). */
  migration: string | null;
}

export interface DocColumn {
  name: string;
  type: string;
  enumId: string | null;
  notNull: boolean;
  primaryKey: boolean;
  default: string | null;
  generated: string | null;
  doc: SourceDoc;
  ref: Relation | null;
  /** Cột không trỏ bảng cố định hay mã bên ngoài: lý do cho người đọc. */
  note: string | null;
}

export interface DocTable {
  id: string;
  schema: string;
  name: string;
  sub: string;
  file: string;
  doc: SourceDoc;
  columns: DocColumn[];
  pk: string[];
  uniques: { name: string; cols: string[]; nullsNotDistinct: boolean }[];
  indexes: { name: string; cols: string[]; unique: boolean; method: string | null; where: string | null }[];
  checks: { name: string; expr: string }[];
  /** Viết tay trong migration, snapshot không có. */
  triggers: SqlTableObject[];
  manualIndexes: SqlIndex[];
  excludes: SqlTableObject[];
}

export interface SchemaModel {
  version: string;
  tag: string;
  schemas: string[];
  tables: DocTable[];
  relations: Relation[];
  enums: Map<string, { values: string[]; doc: SourceDoc }>;
  /** Lỗi khiến db:docs --check trượt (cột tham chiếu chưa khai, bảng đích không có). */
  problems: string[];
}

const KIND_LABEL: Readonly<Record<RelationKind, string>> = {
  fk: 'khoá ngoại',
  'fk-sql': 'khoá ngoại viết tay',
  logical: 'tham chiếu, không có khoá ngoại',
  actor: 'người thao tác',
  tenant: 'theo công ty',
};
export const EXTERNAL_NOTE = 'mã bên ngoài (sàn, cổng thanh toán)';
const NO_DOC: SourceDoc = { text: '', deprecated: null };

const schemaRank = (s: string): number => (MODULE_ORDER.includes(s) ? MODULE_ORDER.indexOf(s) : MODULE_ORDER.length);
const byTable = (a: { schema: string; name: string }, b: { schema: string; name: string }): number =>
  schemaRank(a.schema) - schemaRank(b.schema) || (a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function shortType(type: string): string {
  return type
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('double precision', 'float8')
    .replace('character varying', 'varchar')
    .replace(/numeric\((\d+), (\d+)\)/, 'numeric($1,$2)');
}

/** Bỏ tiền tố `"schema"."bảng".` và ngoặc kép thừa trong biểu thức CHECK, WHERE của snapshot. */
export function prettySql(expr: string, schema: string, table: string): string {
  return expr
    .split(`"${schema}"."${table}".`)
    .join('')
    .replace(/"([a-z_][a-z0-9_]*)"/g, (whole, id: string) => (id === 'order' ? whole : id));
}

/** Dựng mô hình từ bộ migration `dir` và mã nguồn dưới `root`. */
export function buildSchemaModel(dir: string, root: string): SchemaModel {
  const entries = readJournal(dir).entries;
  const last = entries.at(-1);
  if (!last) throw new Error(`${dir}: journal trống`);
  const snapshot = readSnapshot(dir, snapshotName(last.tag)) as unknown as DbSnapshot;
  const source = readSchemaSources(root);
  const problems: string[] = [];

  const snapTables = Object.values(snapshot.tables).sort(byTable);
  const tableIds = new Set(snapTables.map((t) => `${t.schema}.${t.name}`));
  const relations: Relation[] = [];
  const fkNames = new Set<string>();
  const indexNames = new Set(snapTables.flatMap((t) => Object.keys(t.indexes)));
  for (const t of snapTables) {
    for (const fk of Object.values(t.foreignKeys)) {
      fkNames.add(fk.name);
      relations.push({
        from: `${t.schema}.${t.name}`,
        fromCols: fk.columnsFrom,
        to: `${fk.schemaTo || t.schema}.${fk.tableTo}`,
        toCols: fk.columnsTo,
        kind: 'fk',
        onDelete: fk.onDelete && fk.onDelete !== 'no action' ? fk.onDelete : null,
        migration: null,
      });
    }
  }
  const manual = handWrittenObjects(dir, tableIds, { foreignKeys: fkNames, indexes: indexNames });
  for (const fk of manual.foreignKeys) {
    relations.push({
      from: fk.from,
      fromCols: fk.fromCols,
      to: fk.to,
      toCols: fk.toCols,
      kind: 'fk-sql',
      onDelete: fk.onDelete && fk.onDelete !== 'no action' ? fk.onDelete : null,
      migration: fk.migration,
    });
  }
  const usedRefKeys = new Set<string>();

  const tables: DocTable[] = snapTables.map((t) => {
    const id = `${t.schema}.${t.name}`;
    const src = source.tables.get(id);
    if (!src) problems.push(`không thấy khai báo của bảng \`${id}\` trong src/modules/*/*/repository/schema.ts`);
    const pk = new Set(Object.values(t.columns).filter((c) => c.primaryKey).map((c) => c.name));
    for (const cp of Object.values(t.compositePrimaryKeys)) for (const c of cp.columns) pk.add(c);
    const columns: DocColumn[] = Object.values(t.columns).map((c) => {
      const fk = relations.find((r) => r.from === id && (r.kind === 'fk' || r.kind === 'fk-sql') && r.fromCols.includes(c.name) && c.name !== TENANT_COLUMN);
      let ref: Relation | null = fk ?? null;
      let note: string | null = null;
      if (!ref) {
        const cls = classifyColumn(id, c.name, c.type, pk.has(c.name) && pk.size === 1);
        if (cls.kind === 'logical' || cls.kind === 'not-ref') usedRefKeys.add(cls.key);
        if (cls.kind === 'logical' || cls.kind === 'actor' || cls.kind === 'tenant') {
          if (!tableIds.has(cls.table)) problems.push(`\`${id}.${c.name}\` khai trỏ tới \`${cls.table}\` nhưng bảng này không có`);
          ref = { from: id, fromCols: [c.name], to: cls.table, toCols: ['id'], kind: cls.kind, onDelete: null, migration: null };
          relations.push(ref);
        } else if (cls.kind === 'not-ref') {
          note = cls.note;
        } else if (cls.kind === 'external') {
          note = EXTERNAL_NOTE;
        } else if (cls.kind === 'unknown') {
          problems.push(
            `cột \`${id}.${c.name}\` (uuid) không có khoá ngoại và chưa khai trỏ tới bảng nào: thêm vào LOGICAL_REFS hoặc NOT_REFS ở scripts/db/lib/schema-refs.ts`,
          );
        }
      }
      return {
        name: c.name,
        type: c.typeSchema ? c.type : shortType(c.type),
        enumId: c.typeSchema ? `${c.typeSchema}.${c.type.replace(/\[\]$/, '')}` : null,
        notNull: c.notNull,
        primaryKey: pk.has(c.name),
        default: c.default === undefined || c.default === null ? null : String(c.default),
        generated: c.generated?.as ?? null,
        doc: src?.columns.get(c.name) ?? NO_DOC,
        ref,
        note,
      };
    });
    return {
      id,
      schema: t.schema,
      name: t.name,
      sub: src?.sub ?? '?',
      file: src?.file ?? '?',
      doc: src ? { text: src.text, deprecated: src.deprecated } : NO_DOC,
      columns,
      pk: [...pk],
      uniques: Object.values(t.uniqueConstraints).map((u) => ({ name: u.name, cols: u.columns, nullsNotDistinct: !!u.nullsNotDistinct })),
      indexes: Object.values(t.indexes).map((ix) => ({
        name: ix.name,
        cols: ix.columns.map((c) => c.expression),
        unique: ix.isUnique,
        method: ix.method && ix.method !== 'btree' ? ix.method : null,
        where: ix.where ? prettySql(ix.where, t.schema, t.name) : null,
      })),
      checks: Object.values(t.checkConstraints).map((c) => ({ name: c.name, expr: prettySql(c.value, t.schema, t.name) })),
      triggers: manual.triggers.filter((x) => x.table === id),
      manualIndexes: manual.indexes.filter((x) => x.table === id),
      excludes: manual.excludes.filter((x) => x.table === id),
    };
  });
  for (const key of unusedRefKeys(usedRefKeys)) {
    problems.push(`mục \`${key}\` trong scripts/db/lib/schema-refs.ts không khớp cột nào (cột đã xoá, đổi tên, hay đã có khoá ngoại): xoá hoặc sửa mục đó`);
  }

  const enums = new Map<string, { values: string[]; doc: SourceDoc }>();
  for (const e of Object.values(snapshot.enums)) {
    const id = `${e.schema}.${e.name}`;
    enums.set(id, { values: e.values, doc: source.enums.get(id) ?? NO_DOC });
  }
  const schemas = [...new Set(snapTables.map((t) => t.schema))];
  return { version: versionLabel(last), tag: last.tag, schemas, tables, relations, enums, problems };
}

// ---------------------------------------------------------------- in Markdown

const GENERATED = `<!-- ${GENERATED_MARK}. Không sửa tay: sửa comment trong schema.ts (hoặc scripts/db/lib/schema-refs.ts) rồi chạy lại lệnh. -->`;
const NOT_LISTED =
  '**Không có ở đây:** RLS và policy (mọi bảng có `company_id` bật RLS với policy `company_isolation`, trừ ngoại lệ ở `test/integration/shared/rls-coverage.test.ts`), quyền của role `commerio_app`, hàm SQL, và mọi thứ tạo bằng SQL động. Xem `db/CLAUDE.md` mục Row-Level Security và các migration viết tay.';
const c = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
const list = (items: string[]): string => items.map(c).join(', ');

/** Câu đầu của mô tả (tới dấu chấm đầu tiên), tối đa `max` ký tự. */
export function firstSentence(text: string, max = 200): string {
  const end = text.search(/\.(\s|$)/);
  const s = end >= 0 ? text.slice(0, end + 1) : text;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function moduleTitle(schema: string): string {
  const m = MODULES[schema];
  return m ? `${m.label} · lớp ${m.layer}` : schema;
}

function stats(model: SchemaModel): string {
  const fk = model.relations.filter((r) => r.kind === 'fk' || r.kind === 'fk-sql').length;
  const logical = model.relations.filter((r) => r.kind === 'logical').length;
  return `${model.tables.length} bảng trong ${model.schemas.length} schema, ${fk} khoá ngoại, ${logical} cột tham chiếu không có khoá ngoại`;
}

export function renderIndex(model: SchemaModel): string {
  const out: string[] = [
    '# Schema CSDL',
    '',
    GENERATED,
    '',
    `Phiên bản **${model.version}** (${c(model.tag)}): ${stats(model)}. Lịch sử từng phiên bản: [VERSIONS.md](VERSIONS.md).`,
    '',
    'Nguồn: snapshot của migration mới nhất, comment trong `src/modules/<lớn>/<con>/repository/schema.ts`, khoá ngoại, trigger, index, EXCLUDE viết tay trong migration. Cột, kiểu, ràng buộc, quan hệ của từng bảng ở `db/schema/<schema>.md`.',
    '',
    NOT_LISTED,
    '',
    '## Trước khi thêm bảng, cột, enum',
    '',
    '- Tìm ở đây và trong `db/schema/<schema>.md` xem đã có thứ cùng nghĩa chưa. Có rồi thì dùng lại, không thêm bản thứ hai.',
    '- Không xây tiếp lên mục **Đã bỏ** bên dưới (thẻ `@deprecated` trong schema.ts).',
    '- Cột uuid trỏ sang bảng khác mà không có khoá ngoại: khai ở `scripts/db/lib/schema-refs.ts`, không thì `db:docs` báo lỗi.',
    '- Không để hai migration sinh từ schema.ts liền nhau trong một PR (`db/CLAUDE.md`).',
    '',
    '## Đã bỏ',
    '',
  ];
  const dropped: string[] = [];
  for (const t of model.tables) {
    if (t.doc.deprecated !== null) dropped.push(`- ${c(t.id)} (bảng): ${t.doc.deprecated || 'không ghi lý do'}`);
    for (const col of t.columns) {
      if (col.doc.deprecated !== null) dropped.push(`- ${c(`${t.id}.${col.name}`)} (cột): ${col.doc.deprecated || 'không ghi lý do'}`);
    }
  }
  out.push(...(dropped.length ? dropped : ['Không có.']), '');
  for (const schema of model.schemas) {
    const tabs = model.tables.filter((t) => t.schema === schema);
    out.push(`## ${c(schema)} · ${moduleTitle(schema)} · ${tabs.length} bảng`, '', `Chi tiết: [schema/${schema}.md](schema/${schema}.md)`, '');
    for (const t of tabs) {
      const desc = t.doc.text ? `: ${firstSentence(t.doc.text)}` : '';
      out.push(`- ${c(t.id)} (${t.sub})${t.doc.deprecated !== null ? ' **đã bỏ**' : ''}${desc}`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function columnLine(model: SchemaModel, col: DocColumn): string[] {
  const parts: string[] = [];
  const en = col.enumId ? model.enums.get(col.enumId) : undefined;
  parts.push(col.enumId ? `enum ${c(col.enumId)}` : col.type);
  parts.push(col.primaryKey ? 'khoá chính' : col.notNull ? 'not null' : 'null');
  if (col.default !== null) parts.push(`mặc định ${c(col.default)}`);
  if (col.generated !== null) parts.push(`sinh từ ${c(col.generated)}`);
  let line = `- ${c(col.name)} ${parts.join(' · ')}`;
  if (col.ref) {
    const target = col.ref.kind === 'actor' || col.ref.kind === 'tenant' ? col.ref.to : `${col.ref.to}.${col.ref.toCols[col.ref.fromCols.indexOf(col.name)] ?? col.ref.toCols[0]}`;
    const extra = col.ref.onDelete ? `, ON DELETE ${col.ref.onDelete}` : '';
    line += ` → ${c(target)} (${KIND_LABEL[col.ref.kind]}${extra})`;
  } else if (col.note) {
    line += `: ${col.note}`;
  }
  if (en) line += `: ${en.values.map(c).join(' | ')}`;
  const lines = [line];
  if (col.doc.text) lines.push(`  ${col.doc.text}`);
  if (col.doc.deprecated !== null) lines.push(`  **Đã bỏ:** ${col.doc.deprecated || 'không ghi lý do'}`);
  return lines;
}

export function renderSchemaFile(model: SchemaModel, schema: string): string {
  const tabs = model.tables.filter((t) => t.schema === schema);
  const out: string[] = [
    `# Schema ${c(schema)} · ${moduleTitle(schema)}`,
    '',
    GENERATED,
    '',
    `Phiên bản **${model.version}**, ${tabs.length} bảng. Mục lục mọi schema và các bảng đã bỏ: [../SCHEMA.md](../SCHEMA.md).`,
    '',
    NOT_LISTED,
    '',
  ];
  for (const t of tabs) {
    out.push(`## ${c(t.id)}`, '');
    if (t.doc.text) out.push(t.doc.text, '');
    if (t.doc.deprecated !== null) out.push(`**Đã bỏ:** ${t.doc.deprecated || 'không ghi lý do'}`, '');
    const meta = [`Khai ở ${c(t.file)}`, `module con ${c(t.sub)}`];
    if (t.columns.some((col) => col.name === TENANT_COLUMN)) meta.push(`theo công ty (${c(TENANT_COLUMN)})`);
    out.push(meta.join(' · '), '', 'Cột:', '');
    for (const col of t.columns) out.push(...columnLine(model, col));
    const cons: string[] = [];
    if (t.pk.length > 1) cons.push(`- khoá chính (${list(t.pk)})`);
    for (const u of t.uniques) cons.push(`- unique (${list(u.cols)})${u.nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''} ${c(u.name)}`);
    for (const ix of t.indexes) {
      const kind = `${ix.unique ? 'unique index' : 'index'}${ix.method ? ` ${ix.method}` : ''}`;
      cons.push(`- ${kind} (${list(ix.cols)}) ${c(ix.name)}${ix.where ? ` where ${c(ix.where)}` : ''}`);
    }
    for (const ck of t.checks) cons.push(`- check ${c(ck.name)}: ${c(ck.expr)}`);
    const at = (migration: string | null): string => `, ở ${c(`db/migrations/${migration}.sql`)}`;
    for (const r of model.relations.filter((x) => x.from === t.id && x.kind === 'fk-sql')) {
      cons.push(`- khoá ngoại viết tay (${list(r.fromCols)}) → ${c(r.to)} (${list(r.toCols)})${r.onDelete ? `, ON DELETE ${r.onDelete}` : ''}${at(r.migration)}`);
    }
    for (const ix of t.manualIndexes) cons.push(`- ${ix.unique ? 'unique index' : 'index'} viết tay ${c(ix.name)}: ${c(ix.definition)}${at(ix.migration)}`);
    for (const x of t.excludes) cons.push(`- EXCLUDE ${c(x.name)}: ${c(x.definition)}${at(x.migration)}`);
    for (const tr of t.triggers) cons.push(`- trigger ${c(tr.name)}: ${c(tr.definition)}${at(tr.migration)}`);
    if (cons.length) out.push('', 'Ràng buộc và index:', '', ...cons);
    const incoming = model.relations.filter((r) => r.to === t.id);
    const direct = incoming.filter((r) => r.kind === 'fk' || r.kind === 'fk-sql' || r.kind === 'logical');
    const actors = incoming.filter((r) => r.kind === 'actor');
    const tenants = incoming.filter((r) => r.kind === 'tenant');
    if (incoming.length) {
      out.push('', 'Trỏ vào bảng này:', '');
      for (const r of direct) out.push(`- ${c(`${r.from}.${r.fromCols.join(', ')}`)} (${KIND_LABEL[r.kind]})`);
      if (actors.length) out.push(`- người thao tác, ${actors.length} cột: ${actors.map((r) => c(`${r.from}.${r.fromCols[0]}`)).join(', ')}`);
      if (tenants.length) out.push(`- ${tenants.length} bảng có ${c(TENANT_COLUMN)}`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
