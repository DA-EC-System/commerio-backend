-- Category và attribute của sàn (#400, Documents/19 mục 2, 3.3). RLS cho hai bảng theo công ty (vòng lặp của 0002 chỉ chạy
-- một lần); hai bảng tham chiếu của nền tảng không có `company_id`, không RLS, `commerio_app` chỉ đọc: ghi bằng role chủ
-- bảng ngoài `withCompany` (`replaceLeaf`, việc nền đồng bộ cây).
ALTER TABLE channel.product_specs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.product_specs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE channel.shop_category_permissions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.shop_category_permissions
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON channel.platform_categories, channel.platform_category_attributes FROM commerio_app;
