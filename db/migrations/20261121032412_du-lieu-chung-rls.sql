-- Dữ liệu chuẩn hai tầng (#521, Documents/19 mục 2 "Dữ liệu chuẩn hai tầng", 21 mục 5.6). Sáu bảng catalog thay
-- `company_isolation` bằng bốn policy: đọc dòng nền tảng (`company_id` NULL) và dòng của công ty; ghi chỉ dòng của công ty.
-- `commerio_app` không ghi được dòng nền tảng: dòng nền tảng chỉ đổi bằng migration (role chủ bảng).
DROP POLICY company_isolation ON product.product_groups;--> statement-breakpoint
CREATE POLICY tier_read ON product.product_groups FOR SELECT
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON product.product_groups FOR INSERT
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON product.product_groups FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON product.product_groups FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON product.attributes;--> statement-breakpoint
CREATE POLICY tier_read ON product.attributes FOR SELECT
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON product.attributes FOR INSERT
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON product.attributes FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON product.attributes FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON product.attribute_values;--> statement-breakpoint
CREATE POLICY tier_read ON product.attribute_values FOR SELECT
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON product.attribute_values FOR INSERT
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON product.attribute_values FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON product.attribute_values FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON product.spec_fields;--> statement-breakpoint
CREATE POLICY tier_read ON product.spec_fields FOR SELECT
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON product.spec_fields FOR INSERT
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON product.spec_fields FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON product.spec_fields FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON product.spec_field_options;--> statement-breakpoint
CREATE POLICY tier_read ON product.spec_field_options FOR SELECT
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON product.spec_field_options FOR INSERT
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON product.spec_field_options FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON product.spec_field_options FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY company_isolation ON product.group_spec_fields;--> statement-breakpoint
CREATE POLICY tier_read ON product.group_spec_fields FOR SELECT
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_insert ON product.group_spec_fields FOR INSERT
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_update ON product.group_spec_fields FOR UPDATE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tier_delete ON product.group_spec_fields FOR DELETE
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
-- Cài đặt của công ty trên nhóm nền tảng (ẩn, gợi ý): một tầng.
ALTER TABLE product.company_group_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.company_group_settings
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
