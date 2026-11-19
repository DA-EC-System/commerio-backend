-- Chép cờ cũ `cancelling` (đã dọn ở `*_dang-huy-du-lieu`) sang `cancel_pending` (thêm ở `*_dang-huy-cot`), viết tay, chỉ
-- dữ liệu. Đơn còn mở mà hai cột lệch thì theo cột cũ. Chạy lại được và **nên chạy lại sau rollout**: image cũ còn chạy
-- trong lúc đổi image chỉ ghi `cancelling` (Sale huỷ, lượt kéo gỡ cờ), còn code mới luôn ghi hai cột bằng nhau
-- (`withLegacyCancelling`), nên sau rollout hai cột chỉ lệch ở đơn image cũ vừa ghi.
update "order".orders set cancel_pending = cancelling
where status in ('unpaid', 'processing') and cancel_pending is distinct from cancelling;
