// Ngày theo giờ Việt Nam (UTC+7, không có giờ mùa hè; Documents/21 C6), dạng `YYYY-MM-DD`. Thuần, không I/O.

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ngày giờ VN của một thời điểm. */
export function vnDay(at: string | Date): string {
  return new Date(new Date(at).getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Số ngày từ `from` tới `to`, tính cả hai đầu. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Sự kiện của module nguồn mà báo cáo nghe (plan #29 A5): chỉ phần payload cần để biết ngày phải tính lại. */
export type SourceEvent =
  | { type: 'finance.invoice_posted'; payload: { issuedAt: string } }
  | { type: 'finance.receipt_posted'; payload: { postedAt: string } }
  | { type: 'finance.voucher_posted'; payload: { paidOn: string } };

/** Ngày bị đổi số bởi sự kiện: ngày của chứng từ (A1). */
export function dayOfSourceEvent(event: SourceEvent): string {
  switch (event.type) {
    case 'finance.invoice_posted':
      return vnDay(event.payload.issuedAt);
    case 'finance.receipt_posted':
      return vnDay(event.payload.postedAt);
    case 'finance.voucher_posted':
      return event.payload.paidOn;
  }
}
