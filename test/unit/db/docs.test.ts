import { describe, expect, it } from 'vitest';
import { checkDocs } from '../../../scripts/db/lib/docs.ts';

// Tài liệu schema sinh từ db/migrations và comment trong schema.ts (db/CLAUDE.md mục "Tài liệu schema và phiên bản").
// Đỏ khi đổi schema.ts, comment, migration mà chưa chạy `npm run db:docs`, hoặc thêm cột uuid `*_id` chưa khai bảng đích.
describe('tài liệu CSDL sinh tự động', () => {
  it('db/SCHEMA.md, db/schema/*.md, db/VERSIONS.md khớp migration và comment schema.ts (sửa: npm run db:docs)', () => {
    const { stale, problems } = checkDocs('.');
    expect(problems).toEqual([]);
    expect(stale).toEqual([]);
  }, 60_000);
});
