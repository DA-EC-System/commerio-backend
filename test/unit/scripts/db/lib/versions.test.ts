import { describe, expect, it } from 'vitest';
import type { DbSnapshot, SnapTable } from '../../../../../scripts/db/lib/schema-doc.ts';
import { diffSnapshots, leadingSqlComment, sqlKinds } from '../../../../../scripts/db/lib/versions.ts';

const col = (name: string, type: string, notNull = false) => ({ name, type, primaryKey: false, notNull });
const table = (schema: string, name: string, columns: ReturnType<typeof col>[], extra: Partial<SnapTable> = {}): SnapTable => ({
  name,
  schema,
  columns: Object.fromEntries(columns.map((c) => [c.name, c])),
  indexes: {},
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: {},
  checkConstraints: {},
  ...extra,
});
const snap = (tables: SnapTable[], enums: DbSnapshot['enums'] = {}): DbSnapshot => ({
  tables: Object.fromEntries(tables.map((t) => [`${t.schema}.${t.name}`, t])),
  enums,
});

describe('tóm tắt thay đổi giữa hai snapshot', () => {
  it('bảng mới gom theo schema, cột thêm, cột đổi kiểu và null, index mới', () => {
    const before = snap([table('order', 'orders', [col('id', 'uuid', true), col('note', 'text')])]);
    const after = snap([
      table('order', 'orders', [col('id', 'uuid', true), col('note', 'varchar', true), col('cancel_pending', 'boolean', true)], {
        indexes: { orders_note_idx: { name: 'orders_note_idx', columns: [{ expression: 'note' }], isUnique: false } },
      }),
      table('order', 'packages', [col('id', 'uuid', true)]),
      table('order', 'package_lines', [col('id', 'uuid', true)]),
    ]);
    expect(diffSnapshots(before, after)).toEqual([
      '+ 2 bảng `order`: packages, package_lines',
      '`order.orders`: + cột `cancel_pending`; đổi cột `note` (kiểu text → varchar, thành not null); + index `orders_note_idx`',
    ]);
  });

  it('bảng bị xoá và giá trị enum thêm vào', () => {
    const before = snap([table('channel', 'category_maps', [])], { 'order.order_status': { name: 'order_status', schema: 'order', values: ['unpaid'] } });
    const after = snap([], { 'order.order_status': { name: 'order_status', schema: 'order', values: ['unpaid', 'processing'] } });
    expect(diffSnapshots(before, after)).toEqual(['− bảng `channel.category_maps`', 'enum `order.order_status`: + `processing`']);
  });

  it('snapshot giống nhau thì không có dòng nào', () => {
    const s = snap([table('core', 'files', [col('id', 'uuid', true)])]);
    expect(diffSnapshots(s, s)).toEqual([]);
  });
});

describe('tóm tắt migration viết tay', () => {
  it('lấy câu đầu của comment mở đầu, bỏ dòng mẫu của drizzle-kit', () => {
    const sql = '-- Custom SQL migration file, put your code below! --\n-- Bật RLS cho bảng mới. Dòng sau không lấy.\n-- tiếp\nALTER TABLE x ENABLE ROW LEVEL SECURITY;';
    expect(leadingSqlComment(sql)).toBe('Bật RLS cho bảng mới.');
  });

  it('nhận loại câu lệnh, bỏ qua chữ trong comment', () => {
    const sql = [
      '-- update lại dữ liệu cũ (chữ trong comment không tính)',
      'ALTER TABLE core.files ENABLE ROW LEVEL SECURITY;',
      'GRANT SELECT ON core.files TO commerio_app;',
      'UPDATE core.files SET purpose = 1;',
    ].join('\n');
    expect(sqlKinds(sql)).toEqual(['RLS', 'quyền', 'dữ liệu']);
    expect(sqlKinds('-- update x\nALTER TABLE a ADD COLUMN b int;')).toEqual([]);
  });
});
