-- RLS, quyền và chống trùng theo ngưỡng lệch hạn cho bảng mới `channel.shop_reauth_mails` (#312; vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE channel.shop_reauth_mails ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.shop_reauth_mails
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Mốc thư không sửa, không xoá: sửa hay xoá dòng thì cùng một mốc gửi lại được. Chỉ cập nhật được kết quả gửi.
REVOKE UPDATE, DELETE ON channel.shop_reauth_mails FROM commerio_app;--> statement-breakpoint
GRANT UPDATE (outcome, finished_at, attempts, queued_at) ON channel.shop_reauth_mails TO commerio_app;--> statement-breakpoint
-- Khoảng ±30 phút quanh hạn. Trừ, cộng một khoảng chỉ có phút không phụ thuộc múi giờ (khác khoảng có ngày, tháng) nên
-- hàm thật sự IMMUTABLE, dùng được trong ràng buộc EXCLUDE.
CREATE FUNCTION channel.reauth_deadline_window(deadline timestamptz) RETURNS tstzrange
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN tstzrange(deadline - interval '30 minutes', deadline + interval '30 minutes');--> statement-breakpoint
-- Hai thư trước hạn cùng gian hàng, cùng mốc mà hạn cách nhau dưới 1 giờ là một mốc: hạn tính lại sau mỗi lần làm mới
-- token (Lazada `refresh_expires_in` là số giây còn lại) lệch vài mili giây tới vài giây. Thư `lost` dùng lúc chuyển
-- trạng thái ghi ở DB, không lệch, đã có unique.
ALTER TABLE channel.shop_reauth_mails ADD CONSTRAINT shop_reauth_mails_deadline_drift
  EXCLUDE USING gist (shop_id WITH =, stage WITH =, channel.reauth_deadline_window(deadline) WITH &&)
  WHERE (stage <> 'lost');
