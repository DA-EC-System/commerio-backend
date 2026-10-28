-- RLS cho bảng mới `channel.category_maps` (vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE channel.category_maps ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.category_maps
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
