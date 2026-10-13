import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `catalog` khai báo trong schema này.
export const catalogSchema = pgSchema('catalog');
