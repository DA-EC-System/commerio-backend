// Tệp CSV của báo cáo (Documents/21 §12.7; plan #29 A9): UTF-8 có BOM để Excel đọc đúng tiếng Việt, CRLF. Thuần.
import type { ReportFigures } from './figures.ts';
import type { OrderSource } from './summary.ts';

type Cell = string | number | null;

/**
 * Một ô: bọc ngoặc kép khi có `,` `"` hay xuống dòng. Ô chữ bắt đầu bằng `= + - @` thêm dấu nháy để Excel không chạy
 * như công thức (tên gian hàng đến từ sàn, không tin được).
 */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: readonly (readonly Cell[])[]): Buffer {
  return Buffer.from(`\uFEFF${rows.map((r) => `${r.map(csvCell).join(',')}\r\n`).join('')}`, 'utf8');
}

const SOURCE_LABEL: Record<OrderSource, string> = { marketplace: 'Sàn', inbox: 'Hộp thư', manual: 'Đơn tạo tay' };

/** Cột số theo `ReportFigures`; thiếu quyền giá vốn thì không có cột Giá vốn, Lãi (D18). */
function figureColumns(canCost: boolean): [string, (f: ReportFigures) => Cell][] {
  return [
    ['Doanh thu', (f) => f.revenue],
    ['Tiền đã thu', (f) => f.cashCollected],
    ['Phí sàn', (f) => f.platformFee],
    ['Phí cổng', (f) => f.paymentFee],
    ['Phí vận chuyển', (f) => f.shippingFee],
    ...(canCost
      ? ([
          ['Giá vốn', (f) => f.cogs],
          ['Lãi', (f) => f.profit],
        ] as [string, (f: ReportFigures) => Cell][])
      : []),
    ['Phí sàn chờ đối soát', (f) => (f.feesPending ? 'có' : 'không')],
  ];
}

/** Bảng CSV có các cột đầu cho trước (`lead`) rồi tới cột số. */
export function figuresCsv<T extends ReportFigures>(
  lead: [string, (row: T) => Cell][],
  rows: readonly T[],
  canCost: boolean,
): Buffer {
  const columns = [...lead, ...figureColumns(canCost)] as [string, (row: T) => Cell][];
  return toCsv([columns.map(([label]) => label), ...rows.map((row) => columns.map(([, cell]) => cell(row)))]);
}

export const sourceLabel = (source: OrderSource | 'total') => (source === 'total' ? 'Tổng' : SOURCE_LABEL[source]);
