// Ánh xạ nền tảng (dữ liệu chung, be#522): migration `*_anh-xa-hai-tang-chuyen` chép `defaultSpecMappings` của adapter thành
// dòng `company_id` NULL. Hằng là nguồn; sửa hằng mà quên migration thì test này đỏ.
import { describe, expect, it } from 'vitest';
import { LAZADA_SPEC_MAPPINGS } from '#src/modules/channel/channel/service/marketplaces/lazada-spec-mappings.ts';
import { TIKTOK_SPEC_MAPPINGS } from '#src/modules/channel/channel/service/marketplaces/tiktok-spec-mappings.ts';
import { testPool } from '../../helpers/db.ts';

describe.each([
  ['lazada', LAZADA_SPEC_MAPPINGS],
  ['tiktok', TIKTOK_SPEC_MAPPINGS],
])('ánh xạ nền tảng %s', (platform, defaults) => {
  it('dòng nền tảng của thông số chuẩn khớp hằng của adapter, đúng thứ tự priority', async () => {
    const { rows } = await testPool().query<{ code: string; codes: string[] }>(
      `select f.code, array_agg(m.attribute_code order by m.priority) as codes
       from channel.spec_field_mappings m join product.spec_fields f on f.id = m.field_id
       where m.company_id is null and f.company_id is null and m.platform = $1 and f.code = any($2)
       group by f.code`,
      [platform, Object.keys(defaults)],
    );
    const { rows: std } = await testPool().query<{ code: string }>(`select code from product.spec_fields where company_id is null and code = any($1)`, [
      Object.keys(defaults),
    ]);
    const expected = Object.fromEntries(std.map((r) => [r.code, [...defaults[r.code]!]]));
    expect(Object.fromEntries(rows.map((r) => [r.code, r.codes]))).toEqual(expected);
    expect(std.length).toBeGreaterThan(0);
  });
});
