import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshotFiles, listSqlFiles, readJournal, readSnapshot, snapshotBody, snapshotName } from '../../../../../scripts/db/lib/journal.ts';
import { lintAgainstBase } from '../../../../../scripts/db/lib/lint.ts';
import { applyRegen, planRegen, type RegenDeps } from '../../../../../scripts/db/lib/regen.ts';
import { cleanupFakeDirs, fakeMigrations, journalText, writeSnapshot, type FakeMigration } from './fake-migrations.ts';

afterEach(cleanupFakeDirs);

// main: A, rồi M (merge trước). Nhánh tách từ A, sinh G1 (schema), R (viết tay, RLS) trước khi M có trên main.
const A: FakeMigration = { tag: '0000_a', when: 1000, tables: { t1: 'v1' } };
const M: FakeMigration = { tag: '20261105000000_cua-main', when: 5000, tables: { t1: 'v1', main: 'v1' } };
const G1 = { tag: '20261103000000_bang-moi', when: 3000, sql: 'CREATE TABLE "x"."moi" ();' };
const R = { tag: '20261103000010_rls-bang-moi', when: 3010, sql: '-- RLS viết tay\nALTER TABLE x.moi ENABLE ROW LEVEL SECURITY;\n' };

/**
 * Thư mục sau khi gộp main vào nhánh: có file của cả hai bên, journal còn dấu xung đột. Snapshot của nhánh nối vào A.
 */
function mergedFolder(): string {
  const dir = fakeMigrations([A, M]);
  writeFileSync(join(dir, `${G1.tag}.sql`), G1.sql);
  writeSnapshot(dir, G1.tag, { id: 'id-g1', prevId: 'id-0000_a', tables: { t1: 'v1', moi: 'v1' } });
  writeFileSync(join(dir, `${R.tag}.sql`), R.sql);
  writeSnapshot(dir, R.tag, { id: 'id-r', prevId: 'id-g1', tables: { moi: 'v1', t1: 'v1' } });
  writeFileSync(join(dir, 'meta', '_journal.json'), '<<<<<<< HEAD\nxung đột\n>>>>>>> origin/main\n');
  return dir;
}

const baseFiles = new Set([`${A.tag}.sql`, `${M.tag}.sql`, `meta/${snapshotName(A.tag)}`, `meta/${snapshotName(M.tag)}`, 'meta/_journal.json']);

/** drizzle-kit giả: tên theo đồng hồ giả (mỗi lần một giây), snapshot nối vào snapshot cuối của journal. */
function fakeDeps(dir: string, target: Record<string, unknown>, sqlForSchema: string): RegenDeps & { calls: string[] } {
  let clock = Date.UTC(2026, 10, 12, 10, 0, 0);
  const calls: string[] = [];
  return {
    calls,
    baseJournal: journalText([A, M] as { tag: string; when: number }[]),
    waitNextSecond: () => {
      clock += 1000;
    },
    generate: (kind, name) => {
      calls.push(`${kind}:${name}`);
      const journal = readJournal(dir);
      const last = journal.entries.at(-1)!;
      const prev = readSnapshot(dir, snapshotName(last.tag));
      const tables = kind === 'custom' ? (prev.tables as Record<string, unknown>) : target;
      if (kind === 'schema' && snapshotBody({ ...prev }) === snapshotBody({ id: '', prevId: '', version: '7', dialect: 'postgresql', tables })) return;
      const prefix = new Date(clock).toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const tag = `${prefix}_${name}`;
      writeFileSync(join(dir, `${tag}.sql`), kind === 'custom' ? '-- Custom SQL migration file, put your code below! --\n' : sqlForSchema);
      writeSnapshot(dir, tag, { id: `id-${tag}`, prevId: prev.id, tables });
      journal.entries.push({ idx: journal.entries.length, version: '7', when: clock, tag, breakpoints: true });
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
    },
  };
}

const target = { t1: 'v1', main: 'v1', moi: 'v1' };

