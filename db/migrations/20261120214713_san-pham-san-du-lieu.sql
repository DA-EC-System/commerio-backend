-- Sản phẩm sàn theo gian hàng (#295, Documents/19 câu chốt Q1). RLS cho bảng mới, rồi điền dữ liệu đang có: mỗi
-- (gian hàng, mã sản phẩm sàn) của listing thành một dòng `match` (dữ liệu đẩy trước #295 và sản phẩm người bán ghép SKU),
-- `active` khi còn listing chưa gỡ, không thì `delisted`; listing trỏ về dòng đó. Chạy trước CHECK `listings_shop_product`.
ALTER TABLE channel.shop_products ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON channel.shop_products
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
INSERT INTO channel.shop_products (company_id, shop_id, external_product_id, origin, status)
SELECT l.company_id, l.shop_id, l.external_product_id, 'match',
  CASE WHEN bool_or(l.status <> 'delisted') THEN 'active' ELSE 'delisted' END::channel.shop_product_status
FROM channel.listings l
WHERE l.external_product_id IS NOT NULL
GROUP BY l.company_id, l.shop_id, l.external_product_id;--> statement-breakpoint
UPDATE channel.listings l
SET shop_product_id = sp.id
FROM channel.shop_products sp
WHERE l.external_product_id IS NOT NULL
  AND sp.shop_id = l.shop_id
  AND sp.external_product_id = l.external_product_id
  AND l.shop_product_id IS NULL;
