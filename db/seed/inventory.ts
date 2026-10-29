import type { SeedApi } from './api.ts';
import type { SeedProduct } from './catalog.ts';

export async function seedInventory(api: SeedApi, products: SeedProduct[]) {
  for (const product of products.slice(0, 3)) {
    const id = product.variants[0]!.id;
    const { level } = await api<{ level: { minQty: number | null; reorderVersion: number } }>('GET', `/inventory/stock/${id}`);
    if (level.minQty === null && level.reorderVersion === 0) {
      await api('PUT', `/inventory/stock/${id}/reorder-rule`, { version: 0, minQty: 5 });
    }
  }
  return { reorderRules: 3, openingDocuments: 0 };
}
