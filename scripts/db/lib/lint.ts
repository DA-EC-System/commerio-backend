// Kiểm bộ migration không cần DB: journal, file, chuỗi snapshot, và thứ tự so với nhánh gốc (main). Hàm trả danh sách lỗi
// tiếng Việt; rỗng là đạt.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatWhen,
  hashSql,
  listSnapshotFiles,
  listSqlFiles,
  readJournal,
  readSnapshot,
  ROOT_SNAPSHOT_ID,
  snapshotName,
  type Journal,
} from './journal.ts';

/** journal liền mạch, `when` tăng, đủ file, không file thừa, snapshot nối đúng cha. */
export function lintFolder(dir: string): string[] {
  const errors: string[] = [];
  let journal: Journal;
  try {
    journal = readJournal(dir);
  } catch (error) {
    return [(error as Error).message];
  }
  const entries = journal.entries;

  entries.forEach((entry, i) => {
    if (entry.idx !== i) errors.push(`journal đứt idx: vị trí ${i} có idx ${entry.idx} (${entry.tag})`);
  });
  for (let i = 1; i < entries.length; i++) {
    const [prev, cur] = [entries[i - 1]!, entries[i]!];
    if (!(cur.when > prev.when)) {
      errors.push(`when không tăng: ${cur.tag} (${formatWhen(cur.when)}) đứng sau ${prev.tag} (${formatWhen(prev.when)})`);
    }
  }

  const tags = new Set(entries.map((e) => e.tag));
  for (const entry of entries) {
    if (!existsSync(join(dir, `${entry.tag}.sql`))) errors.push(`thiếu file ${entry.tag}.sql có trong journal`);
    if (!existsSync(join(dir, 'meta', snapshotName(entry.tag)))) errors.push(`thiếu snapshot meta/${snapshotName(entry.tag)} của ${entry.tag}`);
  }
  // File .sql không có trong journal thì drizzle không bao giờ chạy.
  for (const file of listSqlFiles(dir)) {
    if (!tags.has(file.slice(0, -'.sql'.length))) errors.push(`file ${file} không có trong journal: drizzle sẽ không chạy`);
  }
  const snapshotsInJournal = new Set(entries.map((e) => snapshotName(e.tag)));
  for (const file of listSnapshotFiles(dir)) {
    if (!snapshotsInJournal.has(file)) errors.push(`snapshot meta/${file} không thuộc migration nào trong journal`);
  }

  // Chuỗi snapshot: prevId của mỗi snapshot là id của snapshot liền trước theo journal.
  let prevId = ROOT_SNAPSHOT_ID;
  const seen = new Set<string>();
  for (const entry of entries) {
    const file = snapshotName(entry.tag);
    if (!existsSync(join(dir, 'meta', file))) {
      prevId = '';
      continue;
    }
    const snapshot = readSnapshot(dir, file);
    if (prevId !== '' && snapshot.prevId !== prevId) {
      errors.push(`snapshot ${file} (${entry.tag}) trỏ sai cha: prevId ${snapshot.prevId}, cần ${prevId} của migration liền trước`);
    }
    if (seen.has(snapshot.id)) errors.push(`snapshot ${file} trùng id ${snapshot.id} với snapshot khác`);
    seen.add(snapshot.id);
    prevId = snapshot.id;
  }
  return errors;
}

export interface BaseMigrations {
  /** Tên ref để in ra, vd `origin/main`. */
  ref: string;
  journal: Journal;
  /** Nội dung file .sql trên ref gốc. */
  readSql: (tag: string) => string;
}

/**
 * Migration của nhánh phải đứng sau mọi migration trên gốc: journal của gốc là phần đầu của journal nhánh (cùng tag, when),
 * file .sql của gốc không bị sửa, và mỗi migration thêm mới có `when` lớn hơn và tên đứng sau migration cuối của gốc.
 */
export function lintAgainstBase(dir: string, base: BaseMigrations): string[] {
  const errors: string[] = [];
  let head: Journal;
  try {
    head = readJournal(dir);
  } catch (error) {
    return [(error as Error).message];
  }
  const headByTag = new Map(head.entries.map((e, i) => [e.tag, { entry: e, pos: i }]));
  const baseTags = new Set(base.journal.entries.map((e) => e.tag));

  base.journal.entries.forEach((b, i) => {
    const found = headByTag.get(b.tag);
    if (!found) {
      errors.push(`nhánh thiếu migration ${b.tag} đã có trên ${base.ref}`);
      return;
    }
    if (found.pos !== i) errors.push(`migration ${b.tag} của ${base.ref} đứng ở vị trí ${found.pos} trong journal, trên ${base.ref} là ${i}`);
    if (found.entry.when !== b.when) errors.push(`migration ${b.tag} đổi when so với ${base.ref}`);
    const file = join(dir, `${b.tag}.sql`);
    if (existsSync(file) && hashSql(readFileSync(file).toString()) !== hashSql(base.readSql(b.tag))) {
      errors.push(`file ${b.tag}.sql khác bản trên ${base.ref}: không sửa migration đã merge, sinh migration mới`);
    }
  });

  const lastBase = base.journal.entries.at(-1);
  if (lastBase) {
    for (const entry of head.entries) {
      if (baseTags.has(entry.tag)) continue;
      if (entry.when <= lastBase.when || entry.tag <= lastBase.tag) {
        errors.push(
          `migration ${entry.tag} (${formatWhen(entry.when)}) không đứng sau migration mới nhất trên ${base.ref} ` +
            `${lastBase.tag} (${formatWhen(lastBase.when)}): staging sẽ bỏ qua nó mà không báo lỗi`,
        );
      }
    }
  }
  return errors;
}
