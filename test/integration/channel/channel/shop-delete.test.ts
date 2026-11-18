import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShopDeleteConflict, ShopDeleteResult } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { receiveBack } from '#src/modules/product/index.ts';
import { withCompany, withSessionLock } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';
import { seedPackage, stockOfVariant } from '../../order/fulfillment/helpers.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { fakeAdapter } from './helpers.ts';

// #398: CEO xoá gian hàng đã ngắt, không có dữ liệu tiền, cùng mọi dữ liệu của nó trong một giao dịch (Documents/21
// §18, issue #398 "Xoá gì"). Phiếu kho đã ghi sổ giữ lại, cắt `shop_id`.

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: `seller-${accessToken.slice(4)}`, shopName: `Shop ${accessToken.slice(4)}`, region: 'VN' };
    },
  }),
);
afterAll(() => resetAdapters());

const db = testPool();
const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let variantId: string;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  ({ variantId } = await createVariant(company.companyId));
  await receive(company.companyId, variantId, 100, 100000);
});

const del = (id: string, body: object, token = company.ceo.token) =>
  app().delete(`/api/v1/channel/shops/${id}`).set('Authorization', `Bearer ${token}`).send(body);
const n = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

/** Gian hàng nối bằng token dán tay, rồi đặt trạng thái (ngắt thì xoá token như luồng ngắt). Trả id, version, mã token. */
async function shop(status: 'disconnected' | 'active' | 'needs_reauth' | 'connecting' = 'disconnected', token = randomUUID().slice(0, 12)) {
  const res = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${token}` });
  expect(res.status).toBe(201);
  const id = res.body.shop.id as string;
  const { rows } = await db.query<{ version: number; shop_name: string }>(
    `update channel.shops set status = $2::channel.shop_status, order_cutoff_at = now(), version = version + 1,
       access_token_enc = case when $3 then null else access_token_enc end,
       refresh_token_enc = case when $3 then null else refresh_token_enc end,
       disconnected_at = case when $3 then now() end
     where id = $1 returning version, shop_name`,
    [id, status, status === 'disconnected'],
  );
  return { id, version: rows[0]!.version, name: rows[0]!.shop_name, token };
}

async function listing(shopId: string, withPrice: boolean) {
  const calc = withPrice
    ? (
        await db.query<{ id: string }>(
          `insert into channel.price_calculations (company_id, shop_id, variant_id, cost, target_net, raw_price, rounded_price,
             net_received, margin_pct, below_floor, fee_pct, tax_pct, trigger)
           values ($1, $2, $3, 150000, 200000, 236047, 239000, 202540, 35, false, 14, 0, 'push') returning id`,
          [company.companyId, shopId, variantId],
        )
      ).rows[0]!.id
    : null;
  await db.query(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, price_calc_id)
     values ($1, $2, $3, $4, 'delisted', 'item-1', $5, $6)`,
    [company.companyId, shopId, variantId, `SKU-${randomUUID().slice(0, 8)}`, randomUUID(), calc],
  );
}

