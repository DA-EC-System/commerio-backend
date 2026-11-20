import { describe, expect, it } from 'vitest';
import { classifyColumn, parseForeignKeys } from '../../../../../scripts/db/lib/schema-refs.ts';

describe('xếp loại cột chưa có khoá ngoại', () => {
  it('company_id là công ty, cột *_by và người gửi là người thao tác', () => {
    expect(classifyColumn('order.orders', 'company_id', 'uuid', false)).toEqual({ kind: 'tenant', table: 'core.companies' });
    expect(classifyColumn('order.packages', 'packed_by', 'uuid', false)).toEqual({ kind: 'actor', table: 'core.accounts' });
    expect(classifyColumn('channel.messages', 'sender_id', 'uuid', false)).toEqual({ kind: 'actor', table: 'core.accounts' });
  });

  it('cột đã khai trỏ tới bảng của module khác', () => {
    expect(classifyColumn('order.order_lines', 'variant_id', 'uuid', false)).toEqual({ kind: 'logical', table: 'product.product_variants' });
  });

  it('cột đa hình có lý do, không trỏ bảng cố định', () => {
    expect(classifyColumn('core.audit_logs', 'entity_id', 'uuid', false)).toMatchObject({ kind: 'not-ref' });
  });

  it('cột uuid *_id mới chưa khai là unknown, để db:docs báo lỗi', () => {
    expect(classifyColumn('order.orders', 'warehouse_id', 'uuid', false)).toEqual({ kind: 'unknown' });
  });

  it('khoá chính uuid và cột text không phải tham chiếu; mã bên sàn được đánh dấu', () => {
    expect(classifyColumn('order.orders', 'id', 'uuid', true)).toEqual({ kind: 'plain' });
    expect(classifyColumn('order.orders', 'external_order_id', 'text', false)).toEqual({ kind: 'external' });
    expect(classifyColumn('order.orders', 'note', 'text', false)).toEqual({ kind: 'plain' });
  });
});

describe('đọc khoá ngoại viết tay trong file SQL', () => {
  it('nhận khoá ngoại ghép, tên có ngoặc kép, schema "order", ON DELETE', () => {
    const sql = [
      '-- Khoá ngoại ghép.',
      'ALTER TABLE finance.ledger_replacements ADD CONSTRAINT ledger_replacements_actual_fk',
      '  FOREIGN KEY (actual_id, actual_is_estimate) REFERENCES finance.ledger_entries (id, is_estimate);--> statement-breakpoint',
      'ALTER TABLE "order"."package_lines" ADD CONSTRAINT "pl_pkg_fk" FOREIGN KEY ("package_id") REFERENCES "order"."packages"("id") ON DELETE cascade ON UPDATE no action;',
    ].join('\n');
    const { added } = parseForeignKeys(sql, 'm1');
    expect(added).toEqual([
      { from: 'finance.ledger_replacements', name: 'ledger_replacements_actual_fk', fromCols: ['actual_id', 'actual_is_estimate'], to: 'finance.ledger_entries', toCols: ['id', 'is_estimate'], onDelete: null, migration: 'm1' },
      { from: 'order.package_lines', name: 'pl_pkg_fk', fromCols: ['package_id'], to: 'order.packages', toCols: ['id'], onDelete: 'cascade', migration: 'm1' },
    ]);
  });

  it('nhận DROP CONSTRAINT để bỏ khoá ngoại đã xoá', () => {
    expect(parseForeignKeys('ALTER TABLE "channel"."x" DROP CONSTRAINT IF EXISTS "x_fk";', 'm2').dropped).toEqual(['x_fk']);
  });
});