describe('db:regen: phân loại migration của nhánh', () => {
  it('migration có snapshot giống hệt cha là viết tay, còn lại là sinh từ schema', () => {
    const plan = planRegen(mergedFolder(), baseFiles);
    expect(plan.migrations.map((m) => [m.tag, m.kind])).toEqual([
      [G1.tag, 'generated'],
      [R.tag, 'custom'],
    ]);
    expect(plan.steps.map((s) => (s.kind === 'custom' ? `custom:${s.from.slug}` : `schema:${s.name}`))).toEqual([
      'schema:bang-moi',
      'custom:rls-bang-moi',
    ]);
    expect(plan.remove.sort()).toEqual(
      [`${G1.tag}.sql`, `${R.tag}.sql`, `meta/${snapshotName(G1.tag)}`, `meta/${snapshotName(R.tag)}`].sort(),
    );
  });

  it('viết tay nằm giữa hai migration sinh thì cảnh báo đổi thứ tự, tên sinh gộp giữ cả hai slug', () => {
    const dir = mergedFolder();
    const G2 = '20261104000000_cot-moi';
    writeFileSync(join(dir, `${G2}.sql`), 'ALTER TABLE x.moi ADD COLUMN c int;');
    writeSnapshot(dir, G2, { id: 'id-g2', prevId: 'id-r', tables: { t1: 'v1', moi: 'v2' } });
    const plan = planRegen(dir, baseFiles);
    expect(plan.steps.map((s) => (s.kind === 'custom' ? `custom:${s.from.slug}` : `schema:${s.name}`))).toEqual([
      'schema:bang-moi-cot-moi',
      'custom:rls-bang-moi',
    ]);
    expect(plan.warnings.join('\n')).toContain(`${R.tag} (viết tay) trước đây chạy giữa hai migration sinh`);
  });

  it('viết tay đứng trước migration sinh đầu tiên thì vẫn đứng trước', () => {
    const dir = fakeMigrations([A, M]);
    const D = '20261102000000_du-lieu-truoc';
    writeFileSync(join(dir, `${D}.sql`), 'update x set y = 1;');
    writeSnapshot(dir, D, { id: 'id-d', prevId: 'id-0000_a', tables: A.tables });
    writeFileSync(join(dir, `${G1.tag}.sql`), G1.sql);
    writeSnapshot(dir, G1.tag, { id: 'id-g1', prevId: 'id-d', tables: { t1: 'v1', moi: 'v1' } });
    const plan = planRegen(dir, baseFiles);
    expect(plan.steps.map((s) => s.kind)).toEqual(['custom', 'schema']);
    expect(plan.warnings).toEqual([]);
  });

  it('migration của nhánh thiếu snapshot thì dừng, không đoán', () => {
    const dir = fakeMigrations([A, M]);
    writeFileSync(join(dir, '20261103000000_khong-snapshot.sql'), 'select 1;');
    expect(() => planRegen(dir, baseFiles)).toThrow('không có snapshot');
  });
});

describe('db:regen: sinh lại trên thư mục giả', () => {
  it('migration của nhánh đứng sau main, viết tay chép nguyên, slug giữ nguyên, bộ migration hợp lệ', () => {
    const dir = mergedFolder();
    const deps = fakeDeps(dir, target, G1.sql);
    const result = applyRegen(dir, planRegen(dir, baseFiles), deps);

    expect(deps.calls).toEqual(['schema:bang-moi', 'custom:rls-bang-moi']);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const tags = readJournal(dir).entries.map((e) => e.tag);
    expect(tags).toEqual([A.tag, M.tag, '20261112100001_bang-moi', '20261112100002_rls-bang-moi']);
    expect(readFileSync(join(dir, '20261112100002_rls-bang-moi.sql'), 'utf8')).toBe(R.sql);
    // File cũ của nhánh đã xoá.
    expect(listSqlFiles(dir)).not.toContain(`${G1.tag}.sql`);
    expect(listSnapshotFiles(dir)).not.toContain(snapshotName(R.tag));
    // Đạt kiểm so với main.
    const base = { ref: 'main', journal: readJournal(dir), readSql: (t: string) => readFileSync(join(dir, `${t}.sql`), 'utf8') };
    base.journal.entries = base.journal.entries.slice(0, 2);
    expect(lintAgainstBase(dir, base)).toEqual([]);
  });

  it('câu lệnh viết tay thêm vào migration sinh mà bản sinh lại không có thì cảnh báo, in câu lệnh', () => {
    const dir = mergedFolder();
    writeFileSync(join(dir, `${G1.tag}.sql`), `${G1.sql}--> statement-breakpoint\nUPDATE x.moi SET a = 1;`);
    const result = applyRegen(dir, planRegen(dir, baseFiles), fakeDeps(dir, target, G1.sql));
    expect(result.warnings.join('\n')).toContain('UPDATE x.moi SET a = 1;');
  });

  it('thay đổi schema của nhánh đã có trên main thì drizzle-kit không sinh gì: cảnh báo, vẫn chép viết tay', () => {
    const dir = mergedFolder();
    const result = applyRegen(dir, planRegen(dir, baseFiles), fakeDeps(dir, M.tables!, G1.sql));
    expect(result.warnings.join('\n')).toContain('drizzle-kit không sinh gì');
    expect(readJournal(dir).entries.map((e) => e.tag)).toEqual([A.tag, M.tag, '20261112100002_rls-bang-moi']);
  });

  it('không sinh ra file thì in các câu của migration cũ sẽ mất, kèm lệnh lấy lại bằng git show', () => {
    const dir = mergedFolder();
    writeFileSync(join(dir, `${G1.tag}.sql`), `${G1.sql}--> statement-breakpoint\nUPDATE x.moi SET a = 1;`);
    const result = applyRegen(dir, planRegen(dir, baseFiles), fakeDeps(dir, M.tables!, G1.sql));
    const text = result.warnings.join('\n');
    expect(text).toContain('UPDATE x.moi SET a = 1;');
    expect(text).toContain('CREATE TABLE "x"."moi" ();');
    expect(text).toContain(`git show HEAD:db/migrations/${G1.tag}.sql`);
  });
});
