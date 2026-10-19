import { z } from 'zod';

const UUID = z.uuid();

/** Id không phải uuid thì PostgreSQL ném 22P02: kiểm trước khi truy vấn, sai dạng thì coi như không có (V6). */
export const isUuid = (id: string): boolean => UUID.safeParse(id).success;
