-- RLS và quyền cho hai bảng outbox (0004), unique tên vai trò không phân biệt hoa thường.
--
-- Outbox: trong công ty, role ứng dụng chỉ ghi thêm (publishEvent), không đọc, không sửa.
-- Relay của worker đọc và đánh dấu đã gửi bằng role chủ bảng (Documents/21 D5, V40).
ALTER TABLE platform.outbox_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON platform.outbox_messages
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
REVOKE SELECT, UPDATE, DELETE ON platform.outbox_messages FROM commerio_app;
--> statement-breakpoint
-- Khoá chống xử lý trùng của consumer: không thuộc công ty, không RLS; handler chạy dưới withCompany
-- ghi bảng này cùng giao dịch với việc nó làm, nên được đọc và thêm, không sửa, không xoá.
REVOKE UPDATE, DELETE ON platform.processed_events FROM commerio_app;
--> statement-breakpoint
-- Tên vai trò không phân biệt hoa thường trong một công ty (Documents/21 D3). Vai trò có sẵn có
-- company_id trống nên cần NULLS NOT DISTINCT; Drizzle không sinh được index biểu thức kèm điều này
-- (db/CLAUDE.md), nên không khai trong schema.ts.
CREATE UNIQUE INDEX roles_company_lower_name_uq ON access.roles (company_id, lower(name)) NULLS NOT DISTINCT;