/** Gian hàng đã ngắt có đủ mọi loại dữ liệu của issue #398 "Xoá gì". */
async function fullShop() {
  const s = await shop();
  const c = company.companyId;
  const held = await seedPackage(c, { status: 'reserved', shopId: s.id, lines: [{ variantId, quantity: 1, reserved: true }, { variantId, quantity: 2, reserved: true }] });
  const done = await seedPackage(c, { status: 'delivered', shopId: s.id, lines: [{ variantId, quantity: 1 }] });
  const req = await db.query<{ id: string }>(
    `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, reason)
     values ($1, $2, $3, 'marketplace', $4, $5, 'Khách đổi ý') returning id`,
    [c, `TR-${randomUUID().slice(0, 8)}`, done.orderId, s.id, randomUUID()],
  );
  const requestId = req.rows[0]!.id;
  await db.query(
    `insert into "order".return_request_lines (company_id, request_id, order_line_id, package_id, variant_id, quantity, unit_price)
     select $1, $2, id, $3, variant_id, 1, 100000 from "order".order_lines where order_id = $4`,
    [c, requestId, done.packageId, done.orderId],
  );
  const parcel = await db.query<{ id: string }>(
    `insert into "order".unmatched_return_parcels (company_id, code, scanned_code, status, return_request_id, resolved_at)
     values ($1, $2, $3, 'attached', $4, now()) returning id`,
    [c, `KL-${randomUUID().slice(0, 8)}`, randomUUID(), requestId],
  );
  await db.query('insert into "order".unmatched_return_parcel_lines (company_id, parcel_id, variant_id, quantity) values ($1, $2, $3, 1)', [
    c,
    parcel.rows[0]!.id,
    variantId,
  ]);
  await listing(s.id, true);
  await db.query(
    `insert into channel.raw_orders (company_id, shop_id, external_order_id, payload, order_id) values ($1, $2, $3, '{}', $4)`,
    [c, s.id, randomUUID(), done.orderId],
  );
  await db.query(
    `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity)
     values ($1, $2, 'item-1', $3, 'SKU-SAN', 'Áo thun', 'live', 3)`,
    [c, s.id, randomUUID()],
  );
  await db.query(`insert into channel.shop_reauth_mails (company_id, shop_id, stage, deadline, seq) values ($1, $2, 'lost', now(), 1)`, [c, s.id]);
  await db.query(`insert into finance.config_versions (company_id, kind, shop_id, status, payload) values ($1, 'fee', $2, 'draft', '{}')`, [c, s.id]);
  await db.query(`insert into finance.order_settlements (order_id, company_id, shop_id, status) values ($1, $2, $3, 'none')`, [done.orderId, c, s.id]);
  await db.query(`insert into insight.daily_channel_summary (company_id, day, source, shop_id) values ($1, '2026-11-01', 'marketplace', $2)`, [c, s.id]);
  const mc = await db.query<{ id: string }>(
    `insert into channel.message_channels (company_id, kind, external_account_id, display_name, shop_id)
     values ($1, 'tiktok_chat', $2, 'Chat sàn', $3) returning id`,
    [c, randomUUID(), s.id],
  );
  const conv = await db.query<{ id: string }>('insert into channel.conversations (company_id, message_channel_id) values ($1, $2) returning id', [c, mc.rows[0]!.id]);
  await db.query(`insert into channel.messages (company_id, conversation_id, direction, type, content) values ($1, $2, 'inbound', 'text', '{}')`, [
    c,
    conv.rows[0]!.id,
  ]);
  const doc = async (kind: string, status: string, sourceType: string | null, sourceId: string | null, shopId: string | null, orderId: string | null) =>
    (
      await db.query<{ id: string }>(
        `insert into product.stock_documents (company_id, number, kind, status, counted_at, is_opening, source_type, source_id, shop_id, order_id, posted_at)
         values ($1, $2, $3::product.stock_document_kind, $4::product.stock_document_status, case when $3 = 'stocktake' then now() end,
           $5::text = 'shop_setup', $5, $6, $7, $8, case when $4 = 'posted' then now() end)
         returning id`,
        [c, `PK-${randomUUID().slice(0, 8)}`, kind, status, sourceType, sourceId, shopId, orderId],
      )
    ).rows[0]!.id;
  const opening = await doc('stocktake', 'posted', 'shop_setup', s.id, null, null);
  const shipment = await doc('shipment', 'posted', 'package', done.packageId, null, done.orderId);
  const inspection = await doc('return_inspection', 'draft', 'return_request', requestId, s.id, done.orderId);
  await db.query(
    `insert into core.state_transitions (company_id, entity_type, entity_id, from_state, to_state, action, source) values ($1, 'shops', $2, 'active', 'disconnected', 'disconnect', 'user')`,
    [c, s.id],
  );
  return { ...s, orderIds: [held.orderId, done.orderId], packageIds: [held.packageId, done.packageId], requestId, opening, shipment, inspection };
}

