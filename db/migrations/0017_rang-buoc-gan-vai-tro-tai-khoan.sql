-- #62: DB tự chặn ghi chéo công ty thay vì chỉ dựa vào service.
--
-- 1. access.member_roles: vai trò phải là vai trò có sẵn (company_id trống) hoặc của cùng công ty với dòng, và
--    membership phải thuộc cùng công ty. Khoá ngoại ghép không làm được vì vai trò có sẵn có company_id trống, nên
--    dùng trigger; áp cho mọi role, kể cả chủ bảng (luồng đăng ký, worker). Hàm chạy bằng quyền người gọi: dưới
--    commerio_app, RLS giấu vai trò và membership của công ty khác nên chúng cũng bị coi là không hợp lệ.
--    Lỗi mang mã foreign_key_violation và tên member_roles_company_fk để service đọc bằng pgError().
--    Trigger đọc staff.memberships (schema khác): đây là ràng buộc DB tương đương khoá ngoại, code vẫn theo luật ranh giới.
CREATE FUNCTION access.check_member_role_company() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM access.roles r
    WHERE r.id = NEW.role_id AND (r.company_id IS NULL OR r.company_id = NEW.company_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM staff.memberships m
    WHERE m.id = NEW.membership_id AND m.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Vai trò hoặc thành viên không thuộc công ty của dòng member_roles'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'member_roles_company_fk', TABLE = 'member_roles',
        SCHEMA = 'access';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_roles_company_fk
  BEFORE INSERT OR UPDATE OF membership_id, role_id, company_id ON access.member_roles
  FOR EACH ROW EXECUTE FUNCTION access.check_member_role_company();
--> statement-breakpoint
-- 2. staff.accounts dùng chung mọi công ty, không có RLS: request trong công ty (commerio_app) chỉ đọc và tạo
--    (mời nhân viên), không sửa, không xoá. Đổi mật khẩu, liên kết Google chạy bằng role chủ bảng.
REVOKE UPDATE, DELETE ON staff.accounts FROM commerio_app;
