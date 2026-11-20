import { afterEach, describe, expect, it } from 'vitest';
import { migrationKinds, versionLabel } from '../../../../../scripts/db/lib/journal.ts';
import { cleanupFakeDirs, fakeMigrations } from './fake-migrations.ts';

afterEach(cleanupFakeDirs);

describe('loại migration theo snapshot', () => {
  it('snapshot giống cha là viết tay, khác cha là sinh từ schema', () => {
    const dir = fakeMigrations([
      { tag: '0000_a', when: 1000, tables: { t1: {} } },
      { tag: '20261101000000_rls', when: 2000 },
      { tag: '20261102000000_cot', when: 3000, tables: { t1: {}, t2: {} } },
    ]);
    expect([...migrationKinds(dir)]).toEqual([
      ['0000_a', 'generated'],
      ['20261101000000_rls', 'custom'],
      ['20261102000000_cot', 'generated'],
    ]);
  });

  it('migration đầu tiên không tạo bảng (chỉ extension) là viết tay', () => {
    const dir = fakeMigrations([{ tag: '0000_mo-rong', when: 1000 }, { tag: '0001_tao-bang', when: 2000, tables: { t1: {} } }]);
    expect(migrationKinds(dir).get('0000_mo-rong')).toBe('custom');
    expect(migrationKinds(dir).get('0001_tao-bang')).toBe('generated');
  });
});

describe('phiên bản V', () => {
  it('là vị trí trong journal tính từ 1', () => {
    expect(versionLabel({ idx: 0 })).toBe('V1');
    expect(versionLabel({ idx: 104 })).toBe('V105');
  });
});
