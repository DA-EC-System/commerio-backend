import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { login, testApp } from '../../helpers/http.ts';
import { revokePermission, setModuleEnabled } from '../../helpers/state.ts';
import { ledgerRow, replaces, shopOf } from './helpers.ts';

// API báo cáo (Documents/21 §21.5, #333; plan #29 AC-1…AC-4, AC-6…AC-9, AC-11, AC-14, AC-15, AC-19): gom thẳng sổ tiền.

const API = '/api/v1/report';
const get = (path: string, token?: string) => {
  const req = request(testApp()).get(`${API}${path}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const VIEW = ['report.dashboard.view'];

/**
 * Sổ của một công ty:
 * - Gian A, 18/10: doanh thu và phí ước tính của kiện P1; sàn quyết toán doanh thu (thay dòng ước tính qua bảng nối),
 *   phí và ship (dòng phí ước tính cùng nguồn P1 nên cũng hết tính); giá vốn. 19/10 rút tiền, quảng cáo (ngoài lãi).
 *   20/10 hoàn tiền khách. 17/10 một dòng ngoài khoảng.
 * - Gian B, 18/10: chỉ có số ước tính (chưa quyết toán).
 * - Không gian hàng, 18/10: trả NCC, chi vận hành (ngoài lãi bán hàng).
 * - Công ty khác cùng ngày có doanh thu riêng.
 */
async function sample() {
  const company = await createCompany();
  const { companyId: c } = company;
  const shopA = await shopOf(c, 'Gian A');
  const shopB = await shopOf(c, 'Gian B');
  const day = '2026-10-18';
  const p1 = randomUUID();
  const estRevenue = await ledgerRow(c, { kind: 'revenue', amount: 200000, day, shopId: shopA, estimate: true, sourceId: p1 });
  await ledgerRow(c, { kind: 'fee_transaction', amount: -10000, day, shopId: shopA, estimate: true, sourceId: p1 });
  const actRevenue = await ledgerRow(c, { kind: 'revenue', amount: 200000, day, shopId: shopA });
  await replaces(c, actRevenue, estRevenue);
  await ledgerRow(c, { kind: 'fee_transaction', amount: -12000, day, shopId: shopA });
  await ledgerRow(c, { kind: 'shipping_cost', amount: -15000, day, shopId: shopA });
  await ledgerRow(c, { kind: 'cogs', amount: -120000, day, shopId: shopA, sourceId: p1 });
  await ledgerRow(c, { kind: 'withdrawal', amount: -100000, day: '2026-10-19', shopId: shopA });
  await ledgerRow(c, { kind: 'ads', amount: -7000, day: '2026-10-19', shopId: shopA });
  await ledgerRow(c, { kind: 'customer_refund', amount: -30000, day: '2026-10-20', shopId: shopA });
  await ledgerRow(c, { kind: 'revenue', amount: 55555, day: '2026-10-17', shopId: shopA });
  const p2 = randomUUID();
  await ledgerRow(c, { kind: 'revenue', amount: 80000, day, shopId: shopB, estimate: true, sourceId: p2 });
  await ledgerRow(c, { kind: 'fee_fixed', amount: -5000, day, shopId: shopB, estimate: true, sourceId: p2 });
  await ledgerRow(c, { kind: 'cogs', amount: -50000, day, shopId: shopB, sourceId: p2 });
  await ledgerRow(c, { kind: 'supplier_payment', amount: -300000, day });
  await ledgerRow(c, { kind: 'opex', amount: -20000, day });
  const other = await createCompany();
  await ledgerRow(other.companyId, { kind: 'revenue', amount: 999000, day, shopId: await shopOf(other.companyId, 'Gian khác') });
  return { ...company, shopA, shopB, other };
}

const RANGE = '?from=2026-10-18&to=2026-10-20';
const ZERO = {
  revenue: 0,
  net: 0,
  cashCollected: 0,
  platformFee: 0,
  paymentFee: 0,
  shippingFee: 0,
  cogs: 0,
  profit: 0,
  estimated: false,
  feesPending: false,
};
const SHOP_A = { ...ZERO, revenue: 170000, net: 143000, cashCollected: 143000, platformFee: -12000, shippingFee: -15000, cogs: -120000, profit: 23000 };
const SHOP_B = { ...ZERO, revenue: 80000, net: 75000, platformFee: -5000, cogs: -50000, profit: 25000, estimated: true, feesPending: true };
const TOTAL = {
  revenue: 250000,
  net: 218000,
  cashCollected: 143000,
  platformFee: -17000,
  paymentFee: 0,
  shippingFee: -15000,
  cogs: -170000,
  profit: 48000,
  estimated: true,
  feesPending: true,
};

let s: Awaited<ReturnType<typeof sample>>;
beforeAll(async () => {
  s = await sample();
});

describe('GET /report/overview (AC-1, AC-19)', () => {
  it('dòng còn hiệu lực trong khoảng: không cộng trùng ước tính đã thay, bỏ khoản ngoài lãi; asOf là dòng ghi mới nhất', async () => {
    const res = await get(`/overview${RANGE}`, s.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: '2026-10-18', to: '2026-10-20', asOf: expect.any(String), ...TOTAL });
  });

  it('khoảng chưa có dòng nào: số 0, asOf null', async () => {
    const res = await get('/overview?from=2025-01-01&to=2025-01-31', s.ceo.token);
    expect(res.body).toEqual({ from: '2025-01-01', to: '2025-01-31', asOf: null, ...ZERO });
  });

  it('không tham số: 30 ngày tới hôm nay (AC-15)', async () => {
    const res = await get('/overview', s.ceo.token);
    expect(res.status).toBe(200);
    const days = (Date.parse(res.body.to) - Date.parse(res.body.from)) / 86_400_000 + 1;
    expect(days).toBe(30);
  });
});

describe('GET /report/shops (AC-2)', () => {
  it('một dòng mỗi gian hàng, total bằng overview; gian đã quyết toán hết nhãn Ước tính', async () => {
    const res = await get(`/shops${RANGE}`, s.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toEqual(TOTAL);
    expect(res.body.items).toEqual([
      { source: 'marketplace', shop: { id: s.shopA, shopName: 'Gian A', platform: 'tiktok' }, ...SHOP_A },
      { source: 'marketplace', shop: { id: s.shopB, shopName: 'Gian B', platform: 'tiktok' }, ...SHOP_B },
    ]);
  });
});

describe('GET /report/daily (AC-3)', () => {
  it('đủ mọi ngày theo occurred_on; ngày chỉ có rút tiền, quảng cáo trả 0', async () => {
    const res = await get(`/daily${RANGE}`, s.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { day: '2026-10-18', ...TOTAL, revenue: 280000, net: 248000, cashCollected: 173000, profit: 78000 },
      { day: '2026-10-19', ...ZERO },
      { day: '2026-10-20', ...ZERO, revenue: -30000, net: -30000, cashCollected: -30000, profit: -30000 },
    ]);
  });

  it('lọc theo gian hàng (không cần source) và theo nguồn', async () => {
    const shop = await get(`/daily${RANGE}&shopId=${s.shopB}`, s.ceo.token);
    expect(shop.body.items.map((d: { revenue: number }) => d.revenue)).toEqual([80000, 0, 0]);
    const market = await get(`/daily${RANGE}&source=marketplace`, s.ceo.token);
    expect(market.body.items.map((d: { revenue: number }) => d.revenue)).toEqual([280000, 0, -30000]);
    for (const source of ['manual', 'inbox']) {
      const res = await get(`/daily${RANGE}&source=${source}`, s.ceo.token);
      expect([source, res.body.asOf, res.body.items.map((d: { revenue: number }) => d.revenue)]).toEqual([source, null, [0, 0, 0]]);
    }
  });
});

describe('quyền (AC-6, AC-7, AC-11, AC-14)', () => {
  it('thiếu token 401; token chưa chọn công ty 403 company_not_selected', async () => {
    expect((await get('/overview')).status).toBe(401);
    const { token } = await login(s.ceo.email);
    const res = await get('/overview', token);
    expect([res.status, res.body.code]).toEqual([403, 'company_not_selected']);
  });

  it('Admin (không có finance.invoice.view, inventory.cost.view) xem được doanh thu, thực nhận; giá vốn, lãi null', async () => {
    const admin = await addMember(s.companyId, 'admin');
    const res = await get(`/overview${RANGE}`, admin.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...TOTAL, cogs: null, profit: null });
    for (const path of ['/shops', '/daily', '/export?report=overview']) {
      expect([path, (await get(path, admin.token)).status]).toEqual([path, 200]);
    }
  });

  it('thiếu report.dashboard.view → 403; thiếu report.dashboard.export → xuất 403, xem vẫn được', async () => {
    const noView = await addMember(s.companyId, await createCustomRole(s.companyId, ['finance.invoice.view']));
    expect((await get('/overview', noView.token)).body.code).toBe('forbidden');
    const noExport = await addMember(s.companyId, await createCustomRole(s.companyId, VIEW));
    expect((await get('/overview', noExport.token)).status).toBe(200);
    const res = await get('/export?report=overview', noExport.token);
    expect([res.status, res.body.code, res.headers['content-type']]).toEqual([403, 'forbidden', expect.stringContaining('problem+json')]);
  });

  it('thiếu inventory.cost.view: cogs, profit null; thu quyền giữa chừng thấy null ngay', async () => {
    const roleId = await createCustomRole(s.companyId, [...VIEW, 'inventory.cost.view']);
    const member = await addMember(s.companyId, roleId);
    expect((await get(`/overview${RANGE}`, member.token)).body).toMatchObject({ cogs: -170000, profit: 48000 });
    await revokePermission(roleId, 'inventory.cost.view');
    const res = await get(`/shops${RANGE}`, member.token);
    expect(res.body.total).toMatchObject({ revenue: 250000, net: 218000, cogs: null, profit: null });
    expect(res.body.items.every((i: { cogs: unknown; profit: unknown }) => i.cogs === null && i.profit === null)).toBe(true);
    const daily = await get(`/daily${RANGE}`, member.token);
    expect(daily.body.items[1]).toMatchObject({ day: '2026-10-19', cogs: null, profit: null });
  });

  it('phân hệ Report tắt → 403 module_disabled (trước forbidden), cả với Admin', async () => {
    const company = await createCompany();
    const admin = await addMember(company.companyId, 'admin');
    await setModuleEnabled(company.companyId, 'report', false);
    for (const token of [company.ceo.token, admin.token]) {
      for (const path of ['/overview', '/shops', '/daily', '/export?report=daily']) {
        expect((await get(path, token)).body.code).toBe('module_disabled');
      }
    }
  });
});

describe('cô lập công ty (AC-8)', () => {
  it('hai công ty cùng ngày không lẫn số', async () => {
    const res = await get(`/overview${RANGE}`, s.other.ceo.token);
    expect(res.body).toMatchObject({ revenue: 999000, net: 999000, estimated: false });
    const empty = await createCompany();
    const none = await get(`/shops${RANGE}`, empty.ceo.token);
    expect(none.body).toEqual({ from: '2026-10-18', to: '2026-10-20', asOf: null, items: [], total: ZERO });
  });
});

describe('422 (AC-9)', () => {
  it.each([
    ['/overview?from=2026-13-01', 'from'],
    ['/overview?from=2026-02-30&to=2026-03-01', 'from'],
    ['/overview?to=18-10-2026', 'to'],
    ['/overview?from=2026-10-10&to=2026-10-01', 'from'],
    ['/overview?from=2025-01-01&to=2026-01-02', 'to'],
    ['/daily?source=shopee', 'source'],
    ['/daily?shopId=abc', 'shopId'],
    ['/daily?source=inbox&shopId=8e172605-0612-4451-bfc4-cce4d356069b', 'shopId'],
    ['/export', 'report'],
    ['/export?report=all', 'report'],
  ])('%s → errors.%s', async (path, field) => {
    const res = await get(path, s.ceo.token);
    expect([res.status, res.body.code]).toEqual([422, 'validation_failed']);
    expect(Object.keys(res.body.errors)).toEqual([field]);
  });

  it('thiếu quyền ra 403 trước 422', async () => {
    const noView = await addMember(s.companyId, await createCustomRole(s.companyId, ['finance.invoice.view']));
    expect((await get('/overview?from=xx', noView.token)).status).toBe(403);
  });
});

describe('GET /report/export (AC-4, AC-11)', () => {
  const csv = async (query: string, token = s.ceo.token) => {
    const res = await get(`/export${query}`, token).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return { res, body: res.body as Buffer };
  };

  it('tổng quan: CSV UTF-8 có BOM, tên tệp theo report và khoảng, số bằng JSON', async () => {
    const { res, body } = await csv(`?report=overview&from=2026-10-18&to=2026-10-20`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="bao-cao-overview-2026-10-18-2026-10-20.csv"');
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body.subarray(3).toString('utf8')).toBe(
      'Từ ngày,Đến ngày,Doanh thu thuần,Thực nhận,Đã quyết toán,Phí sàn,Phí vận chuyển,Giá vốn,Lãi gộp,Ước tính\r\n' +
        '2026-10-18,2026-10-20,250000,218000,143000,-17000,-15000,-170000,48000,có\r\n',
    );
  });

  it('theo gian hàng: một dòng mỗi gian hàng, dòng Tổng cuối', async () => {
    const { body } = await csv(`?report=shops&from=2026-10-18&to=2026-10-20`);
    const lines = body.subarray(3).toString('utf8').trimEnd().split('\r\n');
    expect(lines).toEqual([
      'Nguồn,Sàn,Gian hàng,Doanh thu thuần,Thực nhận,Đã quyết toán,Phí sàn,Phí vận chuyển,Giá vốn,Lãi gộp,Ước tính',
      'Sàn,tiktok,Gian A,170000,143000,143000,-12000,-15000,-120000,23000,không',
      'Sàn,tiktok,Gian B,80000,75000,0,-5000,0,-50000,25000,có',
      'Tổng,,,250000,218000,143000,-17000,-15000,-170000,48000,có',
    ]);
  });

  it('theo ngày, thiếu inventory.cost.view: không có cột Giá vốn, Lãi', async () => {
    const member = await addMember(s.companyId, await createCustomRole(s.companyId, [...VIEW, 'report.dashboard.export']));
    const { res, body } = await csv(`?report=daily&from=2026-10-18&to=2026-10-19&source=marketplace`, member.token);
    expect(res.headers['content-disposition']).toBe('attachment; filename="bao-cao-daily-2026-10-18-2026-10-19.csv"');
    expect(body.subarray(3).toString('utf8')).toBe(
      'Ngày,Doanh thu thuần,Thực nhận,Đã quyết toán,Phí sàn,Phí vận chuyển,Ước tính\r\n' +
        '2026-10-18,280000,248000,173000,-17000,-15000,có\r\n' +
        '2026-10-19,0,0,0,0,0,không\r\n',
    );
  });
});
