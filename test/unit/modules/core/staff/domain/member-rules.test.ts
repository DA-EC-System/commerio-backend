import { describe, expect, it } from 'vitest';
import type { RoleWithPermissions } from '#src/modules/core/access/index.ts';
import { checkRoleGrant, isProtectedTarget } from '#src/modules/core/staff/domain/member-rules.ts';

const role = (id: string, permissions: string[], isCeo = false, freelyAssignable = false): RoleWithPermissions => ({
  id,
  name: id,
  isCeo,
  freelyAssignable,
  permissions,
});
const ceo = role('ceo', ['identity.account.manage', 'finance.invoice.view'], true);
const sale = role('sale', ['sales.order.view']);
const kho = role('kho', ['inventory.receipt.create']);
// Vai có sẵn Sale, Nhân viên kho: gán không so quyền (Documents/21 I5, đổi 17/11/2026, #351).
const builtinSale = role('builtin-sale', ['fulfillment.delivery.update'], false, true);
const builtinKho = role('builtin-kho', ['inventory.receipt.create', 'purchasing.request.manage'], false, true);
const adminRole = role('admin', ['identity.account.manage', 'platform.audit.view']);
const adminPerms = ['identity.account.manage', 'sales.order.view'];

// Luật gán vai trò khi đổi vai trò, tạo link mời, duyệt (#7 [B], [C]; Documents/21 I5).
describe('checkRoleGrant', () => {
  it('thêm vai trò mà người gọi có đủ quyền thì ok', () => {
    expect(checkRoleGrant({ requestedIds: ['sale'], found: [sale], currentRoles: [], callerPermissions: adminPerms })).toBe('ok');
  });

  it('thêm vai trò có quyền người gọi không có là not_held', () => {
    expect(checkRoleGrant({ requestedIds: ['kho'], found: [kho], currentRoles: [], callerPermissions: adminPerms })).toBe('not_held');
  });

  it('gỡ vai trò có quyền người gọi không có cũng là not_held', () => {
    expect(
      checkRoleGrant({ requestedIds: ['sale'], found: [sale], currentRoles: [sale, kho], callerPermissions: adminPerms }),
    ).toBe('not_held');
  });

  it('giữ nguyên vai trò mình không đủ quyền thì vẫn ok', () => {
    expect(
      checkRoleGrant({ requestedIds: ['kho', 'sale'], found: [kho, sale], currentRoles: [kho], callerPermissions: adminPerms }),
    ).toBe('ok');
  });

  it('có vai trò CEO là ceo_role, trước not_held', () => {
    expect(checkRoleGrant({ requestedIds: ['ceo', 'kho'], found: [ceo, kho], currentRoles: [], callerPermissions: [] })).toBe(
      'ceo_role',
    );
  });

  it('id không có trong found là unknown_roles, trước ceo_role', () => {
    expect(checkRoleGrant({ requestedIds: ['ceo', 'la'], found: [ceo], currentRoles: [], callerPermissions: [] })).toBe(
      'unknown_roles',
    );
  });

  it('#351: thêm vai có sẵn Sale, Kho dù người gọi thiếu quyền của chúng thì ok', () => {
    expect(
      checkRoleGrant({ requestedIds: ['builtin-sale', 'builtin-kho'], found: [builtinSale, builtinKho], currentRoles: [], callerPermissions: adminPerms }),
    ).toBe('ok');
  });

  it('#351: gỡ vai có sẵn Kho dù người gọi thiếu quyền của nó thì ok', () => {
    expect(
      checkRoleGrant({ requestedIds: ['builtin-sale'], found: [builtinSale], currentRoles: [builtinSale, builtinKho], callerPermissions: [] }),
    ).toBe('ok');
  });

  it('#351: thêm Kho cùng lúc gỡ vai tự tạo thiếu quyền vẫn là not_held', () => {
    expect(
      checkRoleGrant({ requestedIds: ['builtin-kho'], found: [builtinKho], currentRoles: [kho], callerPermissions: adminPerms }),
    ).toBe('not_held');
  });

  it('#351: vai Admin không được đặc cách: thêm hay gỡ khi thiếu quyền là not_held', () => {
    const manager = ['identity.account.manage'];
    expect(checkRoleGrant({ requestedIds: ['admin'], found: [adminRole], currentRoles: [], callerPermissions: manager })).toBe('not_held');
    expect(
      checkRoleGrant({ requestedIds: ['builtin-sale'], found: [builtinSale], currentRoles: [adminRole], callerPermissions: manager }),
    ).toBe('not_held');
  });

  it('id gửi trùng không làm sai kết quả', () => {
    expect(
      checkRoleGrant({ requestedIds: ['sale', 'sale'], found: [sale], currentRoles: [sale], callerPermissions: [] }),
    ).toBe('ok');
  });
});

describe('isProtectedTarget', () => {
  it('đích là chính người gọi', () => {
    expect(isProtectedTarget({ callerId: 'a', targetId: 'a', targetRoles: [sale] })).toBe(true);
  });

  it('đích mang vai trò CEO', () => {
    expect(isProtectedTarget({ callerId: 'a', targetId: 'b', targetRoles: [sale, ceo] })).toBe(true);
  });

  it('người khác không phải CEO thì không được bảo vệ', () => {
    expect(isProtectedTarget({ callerId: 'a', targetId: 'b', targetRoles: [sale] })).toBe(false);
  });
});
