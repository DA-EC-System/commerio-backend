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

/** Mọi ngày từ `from` tới `to`, cả hai đầu. */
export function eachDay(from: string, to: string): string[] {
  return Array.from({ length: daysBetween(from, to) }, (_, i) => addDays(from, i));
}

/** Số ngày từ `from` tới `to`, tính cả hai đầu. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}
