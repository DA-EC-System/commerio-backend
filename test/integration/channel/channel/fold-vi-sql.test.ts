// `foldVi` (Node) và `foldSql` (PostgreSQL `translate(normalize(…, NFC), …)`) phải ra cùng chuỗi: tìm kiếm lọc trong CSDL,
// lõi gợi ý so trong Node (#565, Documents/21 §18.12). Chạy trên PostgreSQL thật vì `normalize`, `translate` của CSDL.
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { FOLD_FROM, foldVi } from '#src/modules/channel/channel/domain/fold-vi.ts';
import { foldSql } from '#src/modules/channel/channel/repository/remote-skus.ts';
import { getDb } from '#src/shared/db/client.ts';

const SAMPLES = [
  'Áo Thun ĐEN đậm, size M',
  'đĐ Đỏ đô ĐƯỜNG',
  'Ắ Ằ Ẳ Ẵ Ặ ấ ầ ẩ ẫ ậ ế ề ể ễ ệ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ứ ừ ử ữ ự ỳ ỷ ỹ ỵ ý',
  'Phở bò tái'.normalize('NFD'),
  'Café crème brûlée · 100% ★ ß Ø Æ',
  'Int:M / Xanh lá - 2024',
  FOLD_FROM,
];

describe('foldSql và foldVi cùng kết quả', () => {
  it.each(SAMPLES)('%s', async (s) => {
    const { rows } = await getDb().execute<{ v: string }>(sql`select ${foldSql(sql`${s}::text`)} as v`);
    expect(rows[0]!.v).toBe(foldVi(s));
  });

  it('Đ và đ ra d ở cả hai bên', async () => {
    const { rows } = await getDb().execute<{ v: string }>(sql`select ${foldSql(sql`${'Đđ'}::text`)} as v`);
    expect(rows[0]!.v).toBe('dd');
    expect(foldVi('Đđ')).toBe('dd');
  });
});
