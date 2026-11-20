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
--> statement-breakpoint
-- Có mã sản phẩm sàn thì phải trỏ `shop_products` (#295). Viết tay ở đây, không khai trong `schema.ts`: drizzle sẽ thêm ràng
-- buộc trước bước điền dữ liệu, và `db:regen` gộp lại các migration sinh nên không tách được thành ba bước.
ALTER TABLE channel.listings ADD CONSTRAINT listings_shop_product CHECK (external_product_id IS NULL OR shop_product_id IS NOT NULL);
--> statement-breakpoint
-- Gắn sản phẩm sàn cho listing ở CSDL (#295), để mọi đường ghi (lớp ghi listing, SQL tay, test) cùng giữ CHECK trên:
-- listing có mã sản phẩm sàn mà chưa trỏ dòng nào (hoặc vừa đổi mã mà không đổi dòng) thì lấy dòng `active` cùng mã của gian
-- hàng, chưa có thì tạo dòng `match`. Bên ghi tự đặt dòng (đẩy gom biến thể trỏ dòng `app`) thì giữ. Xoá mã sàn (sàn xoá sản
-- phẩm) mà không đổi dòng thì bỏ liên kết. Chạy với quyền bên gọi: RLS của `shop_products` nhận vì `company_id` lấy từ listing.
CREATE FUNCTION channel.listings_attach_shop_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.external_product_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.external_product_id IS NOT NULL AND NEW.shop_product_id IS NOT DISTINCT FROM OLD.shop_product_id THEN
      NEW.shop_product_id := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.shop_product_id IS NOT NULL AND (
    TG_OP = 'INSERT'
    OR NEW.shop_product_id IS DISTINCT FROM OLD.shop_product_id
    OR NEW.external_product_id IS NOT DISTINCT FROM OLD.external_product_id
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO channel.shop_products (company_id, shop_id, external_product_id, origin)
  VALUES (NEW.company_id, NEW.shop_id, NEW.external_product_id, 'match')
  ON CONFLICT (shop_id, external_product_id) WHERE external_product_id IS NOT NULL AND status = 'active'
  DO UPDATE SET updated_at = now()
  RETURNING id INTO NEW.shop_product_id;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER listings_attach_shop_product
  BEFORE INSERT OR UPDATE OF external_product_id, shop_product_id ON channel.listings
  FOR EACH ROW EXECUTE FUNCTION channel.listings_attach_shop_product();
