// Ngày theo giờ Việt Nam trong SQL (báo cáo, lọc theo ngày): cột `timestamptz`, ngày dạng `yyyy-mm-dd`.
import { type SQL, sql } from 'drizzle-orm';

/** `col` nằm trong [from 00:00, to + 1 ngày 00:00) giờ VN; so trên cột trần để dùng được index. */
export const inVnDays = (col: SQL, from: string, to: string): SQL =>
  sql`${col} >= (${from}::date::timestamp at time zone 'Asia/Ho_Chi_Minh')
    and ${col} < ((${to}::date + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')`;

/** Ngày VN (`yyyy-mm-dd`) của một thời điểm. */
export const vnDayOf = (col: SQL): SQL => sql`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
