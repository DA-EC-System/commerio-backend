// Ngày giờ dạng người Việt đọc, cho chuỗi lưu lại (nhãn nhật ký thao tác, #352).

const shortDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Mốc giờ → `dd/MM HH:mm` giờ Việt Nam. */
export function vnShortDateTime(at: Date): string {
  const p = Object.fromEntries(shortDateTime.formatToParts(at).map(({ type, value }) => [type, value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** Ngày `yyyy-mm-dd` (cột `date`) → `dd/MM/yyyy`. Đổi chuỗi trực tiếp, không qua múi giờ. */
export function vnDateText(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}
