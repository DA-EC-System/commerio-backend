// Sinh lại migration của nhánh lên trên bộ migration của main (db:regen). Phần phụ thuộc git và drizzle-kit truyền vào
// qua RegenDeps để test được bằng thư mục giả.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  journalPath,
  listSnapshotFiles,
  listSqlFiles,
  readJournal,
  readSnapshot,
  slugOf,
  snapshotBody,
  snapshotName,
} from './journal.ts';
import { lintFolder } from './lint.ts';

export type MigrationKind = 'generated' | 'custom';

export interface BranchMigration {
  tag: string;
  slug: string;
  /** `custom`: snapshot giống hệt snapshot cha (viết tay bằng `--custom`, vd RLS, quyền, dữ liệu). */
  kind: MigrationKind;
  sql: string;
}

export type RegenStep = { kind: 'custom'; from: BranchMigration } | { kind: 'schema'; name: string; from: BranchMigration[] };

export interface RegenPlan {
  migrations: BranchMigration[];
  steps: RegenStep[];
  /** File của nhánh sẽ xoá (đường dẫn tương đối trong thư mục migration). */
  remove: string[];
  warnings: string[];
}

/** Độ dài tối đa của tên ghép từ nhiều slug. */
const MAX_NAME = 80;

/**
 * Migration của nhánh là file .sql không có trên gốc. Phân loại theo snapshot: viết tay khi snapshot giống hệt snapshot
 * cha (`prevId`), còn lại là do drizzle-kit sinh từ schema.ts.
 */
export function planRegen(dir: string, baseFiles: Set<string>): RegenPlan {
  const branchSql = listSqlFiles(dir).filter((f) => !baseFiles.has(f));
  const branchSnapshots = listSnapshotFiles(dir).filter((f) => !baseFiles.has(`meta/${f}`));
  const bodies = new Map<string, string>();
  for (const file of listSnapshotFiles(dir)) {
    const snapshot = readSnapshot(dir, file);
    bodies.set(snapshot.id, snapshotBody(snapshot));
  }

  const warnings: string[] = [];
  const migrations: BranchMigration[] = branchSql.map((file) => {
    const tag = file.slice(0, -'.sql'.length);
    const snap = snapshotName(tag);
    if (!existsSync(join(dir, 'meta', snap))) {
      throw new Error(`${file} không có snapshot meta/${snap}: không biết là migration sinh hay viết tay, sửa tay trước`);
    }
    const snapshot = readSnapshot(dir, snap);
    const parent = bodies.get(snapshot.prevId);
    if (parent === undefined) warnings.push(`${tag}: không tìm thấy snapshot cha ${snapshot.prevId}, coi là migration sinh từ schema`);
    const kind: MigrationKind = parent !== undefined && parent === snapshotBody(snapshot) ? 'custom' : 'generated';
    return { tag, slug: slugOf(tag), kind, sql: readFileSync(join(dir, file), 'utf8') };
  });

  const firstGen = migrations.findIndex((m) => m.kind === 'generated');
  const lastGen = migrations.findLastIndex((m) => m.kind === 'generated');
  const steps: RegenStep[] = [];
  migrations.forEach((m, i) => {
    if (m.kind === 'custom') {
      steps.push({ kind: 'custom', from: m });
      if (i > firstGen && i < lastGen && firstGen >= 0) {
        warnings.push(
          `${m.tag} (viết tay) trước đây chạy giữa hai migration sinh; nay chạy sau migration sinh gộp: kiểm lại nếu nó phải chạy trước phần schema sau nó`,
        );
      }
    } else if (i === firstGen) {
      const generated = migrations.filter((g) => g.kind === 'generated');
      steps.push({ kind: 'schema', name: joinSlugs(generated.map((g) => g.slug)), from: generated });
    }
  });
  // Bước schema đứng ở vị trí migration sinh đầu tiên; viết tay đứng sau nó giữ nguyên thứ tự.
  const remove = [...branchSql, ...branchSnapshots.map((f) => `meta/${f}`)];
  return { migrations, steps, remove, warnings };
}

function joinSlugs(slugs: string[]): string {
  const unique = [...new Set(slugs)];
  const name = unique.join('-');
  return name.length <= MAX_NAME ? name : name.slice(0, MAX_NAME).replace(/-+$/, '');
}

export interface RegenDeps {
  /** Nội dung `meta/_journal.json` trên gốc. */
  baseJournal: string;
  /** Chạy `drizzle-kit generate --name <name>` (thêm `--custom` khi kind là custom). */
  generate: (kind: 'schema' | 'custom', name: string) => void;
  /** Chờ sang giây mới: tên file và snapshot theo giây, hai lần sinh trong cùng giây sẽ đè snapshot của nhau. */
  waitNextSecond: () => void;
}

export interface RegenResult {
  renamed: { from: string[]; to: string; kind: MigrationKind }[];
  warnings: string[];
  errors: string[];
}

/** Câu lệnh SQL bỏ comment và khoảng trắng thừa, để so migration sinh cũ với bản sinh lại. */
function statements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export function applyRegen(dir: string, plan: RegenPlan, deps: RegenDeps): RegenResult {
  const warnings = [...plan.warnings];
  for (const file of plan.remove) rmSync(join(dir, file), { force: true });
  writeFileSync(journalPath(dir), deps.baseJournal);

  const renamed: RegenResult['renamed'] = [];
  for (const step of plan.steps) {
    deps.waitNextSecond();
    const before = readJournal(dir).entries.length;
    deps.generate(step.kind, step.kind === 'custom' ? step.from.slug : step.name);
    const entries = readJournal(dir).entries;
    const created = entries.length > before ? entries.at(-1)!.tag : undefined;
    if (step.kind === 'custom') {
      if (!created) throw new Error(`drizzle-kit generate --custom không tạo migration cho ${step.from.tag}`);
      writeFileSync(join(dir, `${created}.sql`), step.from.sql);
      renamed.push({ from: [step.from.tag], to: created, kind: 'custom' });
      continue;
    }
    const oldTags = step.from.map((m) => m.tag);
    if (!created) {
      warnings.push(`drizzle-kit không sinh gì cho ${oldTags.join(', ')}: thay đổi schema của nhánh đã có trên main?`);
      continue;
    }
    renamed.push({ from: oldTags, to: created, kind: 'generated' });
    // Câu lệnh của bản cũ không có trong bản sinh lại: viết tay thêm vào migration sinh, hoặc main đã đổi cùng chỗ.
    const fresh = new Set(statements(readFileSync(join(dir, `${created}.sql`), 'utf8')));
    for (const old of step.from) {
      const lost = statements(old.sql).filter((s) => !fresh.has(s));
      if (lost.length > 0) {
        warnings.push(
          `${old.tag}: ${lost.length} câu lệnh của bản cũ không có trong ${created}.sql (viết tay thêm vào migration sinh?), chép tay nếu còn cần:\n` +
            lost.map((s) => `      ${s}`).join('\n'),
        );
      }
    }
  }
  return { renamed, warnings, errors: lintFolder(dir) };
}
