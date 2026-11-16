-- #238 (spec §5.1): trước #238 chưa có đường nào để người dùng đưa kiện sang `lost`, nên mọi kiện `lost` chưa có người
-- xác nhận là do sàn báo. Điền nguồn trước khi thêm CHECK `packages_lost_confirmed` (migration `that-lac-rang-buoc`).
update "order".packages set lost_source = 'marketplace' where status = 'lost' and lost_confirmed_by is null;
