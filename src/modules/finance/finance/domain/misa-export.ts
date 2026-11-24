// Xuất sổ tiền cho MISA AMIS Kế toán (#232; Documents/21 §21.1, 25 §10.5, US-TI-15). Thuần: nhận dòng sổ đã chọn,
// bản `account_map` và thuế suất GTGT đầu ra theo ngày, trả các dòng của tệp "Chứng từ nghiệp vụ khác" (Thành chốt
// 24/11/2026: mọi dòng một loại chứng từ). App không giữ sổ cái: kế toán nhập tệp này vào MISA rồi tự ghi sổ.
import { Decimal } from 'decimal.js';
import type { AccountRole, ConfigPayload } from './config-version.ts';
import { type LedgerKind, NON_CASH, outputVatOf } from './ledger.ts';

/**
 * Tên cột của mẫu nhập "Chứng từ nghiệp vụ khác". Lấy theo trang trợ giúp chính thức của MISA (mẫu thật chỉ tải được
 * trong ứng dụng); có mẫu thật thì chỉ sửa hằng này. Thứ tự khoá là thứ tự cột trong tệp.
 */
export const MISA_NVK_COLUMNS = {
  postingDate: 'Ngày hạch toán (*)',
  voucherDate: 'Ngày chứng từ (*)',
  voucherNo: 'Số chứng từ (*)',
  description: 'Diễn giải',
  lineDescription: 'Diễn giải (hạch toán)',
  debitAccount: 'TK Nợ (*)',
  creditAccount: 'TK Có (*)',
  amount: 'Số tiền',
  debitObject: 'Đối tượng Nợ',
  creditObject: 'Đối tượng Có',
} as const;
export type MisaColumn = keyof typeof MISA_NVK_COLUMNS;

/** Tên cột của sheet "Danh mục đối tượng": kế toán nhập trước để MISA nhận mã đối tượng (Thành chốt 24/11/2026). */
export const MISA_OBJECT_COLUMNS = { code: 'Mã đối tượng (*)', name: 'Tên đối tượng (*)' } as const;

/** Tên loại dòng sổ trong diễn giải (cùng chữ với nhãn loại dòng ở màn Sổ tiền). */
export const LEDGER_KIND_TEXT: Record<LedgerKind, string> = {
  revenue: 'Doanh thu',
  platform_subsidy: 'Sàn trợ giá',
  shipping_income: 'Phí vận chuyển người mua trả',
  shipping_cost: 'Phí vận chuyển',
  fee_fixed: 'Phí cố định',
  fee_transaction: 'Phí thanh toán',
  fee_service: 'Phí dịch vụ',
  fee_optional: 'Phí tham gia chương trình',
  withholding_tax: 'Thuế sàn khấu trừ',
  customer_refund: 'Hoàn tiền người mua',
  return_fee: 'Phí hàng hoàn',
  lost_compensation: 'Bồi thường thất lạc',
  penalty: 'Phạt',
  cogs: 'Giá vốn',
  cogs_reversal: 'Hoàn giá vốn',
  ads: 'Quảng cáo',
  opex: 'Chi vận hành',
  supplier_payment: 'Trả nhà cung cấp',
  supplier_refund: 'Nhà cung cấp hoàn tiền',
  cod_collected: 'Thu COD tự giao',
  adjustment: 'Điều chỉnh',
  withdrawal: 'Rút tiền về ngân hàng',
};

/**
 * Cặp (Nợ, Có) theo vai trò khi số tiền **dương** (tiền vào); số âm thì đổi hai bên. Theo TT200 (Documents/25 §10.5):
 * khoản của sàn ghi qua phải thu sàn; phí, vận chuyển, quảng cáo vào chi phí bán hàng (vận chuyển người mua trả ghi giảm
 * chi phí đó); giá vốn đối ứng hàng hoá; khoản ngoài sàn qua ngân hàng, tiền mặt. TypeScript buộc xếp loại dòng mới ở đây.
 */
export const KIND_ACCOUNTS: Readonly<Record<LedgerKind, readonly [AccountRole, AccountRole]>> = {
  revenue: ['platformReceivable', 'revenue'],
  platform_subsidy: ['platformReceivable', 'revenue'],
  customer_refund: ['platformReceivable', 'revenue'],
  shipping_income: ['platformReceivable', 'sellingExpense'],
  shipping_cost: ['platformReceivable', 'sellingExpense'],
  fee_fixed: ['platformReceivable', 'sellingExpense'],
  fee_transaction: ['platformReceivable', 'sellingExpense'],
  fee_service: ['platformReceivable', 'sellingExpense'],
  fee_optional: ['platformReceivable', 'sellingExpense'],
  return_fee: ['platformReceivable', 'sellingExpense'],
  ads: ['platformReceivable', 'sellingExpense'],
  withholding_tax: ['platformReceivable', 'withheldTax'],
  lost_compensation: ['platformReceivable', 'otherIncome'],
  adjustment: ['platformReceivable', 'otherIncome'],
  penalty: ['platformReceivable', 'otherExpense'],
  withdrawal: ['platformReceivable', 'bank'],
  cogs: ['inventory', 'cogs'],
  cogs_reversal: ['inventory', 'cogs'],
  opex: ['bank', 'adminExpense'],
  supplier_payment: ['bank', 'supplierPayable'],
  supplier_refund: ['bank', 'supplierPayable'],
  cod_collected: ['cash', 'customerReceivable'],
};

