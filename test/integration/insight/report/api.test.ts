import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { login, testApp } from '../../helpers/http.ts';
import { revokePermission, setModuleEnabled } from '../../helpers/state.ts';
import { invoice, issuedOrder, receipt, reverseInvoice, settlementLine, shopFor } from './helpers.ts';
import { recompute } from '#src/modules/insight/report/service/recompute.ts';

// API báo cáo CEO (Documents/21 §12.7; plan #29 lát 5–6; AC-1…AC-4, AC-6…AC-9, AC-11, AC-14, AC-15, AC-19).

const API = '/api/v1/report';
const get = (path: string, token?: string) => {
  const req = request(testApp()).get(`${API}${path}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const VIEW = ['report.dashboard.view', 'finance.invoice.view'];

/** Công ty có: gian hàng A đã đối soát, gian hàng B chưa, đơn tay có phiếu thu (18/10) bị đảo hoá đơn (20/10). */
async function sample() {
  const company = await createCompany();
  const { companyId } = company;
  const a = await issuedOrder(companyId, { unitCost: 120000, unitPrice: 200000, source: 'marketplace' });
  const b = await issuedOrder(companyId, { unitCost: 50000, unitPrice: 80000, source: 'marketplace' });
  const manual = await issuedOrder(companyId, { unitCost: '33333.33', unitPrice: 100000 });
  const shopA = await shopFor(companyId, a.orderId, 'Gian A');
  const shopB = await shopFor(companyId, b.orderId, 'Gian B');
  await invoice(companyId, a.orderId, 200000, '2026-10-18T03:00:00Z');
  await invoice(companyId, b.orderId, 80000, '2026-10-18T04:00:00Z');
  const manualInvoice = await invoice(companyId, manual.orderId, 100000, '2026-10-18T05:00:00Z');
  await receipt(companyId, manual.orderId, 100000, '2026-10-18T05:00:00Z');
  await settlementLine(companyId, a.orderId, { fees: { commission: 10000, transactionFee: 2000 }, shippingCost: 15000 });
  await reverseInvoice(companyId, manualInvoice, '2026-10-20T02:00:00Z');
  await recompute(companyId, '2026-10-17', '2026-10-21');
  return { ...company, shopA, shopB };
}

const RANGE = '?from=2026-10-18&to=2026-10-20';
const ZERO = { revenue: 0, cashCollected: 0, platformFee: 0, paymentFee: 0, shippingFee: 0, cogs: 0, profit: 0, feesPending: false };
const TOTAL = {
  revenue: 280000,
  cashCollected: 100000,
  platformFee: 12000,
  paymentFee: 0,
  shippingFee: 15000,
  cogs: 170000,
  profit: 83000,
  feesPending: true,
};

let s: Awaited<ReturnType<typeof sample>>;
beforeAll(async () => {
  s = await sample();
});

describe('GET /report/overview (AC-1, AC-19)', () => {
  it('số của cả công ty trong khoảng, asOf là lần tính lại gần nhất', async () => {
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
  it('một dòng mỗi gian hàng / nguồn, total bằng overview', async () => {
    const res = await get(`/shops${RANGE}`, s.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toEqual(TOTAL);
    expect(res.body.items).toEqual([
      {
        source: 'marketplace',
        shop: { id: s.shopA, shopName: 'Gian A', platform: 'tiktok' },
        ...ZERO,
        revenue: 200000,
        platformFee: 12000,
        shippingFee: 15000,
        cogs: 120000,
        profit: 53000,
      },
      {
        source: 'marketplace',
        shop: { id: s.shopB, shopName: 'Gian B', platform: 'tiktok' },
        ...ZERO,
        revenue: 80000,
        cogs: 50000,
        profit: 30000,
        feesPending: true,
      },
      { source: 'manual', shop: null, ...ZERO, cashCollected: 100000 },
    ]);
  });
});

describe('GET /report/daily (AC-3)', () => {
  it('đủ mọi ngày, ngày trống trả 0', async () => {
    const res = await get(`/daily${RANGE}`, s.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { day: '2026-10-18', revenue: 380000, cashCollected: 100000, platformFee: 12000, paymentFee: 0, shippingFee: 15000, cogs: 203333, profit: 149667, feesPending: true },
      { day: '2026-10-19', ...ZERO },
      { day: '2026-10-20', ...ZERO, revenue: -100000, cogs: -33333, profit: -66667 },
    ]);
  });

  it('lọc theo gian hàng (không cần source) và theo nguồn', async () => {
    const shop = await get(`/daily${RANGE}&shopId=${s.shopB}`, s.ceo.token);
    expect(shop.body.items.map((d: { revenue: number }) => d.revenue)).toEqual([80000, 0, 0]);
    const manual = await get(`/daily${RANGE}&source=manual`, s.ceo.token);
    expect(manual.body.items.map((d: { revenue: number }) => d.revenue)).toEqual([100000, 0, -100000]);
  });
});

describe('quyền (AC-6, AC-7, AC-11, AC-14)', () => {
  it('thiếu token 401; token chưa chọn công ty 403 company_not_selected', async () => {
    expect((await get('/overview')).status).toBe(401);
    const { token } = await login(s.ceo.email);
    const res = await get('/overview', token);
    expect([res.status, res.body.code]).toEqual([403, 'company_not_selected']);
  });

  it('Admin (thiếu finance.invoice.view) bị 403 forbidden ở cả 4 API, kể cả xuất CSV', async () => {
    const admin = await addMember(s.companyId, 'admin');
    for (const path of ['/overview', '/shops', '/daily', '/export?report=overview']) {
      const res = await get(path, admin.token);
      expect([path, res.status, res.body.code]).toEqual([path, 403, 'forbidden']);
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
    expect((await get(`/overview${RANGE}`, member.token)).body).toMatchObject({ cogs: 170000, profit: 83000 });
    await revokePermission(roleId, 'inventory.cost.view');
    const res = await get(`/shops${RANGE}`, member.token);
    expect(res.body.total).toMatchObject({ revenue: 280000, cogs: null, profit: null });
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
  it('công ty khác cùng khoảng ngày không thấy số của công ty này', async () => {
    const other = await createCompany();
    const res = await get(`/shops${RANGE}`, other.ceo.token);
    expect(res.body).toEqual({ from: '2026-10-18', to: '2026-10-20', asOf: null, items: [], total: ZERO });
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
    const admin = await addMember(s.companyId, 'admin');
    expect((await get('/overview?from=xx', admin.token)).status).toBe(403);
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
      'Từ ngày,Đến ngày,Doanh thu,Tiền đã thu,Phí sàn,Phí cổng,Phí vận chuyển,Giá vốn,Lãi,Phí sàn chờ đối soát\r\n' +
        '2026-10-18,2026-10-20,280000,100000,12000,0,15000,170000,83000,có\r\n',
    );
  });

  it('theo gian hàng: một dòng mỗi gian hàng, dòng Tổng cuối', async () => {
    const { body } = await csv(`?report=shops&from=2026-10-18&to=2026-10-20`);
    const lines = body.subarray(3).toString('utf8').trimEnd().split('\r\n');
    expect(lines).toEqual([
      'Nguồn,Sàn,Gian hàng,Doanh thu,Tiền đã thu,Phí sàn,Phí cổng,Phí vận chuyển,Giá vốn,Lãi,Phí sàn chờ đối soát',
      'Sàn,tiktok,Gian A,200000,0,12000,0,15000,120000,53000,không',
      'Sàn,tiktok,Gian B,80000,0,0,0,0,50000,30000,có',
      'Đơn tạo tay,,,0,100000,0,0,0,0,0,không',
      'Tổng,,,280000,100000,12000,0,15000,170000,83000,có',
    ]);
  });

  it('theo ngày, thiếu inventory.cost.view: không có cột Giá vốn, Lãi', async () => {
    const member = await addMember(s.companyId, await createCustomRole(s.companyId, [...VIEW, 'report.dashboard.export']));
    const { res, body } = await csv(`?report=daily&from=2026-10-18&to=2026-10-19&source=manual`, member.token);
    expect(res.headers['content-disposition']).toBe('attachment; filename="bao-cao-daily-2026-10-18-2026-10-19.csv"');
    expect(body.subarray(3).toString('utf8')).toBe(
      'Ngày,Doanh thu,Tiền đã thu,Phí sàn,Phí cổng,Phí vận chuyển,Phí sàn chờ đối soát\r\n' +
        '2026-10-18,100000,100000,0,0,0,không\r\n' +
        '2026-10-19,0,0,0,0,0,không\r\n',
    );
  });
});
