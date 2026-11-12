-- Quyền riêng để ghép SKU sàn với biến thể (#220, Documents/21 §18.6.5, Thành chốt 05/11/2026): CEO, Admin, Sale.
-- `channel.listing.manage` chỉ còn đẩy, gỡ, đổi giá. Khớp access/domain/catalog.ts.
INSERT INTO "core"."permissions" ("code", "module_code", "description") VALUES
  ('channel.listing.match', 'channel', 'Ghép SKU sàn với biến thể');
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Đẩy sản phẩm và giá lên sàn' WHERE "code" = 'channel.listing.manage';
--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_code") VALUES
  ('00000000-0000-4000-8000-000000000001', 'channel.listing.match'),
  ('00000000-0000-4000-8000-000000000002', 'channel.listing.match'),
  ('00000000-0000-4000-8000-000000000003', 'channel.listing.match');
--> statement-breakpoint
-- Vai trò tuỳ biến đang có `channel.listing.manage` (trước đây gồm cả ghép) giữ được việc ghép.
INSERT INTO "core"."role_permissions" ("role_id", "permission_code")
SELECT rp."role_id", 'channel.listing.match'
  FROM "core"."role_permissions" rp
  JOIN "core"."roles" r ON r."id" = rp."role_id"
 WHERE rp."permission_code" = 'channel.listing.manage' AND r."kind" = 'custom'
ON CONFLICT DO NOTHING;
