-- Vai trò có sẵn (company_id trống) dùng chung mọi công ty: request trong một công ty đọc được nhưng không được sửa,
-- xoá nó hay quyền của nó (backend#8 P11). Policy company_isolation của 0003 chỉ có USING cho DELETE và cho dòng cũ
-- của UPDATE, nên trước migration này một công ty xoá được vai trò có sẵn, xoá hoặc chuyển quyền của nó, và
-- UPDATE company_id nhận vai trò có sẵn về mình. Thêm policy RESTRICTIVE (AND với policy cũ) cho UPDATE, DELETE:
-- chỉ dòng của công ty đang chọn; đọc và INSERT giữ nguyên.
CREATE POLICY own_company_write ON access.roles AS RESTRICTIVE FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY own_company_delete ON access.roles AS RESTRICTIVE FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY own_company_write ON access.role_permissions AS RESTRICTIVE FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM access.roles r
    WHERE r.id = role_id AND r.company_id = nullif(current_setting('app.company_id', true), '')::uuid
  ));
--> statement-breakpoint
CREATE POLICY own_company_delete ON access.role_permissions AS RESTRICTIVE FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM access.roles r
    WHERE r.id = role_id AND r.company_id = nullif(current_setting('app.company_id', true), '')::uuid
  ));
