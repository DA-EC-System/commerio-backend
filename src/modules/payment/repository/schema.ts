import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `payment` khai báo trong schema này.
export const paymentSchema = pgSchema('payment');
