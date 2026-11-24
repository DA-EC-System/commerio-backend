-- RLS cho bảng mới `channel.listing_sync_runs` (kết quả lượt đồng bộ do người bấm, Documents/21 §18; vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE channel.listing_sync_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.listing_sync_runs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
