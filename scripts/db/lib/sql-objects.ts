// Đọc các đối tượng viết tay trong file migration mà snapshot của drizzle-kit không có: khoá ngoại ghép, trigger, index
// (biểu thức, NULLS NOT DISTINCT), ràng buộc EXCLUDE. Dùng cho tài liệu schema (db:docs).
//
// Cách đọc: chuẩn hoá xuống dòng, bỏ comment `--`, bỏ thân `$tag$ … $tag$` (hàm, khối DO: SQL động trong đó không đọc),
// tách câu theo `;`, xét từng câu theo thứ tự. Không nhận: khoá ngoại không tên (`ADD FOREIGN KEY`), `REFERENCES` viết
// ngay trong `CREATE TABLE`, đối tượng tạo bằng SQL động (`EXECUTE format(...)`, ví dụ vòng lặp RLS của 0002).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from './journal.ts';

export interface SqlForeignKey {
  name: string;
  from: string;
  fromCols: string[];
  to: string;
  toCols: string[];
  onDelete: string | null;
  migration: string;
}
export interface SqlTableObject {
  name: string;
  table: string;
  /** Phần định nghĩa đã gom khoảng trắng, để in ra. */
  definition: string;
  migration: string;
}
export interface SqlIndex extends SqlTableObject {
  unique: boolean;
}

export type SqlEvent =
  | { op: 'add-fk'; fk: SqlForeignKey }
  | { op: 'add-exclude'; obj: SqlTableObject }
  | { op: 'drop-constraint'; table: string; name: string }
  | { op: 'add-trigger'; obj: SqlTableObject }
  | { op: 'drop-trigger'; table: string; name: string }
  | { op: 'add-index'; obj: SqlIndex }
  | { op: 'drop-index'; name: string };

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const re = (source: string): RegExp => new RegExp(source, 'i');
const TABLE = String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}`;
const ADD_FK = re(
  String.raw`^${TABLE}\s+ADD\s+CONSTRAINT\s+(${IDENT})\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+${QUALIFIED}\s*\(([^)]*)\)([\s\S]*)$`,
);
const ADD_EXCLUDE = re(String.raw`^${TABLE}\s+ADD\s+CONSTRAINT\s+(${IDENT})\s+(EXCLUDE\b[\s\S]*)$`);
const DROP_CONSTRAINT = re(String.raw`^${TABLE}\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENT})`);
const CREATE_TRIGGER = re(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${IDENT})\s+([\s\S]*?)\s+ON\s+${QUALIFIED}([\s\S]*)$`,
);
const DROP_TRIGGER = re(String.raw`^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+${QUALIFIED}`);
const CREATE_INDEX = re(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?${QUALIFIED}\s*([\s\S]*)$`,
);
const DROP_INDEX = re(String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED}`);
const ON_DELETE = /\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i;
const EXECUTES = re(String.raw`EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+${QUALIFIED}\s*\(`);

