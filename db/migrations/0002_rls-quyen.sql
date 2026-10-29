-- Cô lập dữ liệu giữa các công ty bằng Row-Level Security, quyền của role ứng dụng, và các ràng buộc Drizzle không
-- sinh được. Gộp từ các migration RLS cũ (0003, 0005, 0007, 0010, 0011, 0014, 0017, 0019) khi dựng lại DB theo 6
-- module lớn (Documents/19, 28/10/2026).
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
GRANT USAGE ON SCHEMA core, product, "order", finance, channel, insight TO commerio_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, product, "order", finance, channel, insight
  TO commerio_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, product, "order", finance, channel, insight TO commerio_app;
--> statement-breakpoint
-- Bảng thêm bằng migration sau tạo bằng cùng role migration nên tự được cấp quyền.
ALTER DEFAULT PRIVILEGES IN SCHEMA core, product, "order", finance, channel, insight
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commerio_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA core, product, "order", finance, channel, insight
  GRANT USAGE, SELECT ON SEQUENCES TO commerio_app;
--> statement-breakpoint
-- Mọi bảng có `company_id` chỉ thấy dòng của công ty đang chọn, trừ hai bảng xử lý riêng bên dưới:
-- `core.refresh_tokens` (chỉ luồng xác thực đụng tới) và `core.roles` (vai trò có sẵn có company_id trống).
-- Bảng thêm bằng migration sau phải tự bật RLS; test rls-coverage quét để không sót.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_schema AS s, c.table_name AS n
    FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.column_name = 'company_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_schema IN ('core', 'product', 'order', 'finance', 'channel', 'insight')
      AND (c.table_schema, c.table_name) NOT IN (('core', 'refresh_tokens'), ('core', 'roles'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.s, t.n);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I.%I '
      'USING (company_id = nullif(current_setting(''app.company_id'', true), '''')::uuid) '
      'WITH CHECK (company_id = nullif(current_setting(''app.company_id'', true), '''')::uuid)',
      t.s, t.n);
  END LOOP;
END $$;
--> statement-breakpoint
-- Vai trò có sẵn (company_id trống) ai cũng đọc được; thêm, sửa, xoá chỉ vai trò của công ty đang chọn.
ALTER TABLE core.roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON core.roles
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY own_company_write ON core.roles AS RESTRICTIVE FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY own_company_delete ON core.roles AS RESTRICTIVE FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- Quyền của vai trò đi theo vai trò: thấy vai trò nào thì thấy quyền của vai trò đó; chỉ ghi quyền của vai trò
-- thuộc công ty đang chọn (không xoá, chuyển quyền của vai trò có sẵn).
ALTER TABLE core.role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON core.role_permissions
  USING (EXISTS (SELECT 1 FROM core.roles r WHERE r.id = role_id))
  WITH CHECK (EXISTS (
    SELECT 1 FROM core.roles r
    WHERE r.id = role_id AND r.company_id = nullif(current_setting('app.company_id', true), '')::uuid
  ));
--> statement-breakpoint
CREATE POLICY own_company_write ON core.role_permissions AS RESTRICTIVE FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM core.roles r
    WHERE r.id = role_id AND r.company_id = nullif(current_setting('app.company_id', true), '')::uuid
  ));
--> statement-breakpoint
CREATE POLICY own_company_delete ON core.role_permissions AS RESTRICTIVE FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM core.roles r
    WHERE r.id = role_id AND r.company_id = nullif(current_setting('app.company_id', true), '')::uuid
  ));
--> statement-breakpoint
-- Tên vai trò không phân biệt hoa thường trong một công ty (Documents/21 D3). Vai trò có sẵn có company_id trống
-- nên cần NULLS NOT DISTINCT; Drizzle không sinh được index biểu thức kèm điều này nên không khai trong schema.ts.
CREATE UNIQUE INDEX roles_company_lower_name_uq ON core.roles (company_id, lower(name)) NULLS NOT DISTINCT;
--> statement-breakpoint
-- Bảng chung: trong công ty chỉ đọc. Refresh token chỉ luồng xác thực đụng tới.
REVOKE INSERT, UPDATE, DELETE ON core.companies, core.permissions FROM commerio_app;
--> statement-breakpoint
REVOKE ALL ON core.refresh_tokens FROM commerio_app;
--> statement-breakpoint
-- Tài khoản dùng chung mọi công ty, không RLS: trong công ty chỉ đọc và tạo (mời nhân viên), không sửa, không xoá (#62).
REVOKE UPDATE, DELETE ON core.accounts FROM commerio_app;
--> statement-breakpoint
-- Lời mời không xoá, chỉ đổi trạng thái (#7 [C]).
REVOKE DELETE ON core.invitations FROM commerio_app;
--> statement-breakpoint
-- Outbox: trong công ty chỉ ghi thêm (publishEvent); relay của worker đọc và đánh dấu bằng role chủ bảng (D5, V40).
REVOKE SELECT, UPDATE, DELETE ON core.outbox_messages FROM commerio_app;
--> statement-breakpoint
-- Bảng chỉ thêm (N2, N3, N4, T1): nhật ký, khoá chống xử lý trùng của consumer, lịch sử trạng thái, thẻ kho, sổ tiền.
REVOKE UPDATE, DELETE ON core.audit_logs, core.processed_events, core.state_transitions, product.stock_moves,
  finance.ledger_entries FROM commerio_app;
--> statement-breakpoint
-- core.member_roles: vai trò phải là vai trò có sẵn hoặc của cùng công ty, membership phải cùng công ty (#62).
-- Khoá ngoại ghép không làm được vì vai trò có sẵn có company_id trống, nên dùng trigger; áp cho mọi role, kể cả chủ
-- bảng. Hàm chạy bằng quyền người gọi: dưới commerio_app, RLS giấu vai trò và membership của công ty khác.
-- Lỗi mang mã foreign_key_violation và tên member_roles_company_fk để service đọc bằng pgError().
CREATE FUNCTION core.check_member_role_company() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.roles r
    WHERE r.id = NEW.role_id AND (r.company_id IS NULL OR r.company_id = NEW.company_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM core.memberships m
    WHERE m.id = NEW.membership_id AND m.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Vai trò hoặc thành viên không thuộc công ty của dòng member_roles'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'member_roles_company_fk', TABLE = 'member_roles',
        SCHEMA = 'core';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_roles_company_fk
  BEFORE INSERT OR UPDATE OF membership_id, role_id, company_id ON core.member_roles
  FOR EACH ROW EXECUTE FUNCTION core.check_member_role_company();
--> statement-breakpoint
-- Không có hai phiên bản cấu hình cùng có hiệu lực chồng ngày cho cùng (công ty, loại, gian hàng) (D4.4).
-- `effective_to` trống là chưa có ngày hết: duyệt bản mới thì service đặt `effective_to` của bản đang áp dụng về ngày
-- trước ngày hiệu lực mới, trong cùng giao dịch. Gian hàng trống (cấu hình cấp công ty) so như một giá trị.
ALTER TABLE finance.config_versions ADD CONSTRAINT config_versions_no_overlap EXCLUDE USING gist (
  company_id WITH =,
  kind WITH =,
  (coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(effective_from, effective_to, '[]') WITH &&
) WHERE (status IN ('scheduled', 'active'));
