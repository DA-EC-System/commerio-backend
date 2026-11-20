import { describe, expect, it } from 'vitest';
import { parseDocLines, parseSchemaFile } from '../../../../../scripts/db/lib/schema-source.ts';

const SOURCE = `import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';

export const salesSchema = pgSchema('order');

/** Trạng thái đơn. */
export const orderStatus = salesSchema.enum('order_status', ['unpaid', 'paid']);

/**
 * Đơn hàng.
 * Dòng hai của mô tả.
 * @deprecated Thay bằng bảng khác (#1).
 */
export const orders = salesSchema.table('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Ghi chú cột,
  // nối dòng.
  note: text('note'),
  // Comment cách một dòng trống không thuộc cột sau.

  // Chỉ dòng này.
  code: text('code').notNull(),
  /** @deprecated Cột cũ, không ghi nữa. */
  legacyFlag: text('legacy_flag'),
  plain: text('plain'),
});
`;

describe('đọc comment trong schema.ts', () => {
  const { tables, enums } = parseSchemaFile(SOURCE, 'src/modules/order/sales/repository/schema.ts', 'sales');
  const orders = tables[0]!;

  it('nhận bảng theo pgSchema của file, module con và dòng khai báo', () => {
    expect(tables.map((t) => t.id)).toEqual(['order.orders']);
    expect(orders.sub).toBe('sales');
    expect(orders.line).toBe(13);
  });

  it('tách mô tả và lý do @deprecated của bảng', () => {
    expect(orders.text).toBe('Đơn hàng. Dòng hai của mô tả.');
    expect(orders.deprecated).toBe('Thay bằng bảng khác (#1).');
  });

  it('comment cột theo tên cột SQL, nối các dòng // liền nhau, dừng ở dòng trống', () => {
    expect(orders.columns.get('note')?.text).toBe('Ghi chú cột, nối dòng.');
    expect(orders.columns.get('code')?.text).toBe('Chỉ dòng này.');
    expect(orders.columns.get('plain')).toEqual({ text: '', deprecated: null });
  });

  it('thẻ @deprecated của cột, khoá là tên cột SQL không phải tên thuộc tính TS', () => {
    expect(orders.columns.get('legacy_flag')).toEqual({ text: '', deprecated: 'Cột cũ, không ghi nữa.' });
  });

  it('đọc mô tả enum', () => {
    expect(enums).toEqual([['order.order_status', { text: 'Trạng thái đơn.', deprecated: null }]]);
  });

  it('@deprecated không kèm lý do vẫn là đã bỏ, thẻ khác không lẫn vào mô tả', () => {
    expect(parseDocLines(['Mô tả.', '@see khác', '@deprecated'])).toEqual({ text: 'Mô tả.', deprecated: '' });
  });
});
