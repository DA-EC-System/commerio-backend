import { allPages, type SeedApi } from './api.ts';

interface Product { id: string; name: string; version: number }
export interface SeedProduct extends Product { variants: { id: string; archivedAt: string | null }[] }
const names = ['Áo thun basic cổ tròn', 'Quần kaki ống suông', 'Thắt lưng', 'Áo sơ mi caro',
  'Áo polo', 'Áo khoác gió', 'Ví vải', 'Túi đeo chéo', 'Vớ cổ ngắn', 'Mũ vải', 'Quần short', 'Khăn choàng'];

export async function seedCatalog(api: SeedApi, small = false): Promise<SeedProduct[]> {
  const categories = await api<{ id: string; name: string }[]>('GET', '/catalog/categories');
  const category = categories.find((c) => c.name === '[DEMO] Thời trang') ??
    await api<{ id: string }>('POST', '/catalog/categories', { name: '[DEMO] Thời trang', skuPattern: 'DEMO-{SEQ:4}-{VAL}' });
  const attributes = await api<{ id: string; name: string; values: { id: string }[] }[]>('GET', '/catalog/attributes');
  const attribute = attributes.find((a) => a.name === '[DEMO] Màu sắc') ??
    await api<{ values: { id: string }[] }>('POST', '/catalog/attributes', {
      name: '[DEMO] Màu sắc', values: [{ value: 'Đen', code: 'DEN' }, { value: 'Trắng', code: 'TRA' }],
    });
  const existing = [
    ...await allPages<Product>(api, '/catalog/products?status=active'),
    ...await allPages<Product>(api, '/catalog/products?status=archived'),
  ];
  const products: SeedProduct[] = [];
  for (const [index, label] of names.slice(0, small ? 3 : names.length).entries()) {
    const name = `[DEMO] ${label}`;
    const found = existing.find((p) => p.name === name);
    const product = found ? await api<SeedProduct>('GET', `/catalog/products/${found.id}`) :
      await api<SeedProduct>('POST', '/catalog/products', {
        name, categoryId: category.id, description: 'Dữ liệu giả Commerio; dùng kiểm thử API.',
        variants: attribute.values.slice(0, index % 3 === 0 ? 2 : 1).map((v) => ({ attributeValueIds: [v.id] })),
      });
    products.push(product);
    if (!found && !small && index === names.length - 1) {
      await api('DELETE', `/catalog/products/${product.id}?version=${product.version}`);
    }
  }
  return products;
}
