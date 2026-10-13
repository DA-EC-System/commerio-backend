import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `auth` khai báo trong schema này.
export const authSchema = pgSchema('auth');
