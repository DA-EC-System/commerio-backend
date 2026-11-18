-- Tự giao, báo kết quả tự giao chỉ còn Nhân viên kho (Documents/25 mục 11, đổi 17/11/2026; #351): bỏ quyền giao khỏi vai
-- trò có sẵn Sale. Khớp access/domain/catalog.ts.
DELETE FROM "core"."role_permissions"
WHERE "role_id" = '00000000-0000-4000-8000-000000000003' AND "permission_code" = 'fulfillment.delivery.update';
