import { describe, expect, it } from 'vitest';
import { isTestCompany } from '#src/modules/core/platform/service/test-company.ts';

describe('isTestCompany: luật chặn xoá công ty thật', () => {
  const ok = { members: 2, outsideMembers: 0, platformAdmins: 0, outsideInvitations: 0 };

  it('mọi thành viên, lời mời thuộc miền thử, không ai là quản trị nền tảng: là công ty thử', () => {
    expect(isTestCompany(ok)).toBe(true);
  });

  it.each([
    ['không có thành viên', { members: 0 }],
    ['có thành viên ngoài miền thử', { outsideMembers: 1 }],
    ['có quản trị nền tảng', { platformAdmins: 1 }],
    ['có lời mời đang chờ ngoài miền thử', { outsideInvitations: 1 }],
  ])('%s: không phải công ty thử', (_name, patch) => {
    expect(isTestCompany({ ...ok, ...patch })).toBe(false);
  });
});
