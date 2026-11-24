// Xuất sổ tiền cho MISA AMIS Kế toán (#232; Documents/21 §21.1, US-TI-15). Đọc dòng sổ đã chốt trong kỳ, đổi thành
// chứng từ nghiệp vụ khác theo bản `account_map` đang áp, ghi một tệp .xlsx (sheet chứng từ, sheet danh mục đối tượng).
import ExcelJS from 'exceljs';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { addDays, outputVatPctOf } from '../domain/config-version.ts';
import { MISA_NVK_COLUMNS, MISA_OBJECT_COLUMNS, type ExportShop, type MisaColumn, shopObjectCode, voucherRows } from '../domain/misa-export.ts';
import { exportEntries } from '../repository/ledger.ts';
import { getEffectiveConfig } from './config-versions.ts';
import type { FinanceContext } from './settlement-views.ts';
import { ordersOf } from './views.ts';

/** Trần dòng sổ mỗi lần xuất: vượt thì 422, người dùng chia kỳ nhỏ hơn (L019: chặn trong SQL, không đọc hết rồi đếm). */
export const EXPORT_ROW_CAP = 50_000;

export interface ExportRange {
  /** Ngày đầu kỳ, `yyyy-mm-dd`, gồm. */
  from: string;
  /** Ngày cuối kỳ, gồm. */
  to: string;
}

/** Tệp .xlsx của kỳ; lỗi nghiệp vụ ném `AppError` trước khi dựng tệp. Người không xem được giá vốn nhận tệp không có dòng giá vốn (R4). */
export async function exportLedgerForMisa(ctx: FinanceContext, companyId: string, range: ExportRange, canSeeCost: boolean): Promise<Buffer> {
  const sheets = await withCompany(companyId, async () => {
    const regime = await getEffectiveConfig('tax_regime', null, range.to);
    if (regime?.payload.regime !== 'company')
      throw new AppError(
        409,
        'export_not_supported',
        'Xuất sổ cho MISA chỉ dành cho doanh nghiệp (ghi sổ kép). Kiểm tra Loại hình kinh doanh ở Cấu hình tiền.',
      );
    const map = await getEffectiveConfig('account_map', null, range.to);
    if (!map)
      throw new AppError(409, 'account_map_missing', 'Chưa có bản Tài khoản kế toán đang áp dụng. Khai số hiệu tài khoản ở Cấu hình tiền rồi xuất lại.');

    const lines = await exportEntries(range.from, addDays(range.to, 1), EXPORT_ROW_CAP + 1, !canSeeCost);
    if (lines.length > EXPORT_ROW_CAP)
      throw new AppError(422, 'export_too_large', `Kỳ này có hơn ${EXPORT_ROW_CAP.toLocaleString('vi-VN')} dòng sổ. Chọn kỳ ngắn hơn rồi xuất lại.`);

    const shopIds = [...new Set(lines.map((l) => l.shopId).filter((id): id is string => !!id))];
    const [shops, orders] = await Promise.all([
      ctx.shopsOf ? ctx.shopsOf(shopIds) : Promise.resolve(new Map()),
      ordersOf(lines.map((l) => l.orderId)),
    ]);
    const exportShops = new Map<string, ExportShop>();
    for (const id of shopIds) {
      const s = shops.get(id);
      // Gian hàng đã xoá vẫn có dòng sổ cũ: dùng mã khai riêng nếu có, không thì mã theo id.
      const objectCode = s?.externalShopId ? shopObjectCode(map.payload, { id, platform: s.platform, externalShopId: s.externalShopId }) : (map.payload.shopObjects?.[id] ?? `SHOP-${id.slice(0, 8)}`);
      exportShops.set(id, { name: s?.shopName ?? objectCode, objectCode });
    }

    // Thuế suất GTGT đầu ra theo ngày của dòng (25 §10.2): mỗi ngày đọc một lần.
    const vatByDay = new Map<string, Promise<number>>();
    const vatPctOn = (day: string) => {
      if (!vatByDay.has(day))
        vatByDay.set(
          day,
          Promise.all([getEffectiveConfig('tax_regime', null, day), getEffectiveConfig('tax_rules', null, day)]).then(([r, t]) =>
            outputVatPctOf(r?.payload, t?.payload),
          ),
        );
      return vatByDay.get(day)!;
    };

    const vouchers = [];
    for (const l of lines) {
      vouchers.push(
        ...voucherRows(
          {
            id: l.id,
            kind: l.kind,
            amount: l.amount,
            occurredOn: l.occurredOn,
            shopId: l.shopId,
            orderCode: l.orderId ? (orders.get(l.orderId)?.code ?? null) : null,
            externalOrderId: l.externalOrderId,
            reason: l.reason,
          },
          map.payload,
          l.shopId ? exportShops.get(l.shopId)! : null,
          await vatPctOn(l.occurredOn),
        ),
      );
    }
    return { vouchers, objects: [...exportShops.values()] };
  });
  return writeWorkbook(sheets.vouchers, sheets.objects);
}

async function writeWorkbook(vouchers: Record<MisaColumn, string | number>[], objects: ExportShop[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const keys = Object.keys(MISA_NVK_COLUMNS) as MisaColumn[];
  const sheet = book.addWorksheet('Chứng từ nghiệp vụ khác');
  sheet.columns = keys.map((k) => ({ header: MISA_NVK_COLUMNS[k], key: k, width: k === 'description' ? 48 : 18 }));
  // Ngày ghi dạng ngày của Excel (MISA kiểm kiểu ô), tiền là số; chuỗi ghi nguyên văn, ExcelJS không biến thành công thức.
  for (const v of vouchers)
    sheet.addRow({ ...v, postingDate: excelDate(v.postingDate as string), voucherDate: excelDate(v.voucherDate as string) });
  for (const k of ['postingDate', 'voucherDate'] as const) sheet.getColumn(k).numFmt = 'dd/mm/yyyy';
  sheet.getColumn('amount').numFmt = '#,##0.##';

  const catalog = book.addWorksheet('Danh mục đối tượng');
  catalog.columns = [
    { header: MISA_OBJECT_COLUMNS.code, key: 'code', width: 24 },
    { header: MISA_OBJECT_COLUMNS.name, key: 'name', width: 40 },
  ];
  for (const o of objects) catalog.addRow({ code: o.objectCode, name: o.name });
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** `yyyy-mm-dd` thành ngày UTC 0 giờ: Excel không có múi giờ, ô hiện đúng ngày của dòng sổ. */
const excelDate = (day: string) => new Date(`${day}T00:00:00Z`);
