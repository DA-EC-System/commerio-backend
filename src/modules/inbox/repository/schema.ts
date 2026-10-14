import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `inbox` khai báo trong schema này.
export const inboxSchema = pgSchema('inbox');
