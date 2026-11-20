// Đọc comment của bảng, cột, enum trong src/modules/*/*/repository/schema.ts (cây cú pháp TypeScript, không chạy code)
// cho tài liệu schema (db:docs). Comment liền trước khai báo: khối `/** */` cuối, hoặc các dòng `//` liền nhau.
// Thẻ `@deprecated <lý do>` đánh dấu bảng, cột đã bỏ.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface SourceDoc {
  /** Mô tả, các dòng nối bằng dấu cách. */
  text: string;
  /** Lý do của thẻ `@deprecated`, null nếu không có thẻ. */
  deprecated: string | null;
}

export interface SourceTable extends SourceDoc {
  /** `<schema>.<bảng>`. */
  id: string;
  /** Module con (thư mục chứa `repository/schema.ts`). */
  sub: string;
  file: string;
  line: number;
  columns: Map<string, SourceDoc>;
}

export interface SchemaSource {
  tables: Map<string, SourceTable>;
  enums: Map<string, SourceDoc>;
}

const EMPTY: SourceDoc = { text: '', deprecated: null };

/** Tách mô tả và thẻ `@deprecated` từ các dòng comment đã bỏ ký hiệu comment. */
export function parseDocLines(lines: string[]): SourceDoc {
  const text: string[] = [];
  let deprecated: string[] | null = null;
  let inTag: 'deprecated' | 'other' | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const tag = /^@(\w+)\s*(.*)$/.exec(line);
    if (tag) {
      inTag = tag[1] === 'deprecated' ? 'deprecated' : 'other';
      if (inTag === 'deprecated') deprecated = tag[2] ? [tag[2]] : [];
      continue;
    }
    if (!line) continue;
    if (inTag === 'deprecated') deprecated!.push(line);
    else if (inTag === null) text.push(line);
  }
  return { text: text.join(' '), deprecated: deprecated === null ? null : deprecated.join(' ') };
}

function stripComment(raw: string): string[] {
  if (raw.startsWith('//')) return [raw.replace(/^\/\/\s?/, '')];
  return raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''));
}

/** Comment liền trước `node`: khối `/** *\/` cuối cùng, hoặc chuỗi dòng `//` không cách dòng trống. */
export function leadingDoc(text: string, node: ts.Node): SourceDoc {
  const ranges = ts.getLeadingCommentRanges(text, node.pos) ?? [];
  const last = ranges.at(-1);
  if (!last) return EMPTY;
  const lastRaw = text.slice(last.pos, last.end);
  if (lastRaw.startsWith('/*')) return parseDocLines(stripComment(lastRaw));
  const lines: string[] = [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    const raw = text.slice(r.pos, r.end);
    if (!raw.startsWith('//')) break;
    if (i < ranges.length - 1 && (text.slice(r.end, ranges[i + 1]!.pos).match(/\n/g) ?? []).length > 1) break;
    lines.unshift(...stripComment(raw));
  }
  return parseDocLines(lines);
}

/** Tên cột SQL của một khai báo cột: chuỗi đầu tiên của lời gọi gốc, vd `uuid('order_id').notNull()` → `order_id`. */
function columnName(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  let found: string | null = null;
  for (;;) {
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      const isRoot = ts.isIdentifier(callee) || (ts.isPropertyAccessExpression(callee) && !ts.isCallExpression(callee.expression));
      const first = e.arguments[0];
      if (isRoot && first && ts.isStringLiteralLike(first)) found = first.text;
      e = callee;
    } else if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
    } else {
      return found;
    }
  }
}

/** Đọc một file schema.ts. `file` là đường dẫn để ghi vào tài liệu, `sub` là module con. */
export function parseSchemaFile(text: string, file: string, sub: string): { tables: SourceTable[]; enums: [string, SourceDoc][] } {
  const source = ts.createSourceFile(file, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true);
  const body = source.getFullText();
  const schemaVars = new Map<string, string>();
  const tables: SourceTable[] = [];
  const enums: [string, SourceDoc][] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (!init || !ts.isCallExpression(init)) continue;
      const callee = init.expression;
      const first = init.arguments[0];
      if (!first || !ts.isStringLiteralLike(first)) continue;
      if (ts.isIdentifier(callee) && callee.text === 'pgSchema') {
        schemaVars.set(decl.name.getText(source), first.text);
        continue;
      }
      if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) continue;
      const schema = schemaVars.get(callee.expression.text);
      if (!schema) continue;
      const method = callee.name.text;
      if (method === 'enum') {
        enums.push([`${schema}.${first.text}`, leadingDoc(body, statement)]);
      } else if (method === 'table') {
        const columns = new Map<string, SourceDoc>();
        const shape = init.arguments[1];
        if (shape && ts.isObjectLiteralExpression(shape)) {
          for (const prop of shape.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const name = columnName(prop.initializer) ?? prop.name.getText(source);
            columns.set(name, leadingDoc(body, prop));
          }
        }
        tables.push({
          id: `${schema}.${first.text}`,
          sub,
          file,
          line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
          columns,
          ...leadingDoc(body, statement),
        });
      }
    }
  }
  return { tables, enums };
}

/** Đọc mọi `src/modules/<lớn>/<con>/repository/schema.ts` dưới `root`. */
export function readSchemaSources(root: string): SchemaSource {
  const out: SchemaSource = { tables: new Map(), enums: new Map() };
  const modules = join(root, 'src', 'modules');
  for (const big of readdirSync(modules, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    for (const sub of readdirSync(join(modules, big), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const rel = `src/modules/${big}/${sub}/repository/schema.ts`;
      const path = join(root, rel);
      if (!existsSync(path)) continue;
      const parsed = parseSchemaFile(readFileSync(path, 'utf8'), rel, sub);
      for (const t of parsed.tables) out.tables.set(t.id, t);
      for (const [id, doc] of parsed.enums) out.enums.set(id, doc);
    }
  }
  return out;
}
