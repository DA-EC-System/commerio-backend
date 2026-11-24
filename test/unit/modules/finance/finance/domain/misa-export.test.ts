import { describe, expect, it } from 'vitest';
import { ACCOUNT_ROLES, type ConfigPayload, parsePayload } from '#src/modules/finance/finance/domain/config-version.ts';
import { LEDGER_KINDS } from '#src/modules/finance/finance/domain/ledger.ts';
import {
  type ExportLine,
  isExportable,
  KIND_ACCOUNTS,
  shopObjectCode,
  voucherNoOf,
  voucherRows,
} from '#src/modules/finance/finance/domain/misa-export.ts';

const accounts = {
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
const map: ConfigPayload<'account_map'> = { accounts, shopObjects: {} };
const shop = { name: 'Shop A', objectCode: 'LAZADA-1001' };
const line = (over: Partial<ExportLine>): ExportLine => ({
  id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  kind: 'revenue',
  amount: '110000',
  occurredOn: '2026-11-05',
  shopId: 's1',
  orderCode: 'DH0001',
  externalOrderId: null,
  reason: null,
  ...over,
});

describe('account_map payload', () => {
  it('nhận đủ vai trò, shopObjects tuỳ chọn', () => {
    const r = parsePayload('account_map', { accounts });
    expect(r.success && r.data).toEqual({ accounts });
  });

  it('thiếu vai trò hay số hiệu không phải chữ số thì lỗi đúng ô', () => {
    const r = parsePayload('account_map', { accounts: { ...accounts, revenue: '511A', bank: undefined } });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['accounts.revenue', 'accounts.bank']));
  });

  it('mã đối tượng có dấu cách bị chặn, khoá phải là id gian hàng', () => {
    const bad = parsePayload('account_map', { accounts, shopObjects: { '00000000-0000-4000-8000-000000000001': 'LAZADA 1' } });
    expect(bad.success).toBe(false);
    expect(parsePayload('account_map', { accounts, shopObjects: { 'not-uuid': 'X' } }).success).toBe(false);
  });
});

describe('KIND_ACCOUNTS', () => {
  it('mọi loại dòng sổ có cặp tài khoản là vai trò đã khai', () => {
    for (const k of LEDGER_KINDS) for (const role of KIND_ACCOUNTS[k]) expect(ACCOUNT_ROLES).toContain(role);
  });
});

describe('isExportable', () => {
  it('chỉ dòng thực tế và giá vốn (A2)', () => {
    expect(isExportable('revenue', false)).toBe(true);
    expect(isExportable('revenue', true)).toBe(false);
    expect(isExportable('adjustment', true)).toBe(false);
    expect(isExportable('cogs', true)).toBe(true);
    expect(isExportable('cogs_reversal', true)).toBe(true);
  });
});

describe('voucherNoOf', () => {
  it('cố định theo id dòng', () => {
    expect(voucherNoOf('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe('CM0F1E2D3C4B5A6978');
  });
});

describe('shopObjectCode', () => {
  it('khai riêng thắng, không thì SÀN-mã gian hàng', () => {
    const s = { id: 's1', platform: 'lazada', externalShopId: '1001' };
    expect(shopObjectCode(map, s)).toBe('LAZADA-1001');
    expect(shopObjectCode({ ...map, shopObjects: { s1: 'KH-LZD' } }, s)).toBe('KH-LZD');
  });
});

describe('voucherRows', () => {
  it('doanh thu doanh nghiệp tách thuế GTGT đầu ra, cùng số chứng từ, đối tượng bên phải thu sàn', () => {
    const rows = voucherRows(line({}), map, shop, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ debitAccount: '1388', creditAccount: '5111', amount: 100000, debitObject: 'LAZADA-1001', creditObject: '' });
    expect(rows[1]).toMatchObject({ debitAccount: '1388', creditAccount: '33311', amount: 10000, lineDescription: 'Thuế GTGT đầu ra' });
    expect(rows[0]!.voucherNo).toBe(rows[1]!.voucherNo);
    expect(rows[0]!.description).toBe('Doanh thu · đơn DH0001 · Shop A');
  });

  it('hoàn tiền người mua (âm) đảo bên, thuế ghi Nợ', () => {
    const rows = voucherRows(line({ kind: 'customer_refund', amount: '-110000' }), map, shop, 10);
    expect(rows[0]).toMatchObject({ debitAccount: '5111', creditAccount: '1388', amount: 100000, creditObject: 'LAZADA-1001' });
    expect(rows[1]).toMatchObject({ debitAccount: '33311', creditAccount: '1388', amount: 10000 });
  });

  it('phí sàn âm: Nợ chi phí bán hàng, Có phải thu sàn; không tách thuế', () => {
    const rows = voucherRows(line({ kind: 'fee_fixed', amount: '-5000.5' }), map, shop, 10);
    expect(rows).toEqual([expect.objectContaining({ debitAccount: '6418', creditAccount: '1388', amount: 5000.5 })]);
  });

  it('giá vốn: Nợ 632 Có 156; khoản ngoài sàn không có đối tượng; mã đơn sàn khi không có đơn app', () => {
    expect(voucherRows(line({ kind: 'cogs', amount: '-70000' }), map, shop, 10)[0]).toMatchObject({ debitAccount: '632', creditAccount: '1561', debitObject: '', creditObject: '' });
    const pay = voucherRows(line({ kind: 'supplier_payment', amount: '-300000', shopId: null, orderCode: null }), map, null, 10)[0]!;
    expect(pay).toMatchObject({ debitAccount: '331', creditAccount: '1121', debitObject: '', creditObject: '', description: 'Trả nhà cung cấp' });
    expect(voucherRows(line({ orderCode: null, externalOrderId: '777' }), map, shop, 0)[0]!.description).toBe('Doanh thu · đơn 777 · Shop A');
  });

  it('thuế suất 0 thì một dòng', () => {
    expect(voucherRows(line({}), map, shop, 0)).toHaveLength(1);
  });

  it('số tiền 0 thì không có dòng nào (MISA không nhận chứng từ 0 đồng)', () => {
    expect(voucherRows(line({ kind: 'fee_fixed', amount: '0' }), map, shop, 0)).toEqual([]);
  });
});
