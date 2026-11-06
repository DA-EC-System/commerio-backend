import { describe, expect, it } from 'vitest';
import {
  areaOf,
  documentKind,
  type MoveSource,
  type StockDocumentKind,
} from '#src/modules/product/inventory/domain/moves.ts';

// Luật suy nhóm chứng từ và ngăn của thẻ kho (#206 phần 2a, spec 2026-11-06-206-so-lieu-the-kho-design.md mục 5.2).
const doc = (
  kind: StockDocumentKind,
  extra: { isOpening?: boolean; sourceType?: string | null } = {},
): MoveSource => ({
  type: 'stock_document',
  kind,
  isOpening: extra.isOpening ?? false,
  sourceType: extra.sourceType ?? null,
});

describe('documentKind', () => {
  it.each([
    ['phiếu nhận', { type: 'goods_receipt' } as MoveSource, 'purchase'],
    ['phiếu trả NCC', { type: 'supplier_return' } as MoveSource, 'purchase'],
    ['phiếu xuất theo kiện', doc('shipment', { sourceType: 'package' }), 'order'],
    ['phiếu đảo bàn giao', doc('shipment_reversal', { sourceType: 'package' }), 'order'],
    ['kiểm hàng về', doc('return_inspection', { sourceType: 'package' }), 'auto'],
    ['kiểm kê đầu kỳ', doc('stocktake', { isOpening: true }), 'auto'],
    ['xuất huỷ sinh từ phiếu khác', doc('write_off', { sourceType: 'stock_document' }), 'auto'],
    ['kiểm kê sinh từ phiếu khác, không phải đầu kỳ', doc('stocktake', { sourceType: 'stock_document' }), 'auto'],
    ['kiểm kê lập tay', doc('stocktake'), 'manual'],
    ['xuất huỷ lập tay', doc('write_off'), 'manual'],
    ['chuyển chờ xử lý lập tay', doc('to_quarantine'), 'manual'],
  ])('%s → %s', (_name, source, kind) => {
    expect(documentKind(source)).toBe(kind);
  });
});

describe('areaOf', () => {
  it('on_hand → stock, quarantine giữ nguyên', () => {
    expect([areaOf('on_hand'), areaOf('quarantine')]).toEqual(['stock', 'quarantine']);
  });
});
