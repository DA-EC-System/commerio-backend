-- Ánh xạ trục phân loại sang sales attribute của sàn (#448, Documents/19 §3.3): RLS company_isolation cho channel.axis_mappings (vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE channel.axis_mappings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.axis_mappings
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
