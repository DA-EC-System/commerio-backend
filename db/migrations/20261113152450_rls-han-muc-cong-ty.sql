-- RLS cho `channel.api_usage` vừa có `company_id` (#215; vòng lặp của 0002 chỉ chạy một lần). Bộ đếm chỉ đọc ghi bằng
-- role chủ bảng ngoài `withCompany` (`repository/api-usage.ts`); trong công ty chỉ thấy dòng của mình, không thấy dòng
-- tổng của app (`company_id` trống).
ALTER TABLE channel.api_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.api_usage
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
