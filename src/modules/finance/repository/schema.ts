import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `finance` khai báo trong schema này.
export const financeSchema = pgSchema('finance');
