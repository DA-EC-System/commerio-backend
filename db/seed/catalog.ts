import { allPages, type SeedApi } from './api.ts';

interface Product { id: string; name: string; version: number }
export interface SeedProduct extends Product { variants: { id: string; archivedAt: string | null }[] }
const names = ['Áo thun basic cổ tròn', 'Quần kaki ống suông', 'Thắt lưng', 'Áo sơ mi caro',
  'Áo polo', 'Áo khoác gió', 'Ví vải', 'Túi đeo chéo', 'Vớ cổ ngắn', 'Mũ vải', 'Quần short', 'Khăn choàng'];

export async function seedCatalog(api: SeedApi, small = false): Promise<SeedProduct[]> {
  // Mẫu SKU là của công ty (#447): đặt mẫu DEMO một lần. Công ty mới đã có sẵn 12 nhóm hàng nên dùng lại nhóm "Thời trang nam".
  const settings = await api<{ skuPattern: string; version: number }>('GET', '/catalog/settings');
  if (settings.skuPattern !== 'DEMO-{SEQ:4}-{VAL}') {
    await api('PUT', '/catalog/settings', { skuPattern: 'DEMO-{SEQ:4}-{VAL}', version: settings.version });
  }
  const { items: groups } = await api<{ items: { id: string; name: string }[] }>('GET', '/catalog/groups');
  const group = groups.find((g) => g.name === 'Thời trang nam') ??
    await api<{ id: string }>('POST', '/catalog/groups', { name: 'Thời trang nam' });
  const attributes = await api<{ id: string; name: string; values: { id: string; value: string }[] }[]>('GET', '/catalog/attributes');
  const attribute = attributes.find((a) => a.name === '[DEMO] Màu sắc') ??
    await api<{ id: string; values: { id: string; value: string }[] }>('POST', '/catalog/attributes', {
      name: '[DEMO] Màu sắc', values: [{ value: 'Đen', code: 'DEN' }, { value: 'Trắng', code: 'TRA' }],
    });
  const existing = [
    ...await allPages<Product>(api, '/catalog/products?status=active'),
    ...await allPages<Product>(api, '/catalog/products?status=archived'),
  ];
  const products: SeedProduct[] = [];
  for (const [index, label] of names.slice(0, small ? 3 : names.length).entries()) {
    const name = `[DEMO] ${label}`;
    const used = attribute.values.slice(0, index % 3 === 0 ? 2 : 1);
    const found = existing.find((p) => p.name === name);
    const product = found ? await api<SeedProduct>('GET', `/catalog/products/${found.id}`) :
      await api<SeedProduct>('POST', '/catalog/products', {
        name, groupId: group.id, description: 'Dữ liệu giả Commerio; dùng kiểm thử API.', imageFileIds: [],
        axes: [{ attributeId: attribute.id, values: used.map((v) => ({ id: v.id, value: v.value })) }],
        variants: used.map((v) => ({ options: [v.value] })),
      });
    products.push(product);
    if (!found && !small && index === names.length - 1) {
      // Một sản phẩm mọi SKU đã lưu trữ (#204: lưu trữ theo SKU, sản phẩm cha không còn lưu trữ riêng).
      for (const action of ['discontinue', 'archive']) {
        await api('POST', `/catalog/products/${product.id}/business-status`, { action });
      }
    }
  }
  return products;
}
