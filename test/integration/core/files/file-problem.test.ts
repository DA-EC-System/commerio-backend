import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fileProblem, publicFileUrls } from '#src/modules/core/files/index.ts';
import { env } from '#src/shared/config/env.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// Kiểm tệp gắn được theo mục đích và link công khai của ảnh (#303; Documents/21 §5.4 P10, V26, §14.3). Dòng
// `core.files` chèn thẳng bằng role chủ bảng: không cần vé, không cần kho.

type Purpose = 'product_image' | 'attachment';

async function fileRow(
  companyId: string,
  f: { purpose: Purpose; name?: string; contentType?: string; sizeBytes?: number; uploaded?: boolean },
) {
  const id = randomUUID();
  const key = `test/${id}.jpg`;
  await testPool().query(
    `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
     values ($1, $2, $3, $4, $5, $6, $7, case when $8::boolean then now() end)`,
    [id, companyId, key, f.name ?? 'anh.jpg', f.contentType ?? 'image/jpeg', f.sizeBytes ?? 2048, f.purpose, f.uploaded ?? true],
  );
  return { id, key };
}

let A: string;
let B: string;
const problem = (ids: string[], purpose: Purpose = 'product_image', max = 9) => withCompany(A, () => fileProblem(ids, purpose, max));
const images = async (n: number) => Promise.all(Array.from({ length: n }, () => fileRow(A, { purpose: 'product_image' })));

beforeAll(async () => {
  A = (await createCompany()).companyId;
  B = (await createCompany()).companyId;
});

describe('fileProblem: ảnh sản phẩm', () => {
  it('ảnh JPG, PNG đã tải xong thì gắn được', async () => {
    const jpg = await fileRow(A, { purpose: 'product_image' });
    const png = await fileRow(A, { purpose: 'product_image', name: 'b.png', contentType: 'image/png' });
    expect(await problem([jpg.id, png.id])).toBeNull();
  });

  it('quá số ảnh tối đa', async () => {
    expect(await problem((await images(10)).map((f) => f.id))).toBe('Tối đa 9 ảnh');
  });

  it('ảnh lặp', async () => {
    const [a] = await images(1);
    expect(await problem([a!.id, a!.id])).toBe('Ảnh bị trùng');
  });

  it.each([
    ['chưa PUT xong', () => fileRow(A, { purpose: 'product_image', uploaded: false }).then((f) => f.id)],
    ['của công ty khác', () => fileRow(B, { purpose: 'product_image' }).then((f) => f.id)],
    ['là tệp đính kèm', () => fileRow(A, { purpose: 'attachment' }).then((f) => f.id)],
    ['id không phải uuid', async () => 'abc'],
  ])('ảnh %s thì không gắn được', async (_case, make) => {
    expect(await problem([await make()])).toBe('Có ảnh chưa tải xong hoặc không thuộc công ty');
  });

  it('ảnh WebP xin vé trước khi đổi luật thì báo theo tên tệp', async () => {
    const webp = await fileRow(A, { purpose: 'product_image', name: 'cu.webp', contentType: 'image/webp' });
    expect(await problem([webp.id])).toBe('Ảnh cu.webp không phải JPG hoặc PNG');
  });

  it('ảnh hơn 1 MB xin vé trước khi đổi luật thì báo theo tên tệp', async () => {
    const big = await fileRow(A, { purpose: 'product_image', name: 'to.jpg', sizeBytes: 2 * 1024 * 1024 });
    expect(await problem([big.id])).toBe('Ảnh to.jpg lớn hơn 1 MB');
  });
});

describe('fileProblem: tệp đính kèm giữ câu cũ', () => {
  it('quá 10 tệp, tệp lặp, tệp chưa tải xong', async () => {
    const many = await Promise.all(Array.from({ length: 11 }, () => fileRow(A, { purpose: 'attachment' })));
    expect(await problem(many.map((f) => f.id), 'attachment', 10)).toBe('Tối đa 10 tệp');
    expect(await problem([many[0]!.id, many[0]!.id], 'attachment', 10)).toBe('Có tệp bị lặp');
    const pending = await fileRow(A, { purpose: 'attachment', uploaded: false });
    expect(await problem([pending.id], 'attachment', 10)).toBe('Có tệp chưa tải xong hoặc không thuộc công ty');
  });
});

describe('publicFileUrls', () => {
  const saved = env.S3_PUBLIC_URL;
  afterEach(() => {
    env.S3_PUBLIC_URL = saved;
  });
  const urls = (ids: string[]) => withCompany(A, () => publicFileUrls(ids));

  it('ảnh sản phẩm có link cố định theo S3_PUBLIC_URL; tệp đính kèm (bucket riêng) không có link', async () => {
    const img = await fileRow(A, { purpose: 'product_image' });
    const doc = await fileRow(A, { purpose: 'attachment' });
    const map = await urls([img.id, doc.id]);
    expect(map.get(img.id)).toBe(`https://files.commerio.test/${img.key}`);
    expect(map.has(doc.id)).toBe(false);
  });

  it('S3_PUBLIC_URL có "/" cuối thì không nhân đôi "/"', async () => {
    env.S3_PUBLIC_URL = 'https://files.commerio.test/';
    const img = await fileRow(A, { purpose: 'product_image' });
    expect((await urls([img.id])).get(img.id)).toBe(`https://files.commerio.test/${img.key}`);
  });

  it('thiếu S3_PUBLIC_URL thì link là chuỗi rỗng', async () => {
    env.S3_PUBLIC_URL = undefined;
    const img = await fileRow(A, { purpose: 'product_image' });
    expect((await urls([img.id])).get(img.id)).toBe('');
  });

  it('ảnh của công ty khác không có trong kết quả', async () => {
    const other = await fileRow(B, { purpose: 'product_image' });
    expect((await urls([other.id])).has(other.id)).toBe(false);
  });
});
