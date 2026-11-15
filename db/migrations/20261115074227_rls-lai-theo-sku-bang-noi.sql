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
-- Ép chiều cặp: dòng thực tế là `is_estimate = false`, dòng ước tính là `true` (khoá ngoại ghép tới unique
-- `ledger_entries_id_estimate_uq`; hai cột cờ là hằng do CHECK). Viết tay vì drizzle-kit sinh khoá ngoại trước unique.
ALTER TABLE finance.ledger_replacements ADD CONSTRAINT ledger_replacements_actual_fk
  FOREIGN KEY (actual_id, actual_is_estimate) REFERENCES finance.ledger_entries (id, is_estimate);--> statement-breakpoint
ALTER TABLE finance.ledger_replacements ADD CONSTRAINT ledger_replacements_estimate_fk
  FOREIGN KEY (estimate_id, estimate_is_estimate) REFERENCES finance.ledger_entries (id, is_estimate);--> statement-breakpoint
-- Chép cặp cũ từ cột `replaces_entry_id` (cột giữ lại, không ghi nữa). Chỉ cặp đúng chiều (khoá ngoại ghép ép chiều).
INSERT INTO finance.ledger_replacements (company_id, actual_id, estimate_id)
  SELECT a.company_id, a.id, a.replaces_entry_id
  FROM finance.ledger_entries a JOIN finance.ledger_entries e ON e.id = a.replaces_entry_id
  WHERE a.replaces_entry_id IS NOT NULL AND NOT a.is_estimate AND e.is_estimate;