/** Số dòng mọi bảng phải xoá của gian hàng. */
async function rowsOf(s: Awaited<ReturnType<typeof fullShop>>) {
  const one = (sql: string, p: unknown) => n(sql, [p]);
  return {
    shops: await one('select count(*) as n from channel.shops where id = $1', s.id),
    orders: await one('select count(*) as n from "order".orders where shop_id = $1', s.id),
    orderLines: await one('select count(*) as n from "order".order_lines where order_id = any($1)', s.orderIds),
    returnRequests: await one('select count(*) as n from "order".return_requests where shop_id = $1', s.id),
    returnRequestLines: await one('select count(*) as n from "order".return_request_lines where request_id = $1', s.requestId),
    packages: await one('select count(*) as n from "order".packages where order_id = any($1)', s.orderIds),
    packageLines: await one('select count(*) as n from "order".package_lines where package_id = any($1)', s.packageIds),
    returnParcels: await one('select count(*) as n from "order".unmatched_return_parcels where return_request_id = $1', s.requestId),
    listings: await one('select count(*) as n from channel.listings where shop_id = $1', s.id),
    priceCalculations: await one('select count(*) as n from channel.price_calculations where shop_id = $1', s.id),
    rawOrders: await one('select count(*) as n from channel.raw_orders where shop_id = $1', s.id),
    remoteSkus: await one('select count(*) as n from channel.remote_skus where shop_id = $1', s.id),
    reauthMails: await one('select count(*) as n from channel.shop_reauth_mails where shop_id = $1', s.id),
    configVersions: await one('select count(*) as n from finance.config_versions where shop_id = $1', s.id),
    orderSettlements: await one('select count(*) as n from finance.order_settlements where shop_id = $1', s.id),
    reportRows: await one('select count(*) as n from insight.daily_channel_summary where shop_id = $1', s.id),
    messageChannels: await one('select count(*) as n from channel.message_channels where shop_id = $1', s.id),
    inspection: await one('select count(*) as n from product.stock_documents where id = $1', s.inspection),
  };
}

const docOf = async (id: string) =>
  (await db.query<{ shop_id: string | null; note: string | null; status: string }>('select shop_id, note, status from product.stock_documents where id = $1', [id]))
    .rows[0];

