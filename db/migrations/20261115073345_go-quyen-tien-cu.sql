-- Gỡ quyền của phần tiền cũ (#235, Thành duyệt 13/11/2026): cổng thanh toán ngoài MVP, chứng từ đảo không làm; không
-- còn route nào dùng. Gỡ khỏi mọi vai trò (có sẵn và tuỳ biến) trước, rồi khỏi danh mục. Khớp access/domain/catalog.ts.
DELETE FROM "core"."role_permissions"
 WHERE "permission_code" IN ('payment.link.create', 'payment.transaction.view', 'payment.gateway.manage', 'finance.reversal.create');
--> statement-breakpoint
DELETE FROM "core"."permissions"
 WHERE "code" IN ('payment.link.create', 'payment.transaction.view', 'payment.gateway.manage', 'finance.reversal.create');
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xem sổ tiền, trạng thái tiền, đối soát, cấu hình tiền' WHERE "code" = 'finance.invoice.view';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Nhập bảng kê đối soát TikTok (bản cũ, #30)' WHERE "code" = 'finance.voucher.create';
