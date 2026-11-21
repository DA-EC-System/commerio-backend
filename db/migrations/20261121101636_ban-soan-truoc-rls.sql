-- RLS cho bảng mới `product.purchase_product_drafts` (bản soạn trước sản phẩm mới, Documents/19, 21 mục 16.3; vòng lặp của 0002 chỉ chạy một lần).
ALTER TABLE product.purchase_product_drafts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.purchase_product_drafts
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
