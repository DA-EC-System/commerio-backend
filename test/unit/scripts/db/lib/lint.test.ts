import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJournal } from '../../../../../scripts/db/lib/journal.ts';
import { lintAgainstBase, lintFolder } from '../../../../../scripts/db/lib/lint.ts';
import { cleanupFakeDirs, fakeMigrations, journalText, writeJournal, writeSnapshot } from './fake-migrations.ts';

afterEach(cleanupFakeDirs);

const A = { tag: '0000_a', when: 1000, tables: { t1: {} } };
const B = { tag: '20261101000000_b', when: 2000, tables: { t1: {}, t2: {} } };
const C = { tag: '20261102000000_c', when: 3000 };

describe('kiểm thư mục migration (không cần DB)', () => {
  it('bộ migration liền mạch thì đạt', () => {
    expect(lintFolder(fakeMigrations([A, B, C]))).toEqual([]);
  });

  it('when không tăng thì báo', () => {
    const dir = fakeMigrations([A, B, C]);
    writeJournal(dir, [A, { ...B, when: 4000 }, C]);
    expect(lintFolder(dir).join('\n')).toContain(`when không tăng: ${C.tag}`);
  });

  it('idx đứt thì báo', () => {
    const dir = fakeMigrations([A, B]);
    const journal = parseJournal(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));
    journal.entries[1]!.idx = 5;
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
    expect(lintFolder(dir).join('\n')).toContain('journal đứt idx: vị trí 1 có idx 5');
  });

  it('file .sql không có trong journal thì báo: drizzle sẽ không chạy', () => {
    const dir = fakeMigrations([A, B]);
    writeJournal(dir, [A]);
    const errors = lintFolder(dir).join('\n');
    expect(errors).toContain(`file ${B.tag}.sql không có trong journal`);
    expect(errors).toContain('snapshot meta/20261101000000_snapshot.json không thuộc migration nào');
  });

  it('thiếu file .sql có trong journal thì báo', () => {
    const dir = fakeMigrations([A, B]);
    rmSync(join(dir, `${B.tag}.sql`));
    expect(lintFolder(dir).join('\n')).toContain(`thiếu file ${B.tag}.sql`);
  });

  it('snapshot trỏ sai cha thì báo (hai nhánh cùng nối vào một snapshot)', () => {
    const dir = fakeMigrations([A, B, C]);
    writeSnapshot(dir, C.tag, { id: 'id-c', prevId: 'id-0000_a', tables: B.tables });
    expect(lintFolder(dir).join('\n')).toContain('snapshot 20261102000000_snapshot.json (20261102000000_c) trỏ sai cha');
  });

  it('journal còn dấu xung đột git thì báo', () => {
    const dir = fakeMigrations([A]);
    writeFileSync(join(dir, 'meta', '_journal.json'), '<<<<<<< HEAD\n{}');
    expect(lintFolder(dir).join('\n')).toContain('không phải JSON hợp lệ');
  });
});

describe('kiểm migration của nhánh so với main', () => {
  const base = (list: { tag: string; when: number }[], dir: string) => ({
    ref: 'origin/main',
    journal: parseJournal(journalText(list)),
    readSql: (tag: string) => readFileSync(join(dir, `${tag}.sql`), 'utf8'),
  });

  it('migration nhánh sinh sau migration mới nhất của main thì đạt', () => {
    const dir = fakeMigrations([A, B, C]);
    expect(lintAgainstBase(dir, base([A, B], dir))).toEqual([]);
  });

  it('migration nhánh sinh trước migration mới nhất của main thì đỏ', () => {
    // Nhánh sinh X lúc 1500, main merge B (2000) trước; người gộp main tự ghép journal cho X đứng sau B.
    const X = { tag: '20261031000000_x', when: 1500 };
    const dir = fakeMigrations([A, B]);
    writeFileSync(join(dir, `${X.tag}.sql`), 'select 1;');
    writeSnapshot(dir, X.tag, { id: 'id-x', prevId: 'id-20261101000000_b', tables: B.tables });
    writeJournal(dir, [A, B, X]);
    const errors = lintAgainstBase(dir, base([A, B], dir));
    expect(errors.join('\n')).toContain(`migration ${X.tag}`);
    expect(errors.join('\n')).toContain('không đứng sau migration mới nhất trên origin/main 20261101000000_b');
  });

  it('nhánh sửa file .sql đã có trên main thì đỏ', () => {
    const dir = fakeMigrations([A, B]);
    const mainSql = readFileSync(join(dir, `${B.tag}.sql`), 'utf8');
    writeFileSync(join(dir, `${B.tag}.sql`), 'drop table x;');
    const errors = lintAgainstBase(dir, { ...base([A, B], dir), readSql: () => mainSql });
    expect(errors.join('\n')).toContain(`file ${B.tag}.sql khác bản trên origin/main`);
  });

  it('nhánh thiếu migration của main (chưa gộp main) thì đỏ', () => {
    const dir = fakeMigrations([A, C]);
    expect(lintAgainstBase(dir, base([A, B], dir)).join('\n')).toContain(`nhánh thiếu migration ${B.tag}`);
  });
});
