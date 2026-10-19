import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { pgError } from '#src/shared/db/pg-error.ts';

const pgUnique = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'accounts_email_unique' });

describe('pgError', () => {
  it('đọc mã và ràng buộc của lỗi PostgreSQL trần', () => {
    expect(pgError(pgUnique())).toEqual({ code: '23505', constraint: 'accounts_email_unique' });
  });

  it('đọc qua cause khi Drizzle bọc lỗi', () => {
    const wrapped = new DrizzleQueryError('insert into t values ($1)', ['x'], pgUnique());
    expect(pgError(wrapped)).toEqual({ code: '23505', constraint: 'accounts_email_unique' });
  });

  it('lỗi không phải của PostgreSQL thì không có mã', () => {
    expect(pgError(new Error('khác'))).toEqual({ code: undefined, constraint: undefined });
    expect(pgError(undefined)).toEqual({ code: undefined, constraint: undefined });
  });
});
