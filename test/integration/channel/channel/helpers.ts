import { type MarketplaceAdapter, MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';

const unsupported = async (): Promise<never> => {
  throw new MarketplaceError('unsupported');
};

/** Adapter giả: năng lực không truyền vào thì báo `unsupported`, để test chỉ khai phần mình dùng. */
export function fakeAdapter(overrides: Partial<MarketplaceAdapter>): MarketplaceAdapter {
  return {
    authorizeUrl: () => {
      throw new MarketplaceError('unsupported');
    },
    exchangeCode: unsupported,
    refreshToken: unsupported,
    getSeller: unsupported,
    listCategories: unsupported,
    categoryAttributes: unsupported,
    uploadImage: unsupported,
    createProduct: unsupported,
    getSkus: unsupported,
    updatePriceQuantity: unsupported,
    deactivate: unsupported,
    ...overrides,
  };
}
