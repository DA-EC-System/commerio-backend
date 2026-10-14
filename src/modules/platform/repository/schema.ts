import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `platform` khai báo trong schema này.
export const platformSchema = pgSchema('platform');
