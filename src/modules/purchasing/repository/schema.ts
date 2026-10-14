import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `purchasing` khai báo trong schema này.
export const purchasingSchema = pgSchema('purchasing');
