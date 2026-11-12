-- RLS cho bảng mới `order.unmatched_return_parcel_lines` (#202; vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE "order".unmatched_return_parcel_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON "order".unmatched_return_parcel_lines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
