-- Nhóm hàng (#447): RLS cho bảng mới `product.company_product_settings` (vòng lặp của 0002 chỉ chạy một lần; bảng
-- `product_groups` đổi tên giữ nguyên policy cũ).
ALTER TABLE "product"."company_product_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_isolation ON "product"."company_product_settings"
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- Đổi mã quyền `catalog.category.manage` thành `catalog.group.manage` (Documents/kiem-thu/ma-tran-quyen.md). Khoá ngoại
-- `role_permissions.permission_code` không cascade khi đổi mã: thêm mã mới, chuyển mọi vai trò (có sẵn và tự tạo), xoá mã
-- cũ. Khớp access/domain/catalog.ts. Chạy lại được.
INSERT INTO "core"."permissions" ("code", "module_code", "description") VALUES
  ('catalog.group.manage', 'catalog', 'Nhóm hàng, thuộc tính, cài đặt sản phẩm (quy tắc SKU, gợi ý)')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "core"."role_permissions" ("role_id", "permission_code")
SELECT "role_id", 'catalog.group.manage' FROM "core"."role_permissions" WHERE "permission_code" = 'catalog.category.manage'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "core"."role_permissions" WHERE "permission_code" = 'catalog.category.manage';
--> statement-breakpoint
DELETE FROM "core"."permissions" WHERE "code" = 'catalog.category.manage';
