import { describe, expect, it } from 'vitest';
import { classifyColumn, LOGICAL_REFS, NOT_REFS, unusedRefKeys } from '../../../../../scripts/db/lib/schema-refs.ts';

describe('xếp loại cột chưa có khoá ngoại', () => {
  it('company_id là công ty, cột *_by là người thao tác', () => {
    expect(classifyColumn('order.orders', 'company_id', 'uuid', false)).toEqual({ kind: 'tenant', table: 'core.companies' });
    expect(classifyColumn('order.packages', 'packed_by', 'uuid', false)).toEqual({ kind: 'actor', table: 'core.accounts' });
  });

  it('tên theo quy ước <bảng>_id nhận bảng đích ở mọi bảng', () => {
    expect(classifyColumn('order.order_lines', 'variant_id', 'uuid', false)).toEqual({ kind: 'logical', table: 'product.product_variants', key: 'variant_id' });
  });

  it('tên mang nghĩa riêng chỉ nhận ở đúng bảng đã khai; cùng tên ở bảng khác phải khai lại', () => {
    expect(classifyColumn('order.return_requests', 'inspection_id', 'uuid', false)).toMatchObject({ kind: 'logical', table: 'product.stock_documents' });
    expect(classifyColumn('finance.receipts', 'inspection_id', 'uuid', false)).toEqual({ kind: 'unknown' });
  });

  it('cột trong khoá chính ghép vẫn là tham chiếu; khoá chính một cột thì không', () => {
    expect(classifyColumn('core.member_roles', 'membership_id', 'uuid', false)).toMatchObject({ kind: 'logical', table: 'core.memberships' });
    expect(classifyColumn('order.orders', 'id', 'uuid', true)).toEqual({ kind: 'plain' });
  });

  it('người gửi tin không trỏ cố định tài khoản: tin đến là của khách', () => {
    expect(classifyColumn('channel.messages', 'sender_id', 'uuid', false)).toMatchObject({ kind: 'not-ref' });
  });

  it('cột đa hình có lý do; cột uuid *_id mới chưa khai là unknown để db:docs báo lỗi', () => {
    expect(classifyColumn('core.audit_logs', 'entity_id', 'uuid', false)).toMatchObject({ kind: 'not-ref', key: 'entity_id' });
    expect(classifyColumn('order.orders', 'warehouse_id', 'uuid', false)).toEqual({ kind: 'unknown' });
  });

  it('cột text không phải tham chiếu; mã bên sàn được đánh dấu', () => {
    expect(classifyColumn('order.orders', 'external_order_id', 'text', false)).toEqual({ kind: 'external' });
    expect(classifyColumn('order.orders', 'note', 'text', false)).toEqual({ kind: 'plain' });
  });

  it('mục khai không khớp cột nào được liệt kê để xoá', () => {
    const all = new Set([...Object.keys(LOGICAL_REFS), ...Object.keys(NOT_REFS)]);
    all.delete('family_id');
    expect(unusedRefKeys(all)).toEqual(['family_id']);
  });
});
