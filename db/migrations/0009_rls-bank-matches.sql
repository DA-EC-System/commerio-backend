-- RLS cho bảng mới `finance.bank_matches` (#117; vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE finance.bank_matches ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON finance.bank_matches
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
