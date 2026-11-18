-- #396: listing chưa gỡ đang ghép (có mã SKU sàn) lấy tên trong bản sao SKU sàn làm mốc "tên trên sàn lúc ghép". Tên tiếng
-- Anh và giờ mốc để trống: bản sao chưa có `title_en` (cột mới), lần ghi bản sao kế tiếp lấy làm mốc, không bật cờ.
update "channel"."listings" l set "remote_title_at_match" = r."title"
  from "channel"."remote_skus" r
 where r."shop_id" = l."shop_id" and r."external_sku_id" = l."external_sku_id"
   and l."status" <> 'delisted' and l."remote_title_at_match" is null;
