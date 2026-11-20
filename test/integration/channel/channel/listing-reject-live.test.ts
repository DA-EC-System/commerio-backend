// Sàn từ chối cả sản phẩm khi listing đang `live` hoặc `hidden` (#389; Documents/25 §6.4, 21 §18.3). TikTok: bật lại
// sản phẩm sau khi app tắt thì sàn duyệt lại (`PENDING`), listing giữ `live`; sàn từ chối (`FAILED`, trạng thái cấp sản
// phẩm) thì mọi listing của sản phẩm sang `rejected`. Bản sửa nội dung bị từ chối thì sản phẩm vẫn `ACTIVATE` (Edit
// Product: "the existing product stays live and remains unchanged"), listing giữ `live`, chỉ bản sửa `failed`.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContentRevision, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { productPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { activateShop, FAKE_CAPABILITIES, fakeAdapter } from './helpers.ts';

setProductPort(null);
/** Trạng thái sản phẩm trên sàn giả theo mã sản phẩm (cấp sản phẩm, như `status` của Search Products) */
const state = new Map<string, RemoteSku['state']>();
const reasons = new Map<string, string>();
const revisions = new Map<string, ContentRevision>();
const skus = new Map<string, string>(); // sellerSku → externalProductId
registerAdapter(
  'tiktok',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop từ chối', region: 'VN' };
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      return sellerSkus.flatMap((sku): RemoteSku[] => {
        const product = skus.get(sku);
        if (!product) return [];
        return [
          {
            externalProductId: product,
            externalSkuId: `sku-${sku}`,
            sellerSku: sku,
            title: 'x',
            state: state.get(product) ?? 'live',
            rejectReason: reasons.get(product) ?? null,
            quantity: 5,
            sellableQuantity: 5,
          },
        ];
      });
    },
    async contentRevision(_t, productId) {
      return revisions.get(productId) ?? { state: 'approved' };
    },
    togglesByProduct: true,
    capabilities: { ...FAKE_CAPABILITIES, hideBy: 'zero_stock' },
  }),
);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
const sync = () => syncListings(productPort(createModuleContext()), company.companyId, shopId);

/** Sản phẩm TikTok có `n` listing (mỗi listing một SKU, đã nhập 5), trạng thái và cột thêm theo `extra` */
async function seedProduct(n: number, status: 'live' | 'hidden', extra = '') {
  const product = `item-${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { variantId, sku } = await createVariant(company.companyId);
    await receive(company.companyId, variantId, 5, 1000);
    skus.set(sku, product);
    const { rows } = await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status,
         stock_sync, price_sync, platform_stock, hidden_by ${extra ? ', revision_status, revision_at' : ''})
       values ($1, $2, $3, $4, $5, $6, $7, 'synced', 'synced', 5, $8 ${extra ? ", 'auditing', now()" : ''}) returning id`,
      [company.companyId, shopId, variantId, product, `sku-${sku}`, sku, status, status === 'hidden' ? 'zero_stock' : null],
    );
    ids.push(rows[0].id as string);
  }
  return { product, ids };
}
async function listing(id: string) {
  const { rows } = await testPool().query('select * from channel.listings where id = $1', [id]);
  return rows[0];
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/tiktok/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

beforeEach(() => {
  state.clear();
  reasons.clear();
  revisions.clear();
});

describe('sàn từ chối cả sản phẩm khi listing đang bán (#389)', () => {
  it('bật lại xong sàn từ chối: mọi listing của sản phẩm sang rejected kèm lý do, lịch sử có dòng hệ thống', async () => {
    const { product, ids } = await seedProduct(2, 'live');
    state.set(product, 'rejected');
    reasons.set(product, 'Ảnh vi phạm quy định');
    await sync();
    for (const id of ids) {
      expect(await listing(id)).toMatchObject({ status: 'rejected', reject_reason: 'Ảnh vi phạm quy định', hidden_by: null });
      const { rows } = await testPool().query(
        `select from_state, to_state, action, actor_id from core.state_transitions where entity_type = 'listings' and entity_id = $1`,
        [id],
      );
      expect(rows).toContainEqual({ from_state: 'live', to_state: 'rejected', action: 'reject', actor_id: null });
    }
  });

  it('listing app ẩn bằng tồn 0 mà sàn từ chối: sang rejected, bỏ cách ẩn', async () => {
    const { product, ids } = await seedProduct(1, 'hidden');
    state.set(product, 'rejected');
    await sync();
    expect(await listing(ids[0]!)).toMatchObject({ status: 'rejected', hidden_by: null });
  });

  it('bản sửa nội dung bị từ chối (sản phẩm vẫn ACTIVATE): listing giữ live, chỉ bản sửa failed kèm lý do', async () => {
    const { product, ids } = await seedProduct(1, 'live', 'revision');
    revisions.set(product, { state: 'failed', reason: 'Mô tả chứa liên kết ngoài' });
    await sync();
    expect(await listing(ids[0]!)).toMatchObject({ status: 'live', revision_status: 'failed', revision_reject_reason: 'Mô tả chứa liên kết ngoài' });
  });

  it('sàn từ chối cả sản phẩm khi đang có bản sửa duyệt: rejected, bỏ bản sửa', async () => {
    const { product, ids } = await seedProduct(1, 'live', 'revision');
    state.set(product, 'rejected');
    reasons.set(product, 'Sai danh mục');
    await sync();
    expect(await listing(ids[0]!)).toMatchObject({ status: 'rejected', reject_reason: 'Sai danh mục', revision_status: null });
  });
});
