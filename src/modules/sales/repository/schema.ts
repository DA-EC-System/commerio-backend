import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `sales` khai báo trong schema này.
export const salesSchema = pgSchema('sales');
