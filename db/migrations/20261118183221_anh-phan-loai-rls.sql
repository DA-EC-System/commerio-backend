-- Ảnh phân loại (#340, Documents/19 §3.2). RLS cho bảng mới (vòng lặp của 0002 chỉ chạy một lần) và hai khoá ngoại ghép:
-- drizzle-kit sinh khoá ngoại trước unique đích nên viết tay ở đây, sau migration `*_anh-phan-loai` (db/CLAUDE.md).
-- `pavi_product_fk`: ảnh chỉ mang đúng thuộc tính gắn ảnh hiện tại của sản phẩm (null thì không khớp, không chèn được);
-- đổi `products.image_attribute_id` khi còn ảnh bị chặn, service xoá ảnh trước. `pavi_value_fk`: giá trị thuộc đúng
-- thuộc tính đó.
ALTER TABLE product.product_attribute_value_images ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON product.product_attribute_value_images
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE product.product_attribute_value_images ADD CONSTRAINT pavi_product_fk
  FOREIGN KEY (product_id, attribute_id) REFERENCES product.products (id, image_attribute_id);--> statement-breakpoint
ALTER TABLE product.product_attribute_value_images ADD CONSTRAINT pavi_value_fk
  FOREIGN KEY (attribute_value_id, attribute_id) REFERENCES product.attribute_values (id, attribute_id);
