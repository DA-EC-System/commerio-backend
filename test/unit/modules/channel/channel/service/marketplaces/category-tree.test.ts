// Cây category và attribute đầy đủ của sàn (#400 lát 3, AC-5, A15) trên phản hồi gọi thật 18/11/2026 (test/fixtures/channel):
// Lazada `/category/tree/get`, `/category/attributes/get` không cần access_token (G2.1, G2.2); TikTok Get Categories,
// Get Category Attributes 202309 cần token gian hàng (shop_cipher, G2.6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';
import { createTiktokClient, packTiktokToken } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/channel', name), 'utf8')) as T;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('Lazada: cây và attribute không cần token', () => {
  const config = { appKey: '143465', appSecret: 'secret', redirectUrl: undefined, apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
  const lazada = (body: unknown) => {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    return { fn, adapter: createLazadaAdapter(config, fn) };
  };
  const query = (fn: ReturnType<typeof vi.fn<typeof fetch>>) => {
    const u = new URL(String(fn.mock.calls[0]![0]));
    return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
  };

  it('không cần token cho cây, attribute', () => {
    expect(createLazadaAdapter(config, vi.fn()).categoriesNeedToken).toBeFalsy();
  });

  it('categoryTree: mọi node kèm cha, leaf, đường dẫn tiếng Việt; gọi không access_token, ngôn ngữ vi_VN', async () => {
    const tree = fixture<{ data: unknown[] }>('lazada-tree.json');
    const { fn, adapter } = lazada(tree);
    const nodes = await adapter.categoryTree!(null);
    const { path, params } = query(fn);
    expect(path).toBe('/rest/category/tree/get');
    expect(params).toMatchObject({ language_code: 'vi_VN' });
    expect(params).not.toHaveProperty('access_token');

    type N = { category_id: number; children?: N[] };
    const count = (ns: N[]): number => ns.reduce((s, n) => s + 1 + count(n.children ?? []), 0);
    expect(nodes).toHaveLength(count(tree.data as N[]));
    const leaf = nodes.find((n) => n.externalId === '7930')!;
    expect(leaf).toMatchObject({ isLeaf: true });
    expect(leaf.path.split(' > ').at(-1)).toBe(leaf.name);
    const parent = nodes.find((n) => n.externalId === leaf.parentExternalId)!;
    expect(parent.isLeaf).toBe(false);
    expect(leaf.path.startsWith(`${parent.path} > `)).toBe(true);
    expect(nodes.filter((n) => n.parentExternalId === null).length).toBe(tree.data.length);
  });

  it('categoryTree có token thì vẫn gửi token', async () => {
    const { fn, adapter } = lazada({ code: '0', data: [] });
    await adapter.categoryTree!('tok');
    expect(query(fn).params).toMatchObject({ access_token: 'tok' });
  });

  const attrs = async (id: string) => {
    const { fn, adapter } = lazada(fixture(`lazada-attrs-${id}.json`));
    const out = await adapter.leafAttributes!(null, id);
    return { fn, out, by: (code: string) => out.find((a) => a.code === code) };
  };

  it('leafAttributes gọi không access_token, theo primary_category_id, vi_VN', async () => {
    const { fn } = await attrs('7930');
    const { path, params } = query(fn);
    expect(path).toBe('/rest/category/attributes/get');
    expect(params).toMatchObject({ primary_category_id: '7930', language_code: 'vi_VN' });
    expect(params).not.toHaveProperty('access_token');
  });

  it('bỏ attribute cấp SKU không phải sales (giá, SellerSku, kích thước gói) và trường nội dung app tự gửi', async () => {
    const { out } = await attrs('7930');
    const codes = out.map((a) => a.code);
    for (const c of ['price', 'SellerSku', 'package_weight', 'package_width', 'package_length', 'package_height', 'special_price', 'quantity']) {
      expect(codes).not.toContain(c);
    }
    for (const c of ['name', 'name_en', 'description', 'description_en']) expect(codes).not.toContain(c);
    // Không attribute bắt buộc nào ngoài catalog cung cấp còn sót kiểu `sku` mà không phải sales.
    expect(out.filter((a) => (a.raw as { attribute_type?: string }).attribute_type === 'sku' && a.kind !== 'sales')).toEqual([]);
  });

  it('luật kind, input, allowCustom, tier, isKey (A15) trên 7930', async () => {
    const { by } = await attrs('7930');
    expect(by('brand')).toMatchObject({ tier: 'product', input: 'select', allowCustom: true, required: true, options: [] });
    expect(by('country_origin_hb')).toMatchObject({ tier: 'product', input: 'select', allowCustom: false, required: false });
    expect(by('country_origin_hb')!.options).toHaveLength(247);
    expect(by('clothing_material')).toMatchObject({ kind: 'property', input: 'select', allowCustom: false, required: true, tier: 'category' });
    expect(by('clothing_material')!.options).toContainEqual({ id: '8544', label: 'Nhung' });
    expect(by('fa_pattern')).toMatchObject({ input: 'select', allowCustom: true, required: true });
    expect(by('occasion')).toMatchObject({ input: 'multiselect', allowCustom: false });
    expect(by('color_family')).toMatchObject({ kind: 'sales', input: 'select' });
    expect(by('size')).toMatchObject({ kind: 'sales' });
    expect(by('Manufacturing_date')).toMatchObject({ input: 'date', allowCustom: true });
    expect(by('Size_Chart_Image')).toBeUndefined();
    expect(by('promotion_whitebkg_image')).toMatchObject({ input: 'image', allowCustom: true });
    expect(by('Neckline')).toMatchObject({ isKey: true, requiredWhen: null });
    expect(by('occasion')).toMatchObject({ isKey: false });
  });

  it('6371: propCascade không label, không input_type → cascade, nhãn dự phòng là mã, bắt buộc; sales bắt buộc vẫn sales', async () => {
    const { by } = await attrs('6371');
    expect(by('propCascade')).toMatchObject({ input: 'cascade', label: 'propCascade', required: true, allowCustom: true });
    expect(by('color_family')).toMatchObject({ kind: 'sales', required: true });
    expect(by('material_filter')).toMatchObject({ input: 'multiselect', allowCustom: false, required: true });
  });

  it('4640: multiEnumInput → multiselect cho tự nhập; sales numeric giữ lại', async () => {
    const { by } = await attrs('4640');
    expect(by('formulation')).toMatchObject({ input: 'multiselect', allowCustom: true, required: true });
    expect(by('Units_(per_Bundle)')).toMatchObject({ kind: 'sales', input: 'number' });
    expect(by('tax_class')).toBeUndefined();
  });

  it('data không phải mảng thì unexpected_response (không coi là leaf không có attribute); mảng rỗng là rỗng (review P2-1)', async () => {
    for (const data of [undefined, null, {}, 'x']) {
      const { adapter } = lazada({ code: '0', request_id: 'r', ...(data !== undefined && { data }) });
      await expect(adapter.leafAttributes!(null, '7930')).rejects.toMatchObject({ kind: 'rejected', platformCode: 'unexpected_response' });
    }
    await expect(lazada({ code: '0', request_id: 'r', data: [] }).adapter.leafAttributes!(null, '7930')).resolves.toEqual([]);
  });

  it('is_key_prop = 1 thì isKey', async () => {
    const body = { code: '0', data: [{ name: 'model', label: 'Mẫu', input_type: 'text', attribute_type: 'normal', is_mandatory: 0, is_sale_prop: 0, advanced: { is_key_prop: 1 } }] };
    const { adapter } = lazada(body);
    expect(await adapter.leafAttributes!(null, '1')).toMatchObject([{ code: 'model', isKey: true, input: 'text', allowCustom: true }]);
  });
});

