import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `audit` khai báo trong schema này.
export const auditSchema = pgSchema('audit');
