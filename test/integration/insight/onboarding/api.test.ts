import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, testApp } from '../../helpers/http.ts';
import { lockCompany, setModuleEnabled } from '../../helpers/state.ts';

// Documents/21 mục 23 (commerio-backend#461): checklist thiết lập ban đầu, suy từ dữ liệu thật.
const get = (token?: string) => {
  const req = request(testApp()).get('/api/v1/onboarding');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
// Trước commerio-backend#459 Kênh bán còn là phân hệ tuỳ chọn; bật để hai mục gian hàng áp dụng.
const newCompany = () => createCompany({ optionalModules: ['channel'] });
const itemOf = (body: { items: { key: string }[] }, key: string) => body.items.find((i) => i.key === key);

async function insertShop(companyId: string, status: 'connecting' | 'active' | 'disconnected') {
  const res = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at, disconnected_at)
     values ($1, 'lazada', $2, 'Shop thử', $3::channel.shop_status, case when $3 = 'active' then now() end,
       case when $3 = 'disconnected' then now() end)
     returning id`,
    [companyId, `onb-${randomUUID()}`, status],
  );
  return res.rows[0]!.id;
}

async function insertOpening(companyId: string, shopId: string, status: 'draft' | 'posted') {
  const res = await testPool().query<{ id: string }>(
    `insert into product.stock_documents (company_id, number, kind, status, counted_at, is_opening, source_type, source_id, shop_id, posted_at)
     values ($1, $2, 'stocktake', $3::product.stock_document_status, now(), true, 'shop_setup', $4, $4,
       case when $3 = 'posted' then now() end)
     returning id`,
    [companyId, `KK-${randomUUID().slice(0, 8)}`, status, shopId],
  );
  return res.rows[0]!.id;
}

describe('GET /onboarding', () => {
  it('công ty mới: 6 mục đúng thứ tự, chưa xong mục nào, mời nhân viên là tuỳ chọn, 0/5', async () => {
    const { ceo } = await newCompany();
    const res = await get(ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { key: string }) => i.key)).toEqual([
      'company_profile',
      'invite_staff',
      'connect_shop',
      'setup_shop',
      'first_product',
      'opening_stock',
    ]);
    expect(res.body.items.every((i: { done: boolean }) => !i.done)).toBe(true);
    expect(itemOf(res.body, 'invite_staff')).toMatchObject({ optional: true });
    expect(res.body).toMatchObject({ done: 0, total: 5 });
  });

  it('khai địa chỉ công ty, tạo link mời, thêm sản phẩm: các mục tự đánh dấu xong; lưu trữ hết sản phẩm thì mục quay lại chưa xong', async () => {
    const { companyId, ceo } = await newCompany();
    await testPool().query("update core.companies set address = '12 Đường Thử, Quận 1' where id = $1", [companyId]);
    const invite = await request(testApp())
      .post('/api/v1/identity/invitations')
      .set('Authorization', `Bearer ${ceo.token}`)
      .send({ roleIds: [BUILTIN_ROLES.sale.id] });
    expect(invite.status).toBe(201);
    const { variantId } = await createVariant(companyId);

    const res = await get(ceo.token);
    expect(itemOf(res.body, 'company_profile')).toMatchObject({ done: true });
    expect(itemOf(res.body, 'invite_staff')).toMatchObject({ done: true });
    expect(itemOf(res.body, 'first_product')).toMatchObject({ done: true });
    expect(res.body).toMatchObject({ done: 2, total: 5 });

    await testPool().query(
      "update product.product_variants set business_status = 'archived', archived_at = now() where id = $1",
      [variantId],
    );
    expect(itemOf((await get(ceo.token)).body, 'first_product')).toMatchObject({ done: false });
  });

  it('gian hàng đang kết nối: kết nối xong, thiết lập trỏ tới gian hàng đó; hoàn tất thiết lập thì xong', async () => {
    const { companyId, ceo } = await newCompany();
    await insertShop(companyId, 'disconnected');
    expect(itemOf((await get(ceo.token)).body, 'connect_shop')).toMatchObject({ done: false });

    const shopId = await insertShop(companyId, 'connecting');
    const before = (await get(ceo.token)).body;
    expect(itemOf(before, 'connect_shop')).toMatchObject({ done: true });
    expect(itemOf(before, 'setup_shop')).toMatchObject({ done: false, ref: { type: 'shop', id: shopId } });

    await testPool().query("update channel.shops set status = 'active', order_cutoff_at = now() where id = $1", [shopId]);
    expect(itemOf((await get(ceo.token)).body, 'setup_shop')).toMatchObject({ done: true, ref: null });
  });

  it('tồn đầu kỳ: phiếu đầu kỳ nháp thì chưa xong, trỏ tới phiếu; ghi sổ thì xong', async () => {
    const { companyId, ceo } = await newCompany();
    const shopId = await insertShop(companyId, 'active');
    const docId = await insertOpening(companyId, shopId, 'draft');
    expect(itemOf((await get(ceo.token)).body, 'opening_stock')).toMatchObject({
      done: false,
      ref: { type: 'stock_document', id: docId },
    });
    await testPool().query("update product.stock_documents set status = 'posted', posted_at = now() where id = $1", [docId]);
    expect(itemOf((await get(ceo.token)).body, 'opening_stock')).toMatchObject({ done: true, ref: null });
  });

  it('chưa có gian hàng, tồn vào qua thẻ kho: tồn đầu kỳ xong', async () => {
    const { companyId, ceo } = await newCompany();
    const { variantId } = await createVariant(companyId);
    await testPool().query(
      `insert into product.stock_moves (company_id, variant_id, bucket, qty_change, balance_after, source_type, source_id)
       values ($1, $2, 'on_hand', 5, 5, 'stock_document', $3)`,
      [companyId, variantId, randomUUID()],
    );
    expect(itemOf((await get(ceo.token)).body, 'opening_stock')).toMatchObject({ done: true });
  });

  it('Sale chỉ thấy mục mình có quyền; total đếm trên mục đã lọc', async () => {
    const { companyId } = await newCompany();
    const sale = await addMember(companyId, 'sale');
    const res = await get(sale.token);
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: { key: string }) => i.key);
    expect(keys).not.toContain('company_profile');
    expect(keys).not.toContain('invite_staff');
    expect(keys).not.toContain('connect_shop');
    expect(res.body.total).toBe(res.body.items.filter((i: { optional: boolean }) => !i.optional).length);
  });

  it('Kênh bán tắt: không có hai mục gian hàng', async () => {
    const { ceo } = await createCompany({ optionalModules: [] });
    const keys = (await get(ceo.token)).body.items.map((i: { key: string }) => i.key);
    expect(keys).not.toContain('connect_shop');
    expect(keys).not.toContain('setup_shop');
  });

  it('công ty tắt Báo cáo vẫn 200, không 403 module_disabled', async () => {
    const { companyId, ceo } = await newCompany();
    await setModuleEnabled(companyId, 'report', false);
    expect((await get(ceo.token)).status).toBe(200);
  });

  it('không thấy dữ liệu công ty khác', async () => {
    const mine = await newCompany();
    const other = await newCompany();
    await insertShop(other.companyId, 'active');
    await createVariant(other.companyId);
    const body = (await get(mine.ceo.token)).body;
    expect(itemOf(body, 'connect_shop')).toMatchObject({ done: false });
    expect(itemOf(body, 'first_product')).toMatchObject({ done: false });
  });

  it('thiếu token 401; token chưa chọn công ty 403 company_not_selected; công ty khoá 403 company_locked', async () => {
    const { companyId, ceo } = await newCompany();
    const noToken = await get();
    expect(noToken.status).toBe(401);
    const { token } = await login(ceo.email);
    const notSelected = await get(token);
    expect(notSelected.status).toBe(403);
    expect(notSelected.body.type).toMatch(/company_not_selected$/);
    await lockCompany(companyId);
    const locked = await get(ceo.token);
    expect(locked.status).toBe(403);
    expect(locked.body.type).toMatch(/company_locked$/);
  });

  it('Swagger có GET /api/v1/onboarding kèm schema phản hồi', async () => {
    const { paths } = (await request(testApp()).get('/api/openapi.json')).body;
    const key = Object.keys(paths).find((p) => /^\/api\/v1\/onboarding\/?$/.test(p));
    expect(paths[key!]?.get?.responses?.['200']?.content?.['application/json']?.schema).toBeDefined();
  });
});
