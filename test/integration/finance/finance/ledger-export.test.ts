import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { voucherNoOf } from '#src/modules/finance/finance/domain/misa-export.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Xuất sổ cho MISA (#232; Documents/21 §21.1, US-TI-15). Dòng sổ, cấu hình ghi thẳng bằng role chủ bảng: luồng ghi sổ,
// duyệt cấu hình đã có test riêng.
const app = testApp();
const exportFile = (token: string, query: string) =>
  request(app)
    .get(`/api/v1/finance/ledger/export?${query}`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

const ACCOUNTS = {
  platformReceivable: '1388',
  customerReceivable: '131',
  revenue: '5111',
  outputVat: '33311',
  otherIncome: '711',
  sellingExpense: '6418',
  adminExpense: '6428',
  otherExpense: '811',
  withheldTax: '3339',
  cogs: '632',
  inventory: '1561',
  bank: '1121',
  cash: '1111',
  supplierPayable: '331',
};

async function config(companyId: string, kind: string, payload: object, effectiveFrom = '2026-10-01') {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, 'active', $3, $4, $5, $6, now())`,
    [companyId, kind, JSON.stringify(payload), effectiveFrom, randomUUID(), randomUUID()],
  );
}

async function shop(companyId: string, platform: string, name: string) {
  const ext = String(Math.floor(Math.random() * 1e9));
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, $2, $3, $4) returning id`,
    [companyId, platform, ext, name],
  );
  return { id: rows[0]!.id, ext };
}

async function entry(companyId: string, cols: Record<string, unknown>): Promise<string> {
  const all = { company_id: companyId, is_estimate: false, occurred_on: '2026-11-05', ...cols };
  const keys = Object.keys(all);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into finance.ledger_entries (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
  return rows[0]!.id;
}

async function setup(regime = 'company') {
  const c = await createCompany();
  await config(c.companyId, 'tax_regime', { regime });
  await config(c.companyId, 'tax_rules', { vatPct: 0, pitPct: 0, outputVatPct: 10, milestones: [] });
  await config(c.companyId, 'account_map', { accounts: ACCOUNTS });
  const lz = await shop(c.companyId, 'lazada', 'Shop Lazada');
  const tt = await shop(c.companyId, 'tiktok', 'Shop TikTok');
  return { ...c, lz, tt };
}

async function sheets(body: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(body as unknown as ArrayBuffer);
  const read = (name: string) => {
    const ws = book.getWorksheet(name)!;
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const rows: Record<string, unknown>[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const v = (row.values as unknown[]).slice(1);
      rows.push(Object.fromEntries(header.map((h, i) => [h, v[i] ?? ''])));
    });
    return { header, rows };
  };
  return { vouchers: read('Chứng từ nghiệp vụ khác'), objects: read('Danh mục đối tượng') };
}

