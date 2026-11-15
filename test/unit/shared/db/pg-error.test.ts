import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isConnectionUnavailable, pgError } from '#src/shared/db/pg-error.ts';

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

describe('isConnectionUnavailable', () => {
  it('nhận ra pool chờ quá DB_CONNECT_TIMEOUT_MS, kể cả khi Drizzle bọc lỗi (#335)', () => {
    const timeout = new Error('timeout exceeded when trying to connect');
    expect(isConnectionUnavailable(timeout)).toBe(true);
    expect(isConnectionUnavailable(new DrizzleQueryError('select 1', [], timeout))).toBe(true);
  });

  it('nhận ra Session pooler từ chối vì hết chỗ', () => {
    const full = new Error('(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15');
    expect(isConnectionUnavailable(full)).toBe(true);
  });

  it('lỗi truy vấn khác không tính là hết kết nối', () => {
    expect(isConnectionUnavailable(pgUnique())).toBe(false);
    expect(isConnectionUnavailable(undefined)).toBe(false);
  });
});
