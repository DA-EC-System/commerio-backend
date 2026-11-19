// Cổng product thật của channel (#303, #204): ảnh catalog đi qua `productImageUrls` của `product/index.ts`, số đo SKU
// qua `getVariants`.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { pushBlock, type SpecCheck } from '#src/modules/channel/channel/service/push-block.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

setProductPort(null);

let companyId: string;
beforeAll(async () => {
  companyId = (await createCompany()).companyId;
});

describe('ProductPort.productImageUrls (cổng thật)', () => {
  it('trả link ảnh catalog theo position, cắt theo max', async () => {
    const { productId } = await createVariant(companyId);
    const keys: string[] = [];
    for (const position of [0, 1]) {
      const fileId = randomUUID();
      const key = `test/${fileId}.jpg`;
      keys.push(key);
      await testPool().query(
        `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
         values ($1, $2, $3, 'anh.jpg', 'image/jpeg', 2048, 'product_image', now())`,
        [fileId, companyId, key],
      );
      await testPool().query(
        'insert into product.product_images (company_id, product_id, file_id, position) values ($1, $2, $3, $4)',
        [companyId, productId, fileId, position],
      );
    }
    const port = productPort(createModuleContext());
    const first = await withCompany(companyId, () => port.productImageUrls([productId], 1));
    expect(first).toEqual(new Map([[productId, [`https://files.commerio.test/${keys[0]}`]]]));
    const all = await withCompany(companyId, () => port.productImageUrls([productId], 8));
    expect(all.get(productId)).toEqual(keys.map((k) => `https://files.commerio.test/${k}`));
  });
});

describe('ProductPort.variants (cổng thật, #204)', () => {
  it('SKU có đủ số đo trong catalog thì qua được bước kiểm đẩy lên sàn, không còn dimensions_missing', async () => {
    const { variantId } = await createVariant(companyId);
    const port = productPort(createModuleContext());
    const map: SpecCheck = { externalCategoryId: 'L1', missing: [], permission: null, sizeChartRule: null };
    const check = async () => {
      const [lv] = await withCompany(companyId, () => port.variants([variantId]));
      return pushBlock(lv!, new Decimal(150000), map, true);
    };
    expect((await check())?.code).toBe('dimensions_missing'); // đối chứng: chưa có số đo
    await testPool().query(
      'update product.product_variants set weight_g = 250, length_mm = 200, width_mm = 100, height_mm = 30 where id = $1',
      [variantId],
    );
    expect(await check()).toBeNull();
  });
});
