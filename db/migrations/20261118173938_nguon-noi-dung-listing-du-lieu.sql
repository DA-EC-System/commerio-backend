-- #399: điền chủ nội dung cho listing có trước cột `content_source` (cột thêm với mặc định `platform`). Listing là `app`
-- khi bản gốc của chuỗi `replaces_listing_id` (đẩy lại sau gỡ, nối lại gian hàng chép mã sàn của bản cũ) được tạo bằng
-- đẩy (lần chuyển đầu `push`), và không bản nào trong chuỗi từng gắn SKU sàn có sẵn vào listing lỗi đẩy (#346:
-- `match`/`approve_mapping` `push_failed → live`). Còn lại (ghép tay, ghép ở thiết lập, xin "không quản tồn", không có
-- lịch sử) giữ `platform`: không rõ thì không ghi đè nội dung người bán. Chỉ đặt `app`, chạy lại cho cùng kết quả.
with recursive chain as (
  select l.id, l.id as node, l.replaces_listing_id as up
    from "channel"."listings" l
  union all
  select c.id, p.id, p.replaces_listing_id
    from chain c
    join "channel"."listings" p on p.id = c.up
),
first_action as (
  select distinct on (t.entity_id) t.entity_id, t.action
    from "core"."state_transitions" t
   where t.entity_type = 'listings' and t.from_state is null
   order by t.entity_id, t.id
)
update "channel"."listings" l
   set content_source = 'app'
  from chain root
  join first_action f on f.entity_id = root.node and f.action = 'push'
 where root.id = l.id
   and root.up is null
   and not exists (
     select 1
       from chain c
       join "core"."state_transitions" t on t.entity_type = 'listings' and t.entity_id = c.node
      where c.id = l.id
        and t.action in ('match', 'approve_mapping')
        and t.from_state = 'push_failed'
        and t.to_state = 'live'
   );
