import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `identity` khai báo trong schema này.
// Không đặt tên `auth`: Supabase đã có sẵn schema `auth` cho hệ thống đăng nhập của nó.
export const identitySchema = pgSchema('identity');