describe('TikTok: cây và attribute bằng token gian hàng', () => {
  const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
  const TOKEN = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });
  const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });
  const san = (routes: Record<string, unknown>) => {
    const calls: { path: string; query: URLSearchParams }[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const u = new URL(String(input));
      calls.push({ path: u.pathname, query: u.searchParams });
      const data = routes[`${init?.method ?? 'GET'} ${u.pathname}`];
      return data === undefined ? json({ code: 36009009, message: 'Invalid path' }) : ok(data);
    });
    return { calls, methods: tiktokListingMethods(createTiktokClient(config, fetchFn)) };
  };

  it('cần token gian hàng; gọi không token thì unauthorized, không gọi sàn', async () => {
    expect(createTiktokAdapter(config, vi.fn()).categoriesNeedToken).toBe(true);
    const s = san({});
    await expect(s.methods.categoryTree!(null)).rejects.toBeInstanceOf(MarketplaceError);
    await expect(s.methods.leafAttributes!(null, '601226')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(s.calls).toEqual([]);
  });

  it('categoryTree: mọi node (cả không phải lá, cả không AVAILABLE), quyền gốc, đường dẫn từ gốc, cây v2', async () => {
    const tree = fixture<{ categories: { id: string; is_leaf: boolean; parent_id: string }[] }>('tiktok-tree.json');
    const extra = { id: '999001', is_leaf: true, local_name: 'Mời bán', parent_id: tree.categories.find((c) => !c.is_leaf)!.id, permission_statuses: ['INVITE_ONLY'] };
    const s = san({ 'GET /product/202309/categories': { categories: [...tree.categories, extra] } });
    const nodes = await s.methods.categoryTree!(TOKEN);
    expect(s.calls[0]!.query.get('category_version')).toBe('v2');
    expect(nodes).toHaveLength(tree.categories.length + 1);
    const leaf = nodes.find((n) => n.externalId === '601226')!;
    expect(leaf).toMatchObject({ isLeaf: true, name: 'Áo thun', path: 'Trang phục nam & đồ lót > Áo nam > Áo thun', permissionStatuses: ['AVAILABLE'] });
    expect(nodes.find((n) => n.externalId === '999001')).toMatchObject({ permissionStatuses: ['INVITE_ONLY'], isLeaf: true });
    expect(nodes.filter((n) => n.parentExternalId === null).every((n) => !n.path.includes(' > '))).toBe(true);
  });

  const attrsOf = async (extra: unknown[] = []) => {
    const real = fixture<Record<string, { attributes: unknown[] }>>('tiktok-attrs.json')['601226']!.attributes;
    const s = san({ 'GET /product/202309/categories/601226/attributes': { attributes: [...real, ...extra] } });
    const out = await s.methods.leafAttributes!(TOKEN, '601226');
    return { s, out, by: (code: string) => out.find((a: PlatformAttribute) => a.code === code) };
  };

  it('giữ cả sales attribute; mã là id; tier, input, allowCustom theo is_customizable (A15)', async () => {
    const { s, out, by } = await attrsOf();
    expect(s.calls[0]!.query.get('category_version')).toBe('v2');
    expect(out.length).toBeGreaterThan(3);
    expect(by('100000')).toMatchObject({ kind: 'sales', label: 'Màu sắc', input: 'multiselect', options: [] });
    expect(by('100007')).toMatchObject({ kind: 'sales', label: 'Kích cỡ' });
    expect(by('100149')).toMatchObject({ tier: 'product', input: 'select', allowCustom: true, required: true });
    expect(by('100149')!.options).toHaveLength(203);
    expect(by('101489')).toMatchObject({ tier: 'company', required: true, input: 'text' });
    expect(by('101490')).toMatchObject({ tier: 'company' });
    expect(by('100398')).toMatchObject({ tier: 'category', input: 'multiselect', allowCustom: true, required: false });
    expect(by('100398')!.options[0]).toEqual({ id: '1001164', label: 'Khỏe mạnh' });
  });

  it('requirement_conditions (VALUE_ID_MATCH) gom theo attribute điều kiện; không customizable thì allowCustom false', async () => {
    const { by } = await attrsOf([
      {
        id: '900001',
        name: 'Loại pin',
        type: 'PRODUCT_PROPERTY',
        is_requried: false,
        is_customizable: false,
        is_multiple_selection: false,
        values: [{ id: 'v1', name: 'Lithium' }],
        requirement_conditions: [
          { condition_type: 'VALUE_ID_MATCH', attribute_id: '900000', attribute_value_id: 'yes' },
          { condition_type: 'VALUE_ID_MATCH', attribute_id: '900000', attribute_value_id: 'maybe' },
          { condition_type: 'RANGE', attribute_id: '900002', attribute_value_id: 'x' },
        ],
      },
    ]);
    expect(by('900001')).toMatchObject({ allowCustom: false, input: 'select', requiredWhen: [{ code: '900000', optionIds: ['yes', 'maybe'] }] });
  });

  it('attributes vắng hay không phải mảng thì unexpected_response; mảng rỗng là rỗng (review P2-1)', async () => {
    const path = 'GET /product/202309/categories/601226/attributes';
    for (const data of [{}, { attributes: null }, { attributes: {} }]) {
      await expect(san({ [path]: data }).methods.leafAttributes!(TOKEN, '601226')).rejects.toMatchObject({
        kind: 'rejected',
        platformCode: 'unexpected_response',
      });
    }
    await expect(san({ [path]: { attributes: [] } }).methods.leafAttributes!(TOKEN, '601226')).resolves.toEqual([]);
  });
});
