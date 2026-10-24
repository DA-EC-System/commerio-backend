-- RLS cho staff.invitations (0018, #7 [C]): chỉ thấy lời mời của công ty đang chọn, cùng mẫu với 0003. Ghi rõ
-- WITH CHECK để không chèn hay chuyển lời mời sang công ty khác. Lời mời không xoá, chỉ đổi trạng thái, nên
-- commerio_app không có DELETE (SELECT, INSERT, UPDATE đến từ ALTER DEFAULT PRIVILEGES của 0003).
-- Luồng công khai /join/* mở withCompany theo `cid` trong token link trước khi đọc dòng.
ALTER TABLE staff.invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON staff.invitations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON staff.invitations FROM commerio_app;
