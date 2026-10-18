-- Cô lập dữ liệu giữa các công ty bằng Row-Level Security (docs/17 mục 3, KT-01).
--
-- Hai cách chạy truy vấn:
--   * Request trong một công ty: mở transaction, `SET LOCAL ROLE commerio_app` và
--     `set_config('app.company_id', <id>, true)`. Role này không phải chủ bảng nên RLS có hiệu lực.
--   * Luồng không thuộc công ty nào (đăng ký, đăng nhập, chọn công ty, quản trị nền tảng, worker):
--     chạy bằng role đăng nhập, là chủ bảng nên bỏ qua RLS. Không bật FORCE ROW LEVEL SECURITY.
DO $$ BEGIN
  CREATE ROLE commerio_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
GRANT commerio_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA access, assistant, audit, catalog, channel, files, finance, fulfillment, identity, inbox,
  inventory, payment, platform, pricing, purchasing, report, sales, staff TO commerio_app;
--> statement-breakpoint
-- Bảng của module sau này tạo bằng cùng role migration nên tự được cấp quyền.
ALTER DEFAULT PRIVILEGES IN SCHEMA access, assistant, audit, catalog, channel, files, finance, fulfillment, identity,
  inbox, inventory, payment, platform, pricing, purchasing, report, sales, staff
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commerio_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA access, assistant, audit, catalog, channel, files, finance, fulfillment, identity,
  inbox, inventory, payment, platform, pricing, purchasing, report, sales, staff
  GRANT USAGE, SELECT ON SEQUENCES TO commerio_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA access, audit, files, platform, staff TO commerio_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO commerio_app;
--> statement-breakpoint
-- Bảng chung: trong công ty chỉ đọc. Refresh token chỉ luồng xác thực đụng tới.
REVOKE INSERT, UPDATE, DELETE ON platform.companies, access.permissions FROM commerio_app;
--> statement-breakpoint
REVOKE ALL ON identity.refresh_tokens FROM commerio_app;
--> statement-breakpoint
-- Nhật ký chỉ thêm, không sửa, không xoá.
REVOKE UPDATE, DELETE ON audit.audit_logs FROM commerio_app;
--> statement-breakpoint
ALTER TABLE platform.company_modules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON platform.company_modules
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE staff.memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON staff.memberships
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- Vai trò có sẵn (company_id trống) ai cũng đọc được, nhưng không sửa được trong công ty.
ALTER TABLE access.roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON access.roles
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- Quyền của vai trò đi theo vai trò: thấy vai trò nào thì thấy quyền của vai trò đó.
ALTER TABLE access.role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON access.role_permissions
  USING (EXISTS (SELECT 1 FROM access.roles r WHERE r.id = role_id))
  WITH CHECK (EXISTS (
    SELECT 1 FROM access.roles r
    WHERE r.id = role_id AND r.company_id = nullif(current_setting('app.company_id', true), '')::uuid
  ));
--> statement-breakpoint
ALTER TABLE access.member_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON access.member_roles
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- Nhật ký cấp nền tảng và cấp tài khoản (company_id trống) không hiện trong công ty nào.
ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON audit.audit_logs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE files.files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON files.files
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
