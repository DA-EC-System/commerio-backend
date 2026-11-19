-- Custom SQL migration file, put your code below! --
-- #236 PR 2 (spec 5.3, D13): đơn TikTok đã COMPLETED/CANCELLED trên sàn trước PR 2 không được kéo lại (order-pull bỏ
-- đơn có update_time không mới hơn raw_orders), nên ghi mốc hết quyền trả từ lần kéo đã lưu. Chỉ đơn đang xử lý, cột
-- còn null (ghi một lần, D7). Bỏ dòng 'epoch' (dấu ép kéo lại của *_huy-dong-du-lieu, *_keo-lai-don-trang-thai-moi):
-- lượt kéo sau ghi mốc thật. Tăng version để lần ghi theo version của worker cũ đang chạy bị lệch. Chạy lại được; chạy
-- lại sau rollout (db/CLAUDE.md).
update "order".orders o
   set return_window_ends_at = r.external_update_time,
       version = o.version + 1,
       updated_at = now()
  from channel.raw_orders r
  join channel.shops s on s.id = r.shop_id
 where r.shop_id = o.shop_id
   and r.external_order_id = o.external_order_id
   and s.platform = 'tiktok'
   and o.status = 'processing'
   and o.raw_marketplace_status in ('COMPLETED', 'CANCELLED')
   and o.return_window_ends_at is null
   and r.external_update_time > 'epoch';