describe('DELETE /channel/shops/:id (#398)', () => {
  it('CEO xoá gian hàng đã ngắt: 200, mọi bảng của gian hàng còn 0 dòng', async () => {
    const s = await fullShop();
    // Cùng công ty: gian hàng B có đơn, kiện, listing; một đơn tạo tay. Công ty khác: gian hàng cùng mã seller.
    const b = await shop('active');
    const bPkg = await seedPackage(company.companyId, { status: 'reserved', shopId: b.id, lines: [{ variantId, quantity: 1, reserved: true }] });
    await listing(b.id, false);
    const manual = await createOrder(company.companyId, { lines: [{ variantId, quantity: 1, unitPrice: 100000 }] });
    const other = await createCompany({ optionalModules: ['channel'] });
    const otherShop = await db.query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status) values ($1, 'lazada', $2, 'Shop khác', 'connecting') returning id`,
      [other.companyId, `seller-${s.token}`],
    );
    await db.query(
      `insert into core.audit_logs (company_id, actor_id, action, entity_type, entity_id, entity_label) values ($1, null, 'update', 'channel.shops', $2, $3)`,
      [company.companyId, s.id, s.name],
    );
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await del(s.id, { confirm: 'XOA', version: s.version });

    expect(res.status).toBe(200);
    expect(ShopDeleteResult.parse(res.body)).toEqual({
      deleted: {
        orders: 2,
        orderLines: 3,
        returnRequests: 1,
        returnRequestLines: 1,
        packages: 2,
        packageLines: 3,
        returnParcels: 1,
        listings: 1,
        priceCalculations: 1,
        rawOrders: 1,
        remoteSkus: 1,
        stockDocuments: 1,
        configVersions: 1,
        orderSettlements: 1,
        reportRows: 1,
        messageChannels: 1,
      },
      detached: { stockDocuments: 2 },
    });
    expect(Object.values(await rowsOf(s)).every((v) => v === 0)).toBe(true);
    // Giữ: lịch sử, nhật ký cũ; phiếu đã ghi sổ (cắt `shop_id`).
    expect(await n('select count(*) as n from core.state_transitions where entity_id = $1', [s.id])).toBeGreaterThan(0);
    expect(await n(`select count(*) as n from core.audit_logs where entity_id = $1 and action = 'update'`, [s.id])).toBe(1);
    for (const id of [s.opening, s.shipment]) {
      expect(await docOf(id)).toMatchObject({ shop_id: null, status: 'posted', note: `Gian hàng ${s.name} đã xoá` });
    }
    // Đang giữ giảm đúng 3 (kiện reserved của A), tồn thực không đổi.
    const after = await stockOfVariant(company.companyId, variantId);
    expect(after.reserved).toBe(before.reserved - 3);
    expect(after.onHand).toBe(before.onHand);
    // Gian hàng B, đơn tạo tay, công ty khác còn nguyên.
    expect(await n('select count(*) as n from "order".packages where id = $1', [bPkg.packageId])).toBe(1);
    expect(await n('select count(*) as n from channel.listings where shop_id = $1', [b.id])).toBe(1);
    expect(await n('select count(*) as n from "order".orders where id = $1', [manual.orderId])).toBe(1);
    expect(await n('select count(*) as n from channel.shops where id = $1', [otherShop.rows[0]!.id])).toBe(1);
    // Nhật ký xoá.
    const audit = await db.query<{ entity_label: string; before: Record<string, unknown>; after: Record<string, unknown>; actor_id: string }>(
      `select entity_label, before, after, actor_id from core.audit_logs where entity_id = $1 and action = 'delete' and entity_type = 'channel.shops'`,
      [s.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      entity_label: s.name,
      before: { shopName: s.name, platform: 'lazada', externalShopId: `seller-${s.token}`, status: 'disconnected' },
      after: { deleted: { orders: 2 }, detached: { stockDocuments: 2 } },
    });
  });

  it.each(['active', 'needs_reauth', 'connecting'] as const)('gian hàng %s: 409 shop_not_disconnected, không xoá gì', async (status) => {
    const s = await shop(status);
    await listing(s.id, false);

    const res = await del(s.id, { confirm: 'XOA', version: s.version });

    expect(res.status).toBe(409);
    expect(ShopDeleteConflict.parse(res.body)).toMatchObject({ code: 'shop_not_disconnected', current: { id: s.id, status } });
    expect(await n('select count(*) as n from channel.listings where shop_id = $1', [s.id])).toBe(1);
  });

  it('version cũ: 409 version_conflict kèm current', async () => {
    const s = await shop();

    const res = await del(s.id, { confirm: 'XOA', version: s.version - 1 });

    expect(res.status).toBe(409);
    expect(ShopDeleteConflict.parse(res.body)).toMatchObject({ code: 'version_conflict', current: { id: s.id, version: s.version } });
  });

  it.each([
    ['ledgerEntries', `insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, shop_id) values ($1, 'revenue', '1000', true, '2026-11-01', $2)`],
    ['settlementBatches', `insert into finance.settlement_batches (company_id, shop_id, source, period_from, period_to, status) values ($1, $2, 'api', '2026-10-01', '2026-10-02', 'done')`],
  ])('có %s: 409 shop_has_finance_data, không xoá gì', async (group, sql) => {
    const s = await fullShop();
    await db.query(sql, [company.companyId, s.id]);
    const rowsBefore = await rowsOf(s);

    const res = await del(s.id, { confirm: 'XOA', version: s.version });

    expect(res.status).toBe(409);
    expect(ShopDeleteConflict.parse(res.body)).toMatchObject({ code: 'shop_has_finance_data', financeData: { [group]: 1 } });
    expect(await rowsOf(s)).toEqual(rowsBefore);
  });

  it('đối soát theo đơn khác none: 409 shop_has_finance_data', async () => {
    const s = await fullShop();
    await db.query(`update finance.order_settlements set status = 'pending' where shop_id = $1`, [s.id]);

    const res = await del(s.id, { confirm: 'XOA', version: s.version });

    expect(res.status).toBe(409);
    expect(ShopDeleteConflict.parse(res.body)).toMatchObject({ code: 'shop_has_finance_data', financeData: { orderSettlements: 1 } });
    expect(await n('select count(*) as n from channel.shops where id = $1', [s.id])).toBe(1);
  });

  it('còn phiếu kiểm hàng hoàn nháp đã quét: 409 shop_has_open_inspection, không xoá gì', async () => {
    const s = await fullShop();
    const { documentId, number } = await withCompany(company.companyId, () =>
      receiveBack({ type: 'package', id: s.packageIds[1]! }, [{ variantId, expected: 1, scanned: 1 }], { shopId: s.id, orderId: s.orderIds[1]! }),
    );
    const rowsBefore = await rowsOf(s);
    const stockBefore = await stockOfVariant(company.companyId, variantId);

    const res = await del(s.id, { confirm: 'XOA', version: s.version });

    expect(res.status).toBe(409);
    expect(ShopDeleteConflict.parse(res.body)).toMatchObject({ code: 'shop_has_open_inspection', documents: [{ id: documentId, number }] });
    expect(await rowsOf(s)).toEqual(rowsBefore);
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(stockBefore);
    expect((await docOf(documentId))!.status).toBe('draft');
  });

  it.each([['xoa'], ['XOA '], [undefined]])('confirm %j: 422 errors.confirm', async (confirm) => {
    const s = await shop();

    const res = await del(s.id, { confirm, version: s.version });

    expect(res.status).toBe(422);
    expect(res.body.errors.confirm).toBe('Gõ đúng XOA để xác nhận xoá');
    expect(await n('select count(*) as n from channel.shops where id = $1', [s.id])).toBe(1);
  });

  it.each(['admin', 'sale'] as const)('%s: 403', async (role) => {
    const s = await shop();
    const member = await addMember(company.companyId, role);

    const res = await del(s.id, { confirm: 'XOA', version: s.version }, member.token);

    expect(res.status).toBe(403);
    expect(await n('select count(*) as n from channel.shops where id = $1', [s.id])).toBe(1);
  });

  it('gian hàng công ty khác hay id sai dạng: 404', async () => {
    const other = await createCompany({ optionalModules: ['channel'] });
    const foreign = await db.query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name, status) values ($1, 'lazada', $2, 'Shop khác', 'disconnected') returning id`,
      [other.companyId, randomUUID()],
    );

    const res = await del(foreign.rows[0]!.id, { confirm: 'XOA', version: 1 });
    const bad = await del('abc', { confirm: 'XOA', version: 1 });

    expect([res.status, res.body.code]).toEqual([404, 'not_found']);
    expect([bad.status, bad.body.code]).toEqual([404, 'not_found']);
    expect(await n('select count(*) as n from channel.shops where id = $1', [foreign.rows[0]!.id])).toBe(1);
  });

  it('việc nền của gian hàng đang giữ khoá: 409 shop_busy', async () => {
    const s = await shop();
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const acquired = new Promise<void>((r) => (locked = r));
    const holder = withSessionLock('channel.remote_skus:' + s.id, async () => {
      locked();
      await holding;
    });
    try {
      await acquired;
      const res = await del(s.id, { confirm: 'XOA', version: s.version });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('shop_busy');
    } finally {
      release();
      await holder;
    }
    expect(await n('select count(*) as n from channel.shops where id = $1', [s.id])).toBe(1);
  }, 20_000);

  it('lỗi giữa chừng: rollback, mọi bảng còn nguyên', async () => {
    const s = await fullShop();
    const fn = `channel.test_block_${s.id.replaceAll('-', '')}`;
    await db.query(
      `create function ${fn}() returns trigger language plpgsql as $$
       begin if old.shop_id = '${s.id}' then raise exception 'chặn xoá thử'; end if; return old; end $$`,
    );
    await db.query(`create trigger test_block before delete on channel.raw_orders for each row execute function ${fn}()`.replace('test_block', `tb_${s.id.slice(0, 8)}`));
    const rowsBefore = await rowsOf(s);
    const stockBefore = await stockOfVariant(company.companyId, variantId);
    try {
      const res = await del(s.id, { confirm: 'XOA', version: s.version });
      expect(res.status).toBe(500);
    } finally {
      await db.query(`drop trigger tb_${s.id.slice(0, 8)} on channel.raw_orders`);
      await db.query(`drop function ${fn}()`);
    }
    expect(await rowsOf(s)).toEqual(rowsBefore);
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(stockBefore);
    expect((await docOf(s.opening))!.note).toBeNull();
    expect((await docOf(s.opening))!.shop_id).toBeNull(); // phiếu đầu kỳ nhận diện theo source_id, không có shop_id
    expect(await n('select count(*) as n from core.audit_logs where entity_id = $1 and action = $2', [s.id, 'delete'])).toBe(0);
  });

  it('nối lại cùng seller sau khi xoá: tạo gian hàng mới', async () => {
    const s = await shop();
    expect((await del(s.id, { confirm: 'XOA', version: s.version })).status).toBe(200);

    const res = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ accessToken: `tok-${s.token}` });

    expect(res.status).toBe(201);
    expect(res.body.shop.id).not.toBe(s.id);
    expect(res.body.shops[0].previousStatus).toBeNull();
  });
});
