// Tệp CSV của báo cáo (Documents/21 §12.7; plan #29 A9): UTF-8 có BOM để Excel đọc đúng tiếng Việt, CRLF. Thuần.
import type { ReportFigures } from './figures.ts';
import type { OrderSource } from './summary.ts';

type Cell = string | number | null;
export type Column<T> = [label: string, cell: (row: T) => Cell];

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

const COST_COLUMNS: Column<ReportFigures>[] = [
  ['Giá vốn', (f) => f.cogs],
  ['Lãi', (f) => f.profit],
];

/** Cột số theo `ReportFigures`; thiếu quyền giá vốn thì không có cột Giá vốn, Lãi (D18). */
function figureColumns(canCost: boolean): Column<ReportFigures>[] {
  return [
    ['Doanh thu', (f) => f.revenue],
    ['Tiền đã thu', (f) => f.cashCollected],
    ['Phí sàn', (f) => f.platformFee],
    ['Phí cổng', (f) => f.paymentFee],
    ['Phí vận chuyển', (f) => f.shippingFee],
    ...(canCost ? COST_COLUMNS : []),
    ['Phí sàn chờ đối soát', (f) => (f.feesPending ? 'có' : 'không')],
  ];
}

/**
 * Bảng CSV: các cột đầu cho trước (`lead`) rồi tới cột số. `total` thêm dòng cuối: nhãn ở cột đầu, các cột đầu khác
 * để trống.
 */
export function figuresCsv<T extends ReportFigures>(
  lead: Column<T>[],
  rows: readonly T[],
  canCost: boolean,
  total?: { label: string; figures: ReportFigures },
): Buffer {
  const figures = figureColumns(canCost);
  const body = rows.map((row) => [...lead.map(([, cell]) => cell(row)), ...figures.map(([, cell]) => cell(row))]);
  const footer = total
    ? [[total.label, ...lead.slice(1).map(() => null), ...figures.map(([, cell]) => cell(total.figures))]]
    : [];
  return toCsv([[...lead, ...figures].map(([label]) => label), ...body, ...footer]);
}

export const sourceLabel = (source: OrderSource) => SOURCE_LABEL[source];
