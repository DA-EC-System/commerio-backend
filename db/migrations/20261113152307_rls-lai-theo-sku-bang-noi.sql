-- RLS và quyền cho hai bảng mới của finance (#231; vòng lặp của 0002 chỉ chạy một lần).
-- `ledger_replacements`: cặp dòng thực tế thay dòng ước tính; `ledger_package_lines`: dòng hàng của kiện đã giao.
ALTER TABLE finance.ledger_replacements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON finance.ledger_replacements
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE finance.ledger_package_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON finance.ledger_package_lines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Chỉ thêm như sổ tiền: sửa, xoá một cặp thì dòng ước tính đã thay sống lại và cộng trùng; sửa dòng hàng thì lãi theo
-- SKU của kỳ đã chốt đổi theo.
REVOKE UPDATE, DELETE ON finance.ledger_replacements, finance.ledger_package_lines FROM commerio_app;--> statement-breakpoint
-- Chép cặp cũ từ cột `replaces_entry_id` (cột giữ lại, không ghi nữa).
INSERT INTO finance.ledger_replacements (company_id, actual_id, estimate_id)
  SELECT company_id, id, replaces_entry_id FROM finance.ledger_entries WHERE replaces_entry_id IS NOT NULL
  ON CONFLICT DO NOTHING;