/**
 * Dòng được xuất (Thành chốt 24/11/2026, A2): MISA chỉ thêm, không sửa chứng từ đã nhập, nên chỉ xuất dòng không bao giờ
 * đổi: dòng thực tế và giá vốn (lấy từ thẻ kho, không bị thay). Dòng ước tính, kể cả điều chỉnh hồi tố ước tính, sẽ bị
 * số quyết toán thay nên không xuất. Cùng luật lọc `actual` của `GET /ledger`.
 */
export const isExportable = (kind: LedgerKind, isEstimate: boolean) => !isEstimate || NON_CASH.has(kind);

/** Số chứng từ cố định theo id dòng sổ: xuất lại cùng kỳ ra cùng số, MISA từ chối số trùng nên không nhập hai lần. */
export const voucherNoOf = (lineId: string) => `CM${lineId.replace(/-/g, '').slice(0, 16).toUpperCase()}`;

/** Mã đối tượng của gian hàng: bản `account_map` khai thì dùng, không thì `<SÀN>-<mã gian hàng trên sàn>`. */
export function shopObjectCode(map: ConfigPayload<'account_map'>, shop: { id: string; platform: string; externalShopId: string }): string {
  return map.shopObjects?.[shop.id] ?? `${shop.platform.toUpperCase()}-${shop.externalShopId}`;
}

export interface ExportLine {
  id: string;
  kind: LedgerKind;
  /** Số có dấu, chuỗi thập phân (vào dương, ra âm). */
  amount: string;
  occurredOn: string;
  shopId: string | null;
  orderCode: string | null;
  externalOrderId: string | null;
  reason: string | null;
}

export interface ExportShop {
  name: string;
  objectCode: string;
}

export type MisaRow = Record<MisaColumn, string | number>;

/**
 * Một dòng sổ ra một chứng từ: một dòng hạch toán, riêng doanh thu, hoàn tiền người mua của doanh nghiệp tách thêm dòng
 * thuế GTGT đầu ra (giá bán đã gồm thuế, 25 §10.2). Số tiền trên tệp luôn dương; dấu quyết định bên Nợ/Có. Mã đối tượng
 * gắn bên phải thu sàn. `outputVatPct` là thuế suất áp ở ngày của dòng.
 */
export function voucherRows(
  line: ExportLine,
  map: ConfigPayload<'account_map'>,
  shop: ExportShop | null,
  outputVatPct: number,
): MisaRow[] {
  const amount = new Decimal(line.amount);
  const [inRole, outRole] = KIND_ACCOUNTS[line.kind];
  const [debitRole, creditRole] = amount.isNegative() ? [outRole, inRole] : [inRole, outRole];
  const vat = outputVatOf({ kind: line.kind, amount, outputVatPct }).abs();
  const description = [
    LEDGER_KIND_TEXT[line.kind],
    (line.orderCode ?? line.externalOrderId) && `đơn ${line.orderCode ?? line.externalOrderId}`,
    shop?.name,
    line.reason,
  ]
    .filter(Boolean)
    .join(' · ');
  const objectOf = (role: AccountRole) => (role === 'platformReceivable' && shop ? shop.objectCode : '');
  const row = (debit: AccountRole, credit: AccountRole, value: Decimal, lineDescription: string): MisaRow => ({
    postingDate: line.occurredOn,
    voucherDate: line.occurredOn,
    voucherNo: voucherNoOf(line.id),
    description,
    lineDescription,
    debitAccount: map.accounts[debit],
    creditAccount: map.accounts[credit],
    amount: value.toNumber(),
    debitObject: objectOf(debit),
    creditObject: objectOf(credit),
  });
  const rows = [row(debitRole, creditRole, amount.abs().minus(vat), LEDGER_KIND_TEXT[line.kind])];
  if (vat.isZero()) return rows;
  const [vatDebit, vatCredit]: [AccountRole, AccountRole] = amount.isNegative() ? ['outputVat', inRole] : [inRole, 'outputVat'];
  rows.push(row(vatDebit, vatCredit, vat, 'Thuế GTGT đầu ra'));
  return rows;
}
