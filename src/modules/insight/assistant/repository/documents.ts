import { sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { documents } from './schema.ts';

/** Công ty đang chọn đã tải tài liệu nội bộ chưa: có thì không tắt được phân hệ Trợ lý AI (#152). */
export async function hasAssistantData(): Promise<boolean> {
  const [row] = await getDb().select({ one: sql`1` }).from(documents).limit(1);
  return !!row;
}
