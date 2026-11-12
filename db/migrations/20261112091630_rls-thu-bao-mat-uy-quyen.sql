-- RLS cho bảng mới `channel.shop_reauth_mails` (#312; vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE channel.shop_reauth_mails ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.shop_reauth_mails
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Thư đã xếp chỉ thêm: sửa hay xoá dòng sẽ mở đường gửi lại cùng một mốc.
REVOKE UPDATE, DELETE ON channel.shop_reauth_mails FROM commerio_app;