const unquote = (s: string): string => s.trim().replace(/^"|"$/g, '');
const qualified = (s: string): string => s.split('.').map(unquote).join('.');
const columnList = (s: string): string[] => s.split(',').map(unquote).filter(Boolean);
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Câu lệnh SQL của một file, đã bỏ comment và thân `$tag$ … $tag$`. */
export function sqlStatements(sql: string): string[] {
  return sql
    .replace(/\r\n?/g, '\n')
    .replace(/--[^\n]*/g, '')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Thêm, xoá đối tượng viết tay trong một file SQL, theo đúng thứ tự câu lệnh. */
export function parseSqlEvents(sql: string, migration: string): SqlEvent[] {
  const events: SqlEvent[] = [];
  for (const stmt of sqlStatements(sql)) {
    let m: RegExpExecArray | null;
    if ((m = ADD_FK.exec(stmt))) {
      const onDelete = ON_DELETE.exec(m[6]!)?.[1];
      events.push({
        op: 'add-fk',
        fk: {
          from: qualified(m[1]!),
          name: unquote(m[2]!),
          fromCols: columnList(m[3]!),
          to: qualified(m[4]!),
          toCols: columnList(m[5]!),
          onDelete: onDelete ? onDelete.toLowerCase().replace(/\s+/g, ' ') : null,
          migration,
        },
      });
    } else if ((m = ADD_EXCLUDE.exec(stmt))) {
      events.push({ op: 'add-exclude', obj: { table: qualified(m[1]!), name: unquote(m[2]!), definition: squash(m[3]!), migration } });
    } else if ((m = DROP_CONSTRAINT.exec(stmt))) {
      events.push({ op: 'drop-constraint', table: qualified(m[1]!), name: unquote(m[2]!) });
    } else if ((m = CREATE_TRIGGER.exec(stmt))) {
      const fn = EXECUTES.exec(m[4]!)?.[1];
      const deferred = /\bINITIALLY\s+DEFERRED\b/i.test(m[4]!) ? ', kiểm lúc commit' : '';
      events.push({
        op: 'add-trigger',
        obj: { name: unquote(m[1]!), table: qualified(m[3]!), definition: `${squash(m[2]!)}${deferred}${fn ? ` → ${qualified(fn)}()` : ''}`, migration },
      });
    } else if ((m = DROP_TRIGGER.exec(stmt))) {
      events.push({ op: 'drop-trigger', name: unquote(m[1]!), table: qualified(m[2]!) });
    } else if ((m = CREATE_INDEX.exec(stmt))) {
      events.push({ op: 'add-index', obj: { unique: !!m[1], name: unquote(m[2]!), table: qualified(m[3]!), definition: squash(m[4]!), migration } });
    } else if ((m = DROP_INDEX.exec(stmt))) {
      events.push({ op: 'drop-index', name: qualified(m[1]!).split('.').pop()! });
    }
  }
  return events;
}

export interface HandWritten {
  foreignKeys: SqlForeignKey[];
  triggers: SqlTableObject[];
  indexes: SqlIndex[];
  excludes: SqlTableObject[];
}

/**
 * Đối tượng viết tay còn hiệu lực sau mọi migration trong journal: bảng (và bảng đích của khoá ngoại) còn trong
 * `tableIds`, tên không trùng đối tượng drizzle đã có trong snapshot (`known`).
 */
export function handWrittenObjects(
  dir: string,
  tableIds: ReadonlySet<string>,
  known: { foreignKeys: ReadonlySet<string>; indexes: ReadonlySet<string> },
): HandWritten {
  const fks = new Map<string, SqlForeignKey>();
  const excludes = new Map<string, SqlTableObject>();
  const triggers = new Map<string, SqlTableObject>();
  const indexes = new Map<string, SqlIndex>();
  for (const entry of readJournal(dir).entries) {
    for (const e of parseSqlEvents(readFileSync(join(dir, `${entry.tag}.sql`), 'utf8'), entry.tag)) {
      if (e.op === 'add-fk') fks.set(`${e.fk.from}:${e.fk.name}`, e.fk);
      else if (e.op === 'add-exclude') excludes.set(`${e.obj.table}:${e.obj.name}`, e.obj);
      else if (e.op === 'drop-constraint') {
        fks.delete(`${e.table}:${e.name}`);
        excludes.delete(`${e.table}:${e.name}`);
      } else if (e.op === 'add-trigger') triggers.set(`${e.obj.table}:${e.obj.name}`, e.obj);
      else if (e.op === 'drop-trigger') triggers.delete(`${e.table}:${e.name}`);
      else if (e.op === 'add-index') indexes.set(e.obj.name, e.obj);
      else indexes.delete(e.name);
    }
  }
  const live = (t: string): boolean => tableIds.has(t);
  return {
    foreignKeys: [...fks.values()].filter((fk) => !known.foreignKeys.has(fk.name) && live(fk.from) && live(fk.to)),
    triggers: [...triggers.values()].filter((t) => live(t.table)),
    indexes: [...indexes.values()].filter((ix) => !known.indexes.has(ix.name) && live(ix.table)),
    excludes: [...excludes.values()].filter((x) => live(x.table)),
  };
}
