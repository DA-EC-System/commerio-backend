-- Quyền xem và chạy lại việc nền lỗi (#102 A6), chỉ vai trò có sẵn CEO và Admin mang. Khớp access/domain/catalog.ts.
INSERT INTO "core"."permissions" ("code", "module_code", "description") VALUES
  ('platform.job.manage', 'platform', 'Xem, chạy lại việc nền lỗi');
--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_code") VALUES
  ('00000000-0000-4000-8000-000000000001', 'platform.job.manage'),
  ('00000000-0000-4000-8000-000000000002', 'platform.job.manage');
