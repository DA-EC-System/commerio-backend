import { z } from 'zod';

const DAY_MS = 86_400_000;

/**
 * Tham số ngày `yyyy-mm-dd` (tuỳ chọn) → đầu ngày đó theo giờ Việt Nam; `nextDay` cho cận trên `to` → đầu ngày hôm sau,
 * để lọc `[from, to)` trọn ngày (Documents/21 C6).
 */
export const vnDayParam = (label: string, nextDay = false) =>
  z.iso
    .date(`${label} dạng yyyy-mm-dd`)
    .transform((d) => new Date(Date.parse(`${d}T00:00:00+07:00`) + (nextDay ? DAY_MS : 0)))
    .optional()
    .meta({ description: 'Trọn ngày theo giờ Việt Nam (C6)' });
