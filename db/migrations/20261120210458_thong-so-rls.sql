-- Thông số sản phẩm (#510, Documents/19 §3.2). RLS cho bốn bảng mới (vòng lặp của 0002 chỉ chạy một lần) và khoá ngoại ghép
-- `psv_option_fk` (option_id, field_id) → spec_field_options(id, field_id): lựa chọn chỉ thuộc đúng thông số của nó, xoá lựa
-- chọn đang dùng bị chặn. drizzle-kit sinh khoá ngoại trước unique đích nên viết tay ở đây (db/CLAUDE.md).
ALTER TABLE product.spec_fields ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.spec_fields
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE product.spec_field_options ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.spec_field_options
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE product.group_spec_fields ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.group_spec_fields
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE product.product_spec_values ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.product_spec_values
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE product.product_spec_values ADD CONSTRAINT psv_option_fk
  FOREIGN KEY (option_id, field_id) REFERENCES product.spec_field_options (id, field_id) ON DELETE RESTRICT;
