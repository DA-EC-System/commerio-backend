-- Đổi cột cờ `cancelling` thành `cancel_pending` theo hai bước (#417), viết tay. Bước một (migration này): chép cờ cũ (đã
-- dọn ở `*_dang-huy-du-lieu`) sang `cancel_pending` (thêm ở `*_dang-huy-cot`), rồi trigger giữ hai cột luôn bằng nhau.
-- Job migrate chạy trước khi đổi image, image cũ còn chạy một lúc và chỉ đọc, ghi `cancelling`; code mới đọc, ghi
-- `cancel_pending`. Bên nào ghi cột nào thì cột kia đổi theo, nên không phải chạy lại gì sau rollout và lùi image vẫn đúng.
-- Bước hai (PR sau): bỏ trigger, hàm, cột `cancelling`; thêm CHECK `orders_cancel_pending_open`, `orders_cancel_requested_open`.
update "order".orders set cancel_pending = cancelling
where cancel_pending is distinct from cancelling;
--> statement-breakpoint
create or replace function "order".orders_sync_cancel_pending() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.cancel_pending := new.cancel_pending or new.cancelling;
  elsif new.cancel_pending is not distinct from old.cancel_pending and new.cancelling is distinct from old.cancelling then
    -- Chỉ cột cũ đổi: image cũ ghi.
    new.cancel_pending := new.cancelling;
  end if;
  new.cancelling := new.cancel_pending;
  return new;
end
$$;
--> statement-breakpoint
drop trigger if exists orders_sync_cancel_pending on "order".orders;
--> statement-breakpoint
create trigger orders_sync_cancel_pending before insert or update on "order".orders
for each row execute function "order".orders_sync_cancel_pending();
