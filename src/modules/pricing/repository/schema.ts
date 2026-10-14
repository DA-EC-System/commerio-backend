import { pgSchema } from 'drizzle-orm/pg-core';

// Mọi bảng của module `pricing` khai báo trong schema này.
export const pricingSchema = pgSchema('pricing');
