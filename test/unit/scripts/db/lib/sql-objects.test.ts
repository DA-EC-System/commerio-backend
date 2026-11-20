import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handWrittenObjects, parseSqlEvents } from '../../../../../scripts/db/lib/sql-objects.ts';
import { journalText } from './fake-migrations.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Thư mục migration chỉ có journal và file SQL (đủ cho handWrittenObjects). */
function sqlDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'commerio-sql-obj-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  const tags = Object.keys(files);
  tags.forEach((tag) => writeFileSync(join(dir, `${tag}.sql`), files[tag]!));
  writeFileSync(join(dir, 'meta', '_journal.json'), journalText(tags.map((tag, i) => ({ tag, when: 1000 * (i + 1) }))));
  return dir;
}

describe('đọc khoá ngoại viết tay trong SQL', () => {
  it('khoá ngoại ghép, tên có ngoặc kép, schema "order", ON DELETE đứng sau ON UPDATE', () => {
    const sql = [
      'ALTER TABLE finance.ledger_replacements ADD CONSTRAINT ledger_replacements_actual_fk',
      '  FOREIGN KEY (actual_id, actual_is_estimate) REFERENCES finance.ledger_entries (id, is_estimate);--> statement-breakpoint',
      'ALTER TABLE "order"."package_lines" ADD CONSTRAINT "pl_pkg_fk" FOREIGN KEY ("package_id") REFERENCES "order"."packages"("id") ON UPDATE no action ON DELETE cascade;',
    ].join('\r\n');
    const fks = parseSqlEvents(sql, 'm1').flatMap((e) => (e.op === 'add-fk' ? [e.fk] : []));
    expect(fks).toEqual([
      { from: 'finance.ledger_replacements', name: 'ledger_replacements_actual_fk', fromCols: ['actual_id', 'actual_is_estimate'], to: 'finance.ledger_entries', toCols: ['id', 'is_estimate'], onDelete: null, migration: 'm1' },
      { from: 'order.package_lines', name: 'pl_pkg_fk', fromCols: ['package_id'], to: 'order.packages', toCols: ['id'], onDelete: 'cascade', migration: 'm1' },
    ]);
  });

  it('câu nằm trong comment hay trong thân hàm $$ … $$ không tính', () => {
    const sql = [
      '-- ALTER TABLE a.x ADD CONSTRAINT x_fk FOREIGN KEY (y_id) REFERENCES a.y (id);',
      "DO $$ BEGIN EXECUTE 'ALTER TABLE a.x ADD CONSTRAINT z_fk FOREIGN KEY (y_id) REFERENCES a.y (id)'; END $$;",
    ].join('\n');
    expect(parseSqlEvents(sql, 'm1')).toEqual([]);
  });

  it('thêm rồi xoá trong cùng một file thì không còn; xoá rồi thêm lại thì còn', () => {
    const add = 'ALTER TABLE a.x ADD CONSTRAINT x_fk FOREIGN KEY (y_id) REFERENCES a.y (id);';
    const drop = 'ALTER TABLE a.x DROP CONSTRAINT x_fk;';
    const tables = new Set(['a.x', 'a.y']);
    const known = { foreignKeys: new Set<string>(), indexes: new Set<string>() };
    expect(handWrittenObjects(sqlDir({ '0000_a': `${add}\n${drop}` }), tables, known).foreignKeys).toEqual([]);
    expect(handWrittenObjects(sqlDir({ '0000_a': add, '0001_b': `${drop}\n${add.replace('(id)', '(id) ON DELETE cascade')}` }), tables, known).foreignKeys).toMatchObject([
      { name: 'x_fk', onDelete: 'cascade', migration: '0001_b' },
    ]);
  });
});

describe('đọc trigger, index, EXCLUDE viết tay', () => {
  it('trigger viết thường, kiểm lúc commit, xoá bằng DROP TRIGGER', () => {
    const files = {
      '0000_a': [
        'CREATE CONSTRAINT TRIGGER package_lines_line_total AFTER INSERT OR DELETE OR UPDATE OF quantity ON "order".package_lines',
        '  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "order".assert_package_line_total();',
        'create trigger orders_sync before insert or update on "order".orders for each row execute function "order".sync();',
      ].join('\n'),
      '0001_b': 'drop trigger if exists orders_sync on "order".orders;',
    };
    const out = handWrittenObjects(sqlDir(files), new Set(['order.package_lines', 'order.orders']), { foreignKeys: new Set(), indexes: new Set() });
    expect(out.triggers).toEqual([
      {
        name: 'package_lines_line_total',
        table: 'order.package_lines',
        definition: 'AFTER INSERT OR DELETE OR UPDATE OF quantity, kiểm lúc commit → order.assert_package_line_total()',
        migration: '0000_a',
      },
    ]);
  });

  it('index biểu thức viết tay; index drizzle đã có trong snapshot thì bỏ', () => {
    const sql = [
      'CREATE UNIQUE INDEX roles_company_lower_name_uq ON core.roles (company_id, lower(name)) NULLS NOT DISTINCT;',
      'CREATE INDEX "roles_kind_index" ON "core"."roles" USING btree ("kind");',
    ].join('\n');
    const out = handWrittenObjects(sqlDir({ '0000_a': sql }), new Set(['core.roles']), { foreignKeys: new Set(), indexes: new Set(['roles_kind_index']) });
    expect(out.indexes).toEqual([
      { unique: true, name: 'roles_company_lower_name_uq', table: 'core.roles', definition: '(company_id, lower(name)) NULLS NOT DISTINCT', migration: '0000_a' },
    ]);
  });

  it('ràng buộc EXCLUDE viết nhiều dòng', () => {
    const sql = 'ALTER TABLE finance.config_versions ADD CONSTRAINT config_versions_no_overlap\n  EXCLUDE USING gist (company_id WITH =, daterange(effective_from, effective_to) WITH &&);';
    const out = handWrittenObjects(sqlDir({ '0000_a': sql }), new Set(['finance.config_versions']), { foreignKeys: new Set(), indexes: new Set() });
    expect(out.excludes).toMatchObject([{ name: 'config_versions_no_overlap', definition: 'EXCLUDE USING gist (company_id WITH =, daterange(effective_from, effective_to) WITH &&)' }]);
  });
});