describe('GET /finance/ledger/export (#232)', () => {
  it('tháng 11: chỉ dòng thực tế và giá vốn, mỗi gian hàng một mã đối tượng, TK theo account_map, tách GTGT', async () => {
    const s = await setup();
    const rev = await entry(s.companyId, { kind: 'revenue', amount: '110000', shop_id: s.lz.id, external_order_id: 'LZ-1' });
    await entry(s.companyId, { kind: 'fee_fixed', amount: '-5000', shop_id: s.tt.id });
    await entry(s.companyId, { kind: 'cogs', amount: '-60000', shop_id: s.lz.id, is_estimate: true });
    await entry(s.companyId, { kind: 'supplier_payment', amount: '-300000' });
    await entry(s.companyId, { kind: 'revenue', amount: '99000', shop_id: s.lz.id, is_estimate: true }); // ước tính: không xuất
    await entry(s.companyId, { kind: 'revenue', amount: '50000', shop_id: s.lz.id, occurred_on: '2026-12-01' }); // ngoài kỳ

    const res = await exportFile(s.ceo.token, 'from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe('attachment; filename="so-misa-2026-11-01-2026-11-30.xlsx"');

    const { vouchers, objects } = await sheets(res.body);
    expect(vouchers.header).toContain('Số chứng từ (*)');
    // doanh thu 2 dòng (tách GTGT) + phí + giá vốn + trả NCC
    expect(vouchers.rows).toHaveLength(5);
    const revRows = vouchers.rows.filter((r) => r['Số chứng từ (*)'] === voucherNoOf(rev));
    expect(revRows.map((r) => [r['TK Nợ (*)'], r['TK Có (*)'], r['Số tiền'], r['Đối tượng Nợ']])).toEqual([
      ['1388', '5111', 100000, `LAZADA-${s.lz.ext}`],
      ['1388', '33311', 10000, `LAZADA-${s.lz.ext}`],
    ]);
    const fee = vouchers.rows.find((r) => r['TK Nợ (*)'] === '6418')!;
    expect(fee).toMatchObject({ 'TK Có (*)': '1388', 'Đối tượng Có': `TIKTOK-${s.tt.ext}`, 'Số tiền': 5000 });
    expect(vouchers.rows.find((r) => r['TK Nợ (*)'] === '632')).toMatchObject({ 'TK Có (*)': '1561', 'Số tiền': 60000 });
    expect(vouchers.rows.find((r) => r['TK Nợ (*)'] === '331')).toMatchObject({ 'TK Có (*)': '1121', 'Đối tượng Nợ': '', 'Đối tượng Có': '' });
    expect(new Date(vouchers.rows[0]!['Ngày hạch toán (*)'] as Date).toISOString().slice(0, 10)).toBe('2026-11-05');
    expect(objects.rows).toEqual(
      expect.arrayContaining([
        { 'Mã đối tượng (*)': `LAZADA-${s.lz.ext}`, 'Tên đối tượng (*)': 'Shop Lazada' },
        { 'Mã đối tượng (*)': `TIKTOK-${s.tt.ext}`, 'Tên đối tượng (*)': 'Shop TikTok' },
      ]),
    );
    expect(objects.rows).toHaveLength(2);
  });

  it('xuất lại cùng kỳ ra cùng số chứng từ; đổi account_map thì TK đổi theo', async () => {
    const s = await setup();
    await entry(s.companyId, { kind: 'fee_fixed', amount: '-5000', shop_id: s.lz.id });
    const first = await sheets((await exportFile(s.ceo.token, 'from=2026-11-01&to=2026-11-30')).body);
    const again = await sheets((await exportFile(s.ceo.token, 'from=2026-11-01&to=2026-11-30')).body);
    expect(again.vouchers.rows).toEqual(first.vouchers.rows);

    await testPool().query(`update finance.config_versions set effective_to = '2026-11-19' where company_id = $1 and kind = 'account_map'`, [s.companyId]);
    await config(s.companyId, 'account_map', { accounts: { ...ACCOUNTS, sellingExpense: '6417' }, shopObjects: { [s.lz.id]: 'KH-LAZADA' } }, '2026-11-20');
    const changed = await sheets((await exportFile(s.ceo.token, 'from=2026-11-01&to=2026-11-30')).body);
    expect(changed.vouchers.rows[0]).toMatchObject({ 'TK Nợ (*)': '6417', 'Đối tượng Có': 'KH-LAZADA' });
    expect(changed.objects.rows).toEqual([{ 'Mã đối tượng (*)': 'KH-LAZADA', 'Tên đối tượng (*)': 'Shop Lazada' }]);
  });

  it('Admin (không có inventory.cost.view) nhận tệp không có dòng giá vốn', async () => {
    const s = await setup();
    await entry(s.companyId, { kind: 'cogs', amount: '-60000', shop_id: s.lz.id });
    await entry(s.companyId, { kind: 'fee_fixed', amount: '-5000', shop_id: s.lz.id });
    const admin = await addMember(s.companyId, 'admin');
    const res = await exportFile(admin.token, 'from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    const { vouchers } = await sheets(res.body);
    expect(vouchers.rows.map((r) => r['TK Nợ (*)'])).toEqual(['6418']);
  });

  it('không lộ dòng của công ty khác', async () => {
    const a = await setup();
    const b = await setup();
    await entry(b.companyId, { kind: 'fee_fixed', amount: '-7000', shop_id: b.lz.id });
    const { vouchers } = await sheets((await exportFile(a.ceo.token, 'from=2026-11-01&to=2026-11-30')).body);
    expect(vouchers.rows).toHaveLength(0);
  });

  it('401 không token; Sale, Kho 403 trước khi kiểm query', async () => {
    const s = await setup();
    expect((await request(app).get('/api/v1/finance/ledger/export?from=x')).status).toBe(401);
    for (const role of ['sale', 'warehouse'] as const) {
      const m = await addMember(s.companyId, role);
      const res = await exportFile(m.token, 'from=x');
      expect(res.status).toBe(403);
    }
  });

  it('422 theo ô: from sau to, kỳ quá 366 ngày, format lạ', async () => {
    const s = await setup();
    const err = async (q: string) => JSON.parse((await exportFile(s.ceo.token, q)).body.toString());
    expect((await err('from=2026-11-30&to=2026-11-01')).errors).toHaveProperty('to');
    expect((await err('from=2025-01-01&to=2026-11-01')).errors).toHaveProperty('to');
    expect((await err('from=2026-11-01&to=2026-11-30&format=fast')).errors).toHaveProperty('format');
  });

  it('409 khi không phải doanh nghiệp hoặc chưa có account_map, kèm chỗ sửa', async () => {
    const hh = await setup('household');
    const r1 = await exportFile(hh.ceo.token, 'from=2026-11-01&to=2026-11-30');
    expect(r1.status).toBe(409);
    expect(JSON.parse(r1.body.toString()).type).toContain('export_not_supported');

    const c = await createCompany();
    await config(c.companyId, 'tax_regime', { regime: 'company' });
    const r2 = await exportFile(c.ceo.token, 'from=2026-11-01&to=2026-11-30');
    expect(r2.status).toBe(409);
    expect(JSON.parse(r2.body.toString()).type).toContain('account_map_missing');
  });
});
