// Adapter giả tham chiếu qua cùng bộ ca hợp đồng với Lazada (#200).
import { describeAdapterContract } from './adapter-contract.ts';
import { createFakeMarketplace, type FakeMarketplace } from './fake-marketplace.ts';

const sàn = (over: Partial<FakeMarketplace> = {}): FakeMarketplace => ({
  configured: true,
  calls: 0,
  fail: null,
  tokens: new Map([
    [
      'tok',
      [
        { externalShopId: 'shop-1', shopName: 'Gian hàng 1' },
        { externalShopId: 'shop-2', shopName: 'Gian hàng 2' },
      ],
    ],
  ]),
  orders: new Map(),
  ...over,
});

describeAdapterContract('adapter giả tham chiếu', {
  connected: (state) => createFakeMarketplace(sàn({ orders: state?.orders ?? new Map() })),
  unconfigured: () => {
    const s = sàn({ configured: false });
    return { adapter: createFakeMarketplace(s), calls: () => s.calls };
  },
  failing: (mode) => createFakeMarketplace(mode === 'bad_token' ? sàn({ tokens: new Map() }) : sàn({ fail: mode })),
  callbackParams: { code: 'code-tok' },
  accessToken: 'tok',
  sellerSkus: ['AO-M', 'QUAN-L'],
  orderId: 'O001',
});
