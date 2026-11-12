-- RLS cho bảng mới `channel.remote_skus` (vòng lặp của 0002 chỉ chạy một lần; #220 đợt 2).
ALTER TABLE channel.remote_skus ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.remote_skus
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
