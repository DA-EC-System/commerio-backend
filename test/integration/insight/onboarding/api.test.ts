import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, testApp } from '../../helpers/http.ts';
import { lockCompany, setModuleEnabled } from '../../helpers/state.ts';

// Documents/21 mục 23 (commerio-backend#461, #569): checklist thiết lập ban đầu, suy từ dữ liệu thật; mốc hoàn tất.
const get = (token?: string) => {
  const req = request(testApp()).get('/api/v1/onboarding');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
// Kênh bán là phân hệ lõi từ commerio-backend#459: hai mục gian hàng luôn áp dụng.
const newCompany = () => createCompany();
const itemOf = (body: { items: { key: string }[] }, key: string) => body.items.find((i) => i.key === key);
const complete = (token: string) => request(testApp()).post('/api/v1/onboarding/complete').set('Authorization', `Bearer ${token}`);

async function fillProfile(token: string) {
  const profile = await request(testApp()).get('/api/v1/platform/company').set('Authorization', `Bearer ${token}`);
  const saved = await request(testApp())
    .put('/api/v1/platform/company')
    .set('Authorization', `Bearer ${token}`)
    .send({ address: '12 Đường Thử, Quận 1', version: profile.body.version });
  expect(saved.status).toBe(200);
}

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

async function insertOpening(companyId: string, shopId: string, status: 'draft' | 'pending' | 'posted' | 'rejected' | 'cancelled') {
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
  it('công ty mới: 7 mục bắt buộc rồi 3 mục tuỳ chọn, chưa xong mục nào, 0/7, ép vào wizard', async () => {
    // Đăng ký thật để Báo cáo tắt (Documents/27 US-CT-12 ca 1); helper mặc định bật.
    const { ceo } = await createCompany({ optionalModules: ['purchasing'] });
    const res = await get(ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { key: string }) => i.key)).toEqual([
      'company_profile',
      'connect_shop',
      'link_skus',
      'assign_groups',
      'stock_sync',
      'order_cutoff',
      'opening_stock',
      'first_product',
      'invite_staff',
      'enable_report',
    ]);
    expect(res.body.items.every((i: { done: boolean }) => !i.done)).toBe(true);
    expect(res.body.items.filter((i: { optional: boolean }) => i.optional).map((i: { key: string }) => i.key)).toEqual([
      'first_product',
      'invite_staff',
      'enable_report',
    ]);
    expect(res.body).toMatchObject({
      done: 0,
      total: 7,
      completedAt: null,
      next: { key: 'company_profile', mine: true },
      mustWizard: true,
    });
  });

  it('khai địa chỉ công ty, tạo link mời, thêm sản phẩm: các mục tự đánh dấu xong; lưu trữ hết sản phẩm thì mục quay lại chưa xong', async () => {
    const { companyId, ceo } = await newCompany();
    await fillProfile(ceo.token);
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
    expect(res.body).toMatchObject({ done: 1, total: 7, next: { key: 'connect_shop', mine: true } });

    await testPool().query(
      "update product.product_variants set business_status = 'archived', archived_at = now() where id = $1",
      [variantId],
    );
    expect(itemOf((await get(ceo.token)).body, 'first_product')).toMatchObject({ done: false });
  });

  it('gian hàng đang kết nối: bốn bước gian hàng trỏ tới gian hàng đó, xong theo mốc xác nhận của nháp; hoàn tất thiết lập thì xong cả bốn', async () => {
    const { companyId, ceo } = await newCompany();
    await insertShop(companyId, 'disconnected');
    expect(itemOf((await get(ceo.token)).body, 'connect_shop')).toMatchObject({ done: false });

    const shopId = await insertShop(companyId, 'connecting');
    const before = (await get(ceo.token)).body;
    expect(itemOf(before, 'connect_shop')).toMatchObject({ done: true });
    for (const key of ['link_skus', 'assign_groups', 'stock_sync', 'order_cutoff']) {
      expect(itemOf(before, key)).toMatchObject({ done: false, ref: { type: 'shop', id: shopId } });
    }

    const at = new Date().toISOString();
    const draft = {
      decisions: [],
      createGroups: [],
      openingStock: null,
      returnWindowDays: null,
      baseline: [],
      confirmed: { link_skus: at, assign_groups: at, stock_sync: null },
    };
    await testPool().query('update channel.shops set setup_draft = $2, setup_draft_version = 1 where id = $1', [shopId, draft]);
    const drafted = (await get(ceo.token)).body;
    expect(itemOf(drafted, 'link_skus')).toMatchObject({ done: true });
    expect(itemOf(drafted, 'assign_groups')).toMatchObject({ done: true });
    expect(itemOf(drafted, 'stock_sync')).toMatchObject({ done: false });
    expect(drafted.next).toMatchObject({ key: 'company_profile' });

    await testPool().query("update channel.shops set status = 'active', order_cutoff_at = now() where id = $1", [shopId]);
    const after = (await get(ceo.token)).body;
    for (const key of ['link_skus', 'assign_groups', 'stock_sync', 'order_cutoff']) {
      expect(itemOf(after, key)).toMatchObject({ done: true, ref: null });
    }
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

  it('phiếu đầu kỳ bị từ chối vẫn chặn và được trỏ tới; phiếu bị huỷ thì bỏ qua', async () => {
    const { companyId, ceo } = await newCompany();
    const cancelledShop = await insertShop(companyId, 'active');
    await insertOpening(companyId, cancelledShop, 'cancelled');
    expect(itemOf((await get(ceo.token)).body, 'opening_stock')).toMatchObject({ done: false, ref: null });
    const rejectedShop = await insertShop(companyId, 'active');
    const rejected = await insertOpening(companyId, rejectedShop, 'rejected');
    expect(itemOf((await get(ceo.token)).body, 'opening_stock')).toMatchObject({
      done: false,
      ref: { type: 'stock_document', id: rejected },
    });
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

  it('Nhân viên kho chỉ thấy mục mình có quyền; total đếm trên mục đã lọc; next không lọc theo quyền', async () => {
    const { companyId } = await newCompany();
    const kho = await addMember(companyId, 'warehouse');
    const res = await get(kho.token);
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: { key: string }) => i.key);
    expect(keys).toContain('opening_stock');
    expect(keys).not.toContain('company_profile');
    expect(keys).not.toContain('invite_staff');
    expect(keys).not.toContain('connect_shop');
    expect(res.body.total).toBe(keys.length);
    expect(res.body).toMatchObject({ next: { key: 'company_profile', mine: false }, mustWizard: false });
  });

  it('phiếu đầu kỳ chờ duyệt: next là opening_stock, mine theo quyền duyệt phiếu', async () => {
    const { companyId, ceo } = await newCompany();
    await fillProfile(ceo.token);
    const shopId = await insertShop(companyId, 'active');
    await insertOpening(companyId, shopId, 'pending');
    const kho = await addMember(companyId, 'warehouse');
    expect((await get(ceo.token)).body).toMatchObject({ next: { key: 'opening_stock', mine: true }, mustWizard: true });
    expect((await get(kho.token)).body).toMatchObject({ next: { key: 'opening_stock', mine: false }, mustWizard: false });
  });

  it('Sale không có quyền mục nào: danh sách rỗng, 0/0', async () => {
    const { companyId } = await newCompany();
    const sale = await addMember(companyId, 'sale');
    expect((await get(sale.token)).body).toEqual({
      items: [],
      done: 0,
      total: 0,
      completedAt: null,
      next: { key: 'company_profile', mine: false },
      mustWizard: false,
    });
  });

  it('công ty tắt Báo cáo vẫn 200, không 403 module_disabled', async () => {
    const { companyId, ceo } = await newCompany();
    await setModuleEnabled(companyId, 'report', false);
    const off = await get(ceo.token);
    expect(off.status).toBe(200);
    expect(itemOf(off.body, 'enable_report')).toMatchObject({ done: false, optional: true });

    await setModuleEnabled(companyId, 'report', true);
    expect(itemOf((await get(ceo.token)).body, 'enable_report')).toMatchObject({ done: true });
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

  it('Swagger có GET /api/v1/onboarding và POST /api/v1/onboarding/complete kèm schema phản hồi', async () => {
    const { paths } = (await request(testApp()).get('/api/openapi.json')).body;
    const key = Object.keys(paths).find((p) => /^\/api\/v1\/onboarding\/?$/.test(p));
    expect(paths[key!]?.get?.responses?.['200']?.content?.['application/json']?.schema).toBeDefined();
    const done = paths['/api/v1/onboarding/complete']?.post?.responses;
    expect(done?.['200']?.content?.['application/json']?.schema).toBeDefined();
    expect(done?.['409']).toBeDefined();
  });
});

describe('POST /onboarding/complete', () => {
  /** Công ty làm xong mọi mục bắt buộc: hồ sơ, một gian hàng đã thiết lập, phiếu đầu kỳ đã ghi sổ. */
  async function finished() {
    const c = await newCompany();
    await fillProfile(c.ceo.token);
    const shopId = await insertShop(c.companyId, 'active');
    await insertOpening(c.companyId, shopId, 'posted');
    return c;
  }
  const audits = async (companyId: string) =>
    (
      await testPool().query<{ n: number }>(
        "select count(*)::int as n from core.audit_logs where company_id = $1 and operation = 'onboarding.completed'",
        [companyId],
      )
    ).rows[0]!.n;

  it('còn mục bắt buộc: 409 onboarding_incomplete kèm missing theo thứ tự bảng, không ghi gì', async () => {
    const { companyId, ceo } = await newCompany();
    await fillProfile(ceo.token);
    const res = await complete(ceo.token);
    expect([res.status, res.body.code]).toEqual([409, 'onboarding_incomplete']);
    expect(res.body.missing).toEqual(['connect_shop', 'link_skus', 'assign_groups', 'stock_sync', 'order_cutoff', 'opening_stock']);
    expect((await get(ceo.token)).body.completedAt).toBeNull();
    expect(await audits(companyId)).toBe(0);
  });

  it('đủ mục: đặt mốc một lần, gọi lại trả mốc cũ, nhật ký đúng một dòng; GET trả completedAt, hết ép wizard', async () => {
    const { companyId, ceo } = await finished();
    const first = await complete(ceo.token);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.completedAt).toEqual(expect.any(String));
    const again = await complete(ceo.token);
    expect(again.body).toEqual(first.body);
    expect(await audits(companyId)).toBe(1);
    expect((await get(ceo.token)).body).toMatchObject({ completedAt: first.body.completedAt, next: null, mustWizard: false });
  });

  it('đã có mốc thì không kiểm lại mục (mục quay lại chưa xong vẫn trả mốc cũ)', async () => {
    const { companyId, ceo } = await finished();
    const first = (await complete(ceo.token)).body;
    await testPool().query("update channel.shops set status = 'disconnected', disconnected_at = now() where company_id = $1", [companyId]);
    const again = await complete(ceo.token);
    expect([again.status, again.body]).toEqual([200, first]);
    expect((await get(ceo.token)).body).toMatchObject({ completedAt: first.completedAt, mustWizard: false });
  });

  it('hai lời gọi đua: cùng một mốc, nhật ký một dòng', async () => {
    const { companyId, ceo } = await finished();
    const [a, b] = await Promise.all([complete(ceo.token), complete(ceo.token)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.completedAt).toBe(b.body.completedAt);
    expect(await audits(companyId)).toBe(1);
  });

  it('thiếu quyền platform.company.manage: 403', async () => {
    const { companyId } = await finished();
    const kho = await addMember(companyId, 'warehouse');
    expect((await complete(kho.token)).status).toBe(403);
  });
});
