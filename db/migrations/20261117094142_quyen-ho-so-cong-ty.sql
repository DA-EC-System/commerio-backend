-- Quyền xem, sửa hồ sơ công ty (#292), chỉ vai trò có sẵn CEO và Admin mang. Khớp access/domain/catalog.ts.
INSERT INTO "core"."permissions" ("code", "module_code", "description") VALUES
  ('platform.company.manage', 'platform', 'Xem, sửa hồ sơ công ty');
--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_code") VALUES
  ('00000000-0000-4000-8000-000000000001', 'platform.company.manage'),
  ('00000000-0000-4000-8000-000000000002', 'platform.company.manage');
