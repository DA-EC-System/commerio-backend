-- Thuật ngữ UI theo bảng chốt 19/11/2026 (FE#332): đổi nhãn quyền người dùng thấy ở màn vai trò.
-- Chỉ đổi description, không đổi mã quyền. Khớp access/domain/catalog.ts.
UPDATE "core"."permissions" SET "description" = 'Bật, tắt tính năng' WHERE "code" = 'platform.module.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xem, chạy lại tác vụ lỗi' WHERE "code" = 'platform.job.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xem danh sách nhân viên' WHERE "code" = 'identity.account.view';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Mời nhân viên, gán vai trò, khoá tài khoản' WHERE "code" = 'identity.account.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Tạo, sửa, xoá vai trò tự tạo' WHERE "code" = 'identity.role.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Thêm, sửa sản phẩm và variant' WHERE "code" = 'catalog.product.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Cài đặt category, thuộc tính phân loại, quy tắc SKU' WHERE "code" = 'catalog.category.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Lập phiếu kho (kiểm kho, xuất huỷ, chuyển hàng lỗi/chờ kiểm), kiểm hàng hoàn' WHERE "code" = 'inventory.receipt.create';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Đặt tồn tối thiểu' WHERE "code" = 'inventory.reorder.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Quản lý NCC; lập, gửi, rút đơn đặt hàng nhập; chốt đặt với NCC; ghi nhận NCC giao thiếu' WHERE "code" = 'purchasing.request.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Duyệt, yêu cầu sửa, từ chối, đóng đơn thiếu, huỷ đơn đặt hàng nhập; duyệt, huỷ phiếu trả hàng NCC' WHERE "code" = 'purchasing.request.approve';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Lập, kiểm đếm, nhập kho, huỷ phiếu nhập kho' WHERE "code" = 'purchasing.receipt.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Lập, gửi duyệt phiếu trả hàng NCC; ghi nhận NCC hoàn tiền, đổi hàng' WHERE "code" = 'purchasing.return.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xem trả hàng/hoàn tiền' WHERE "code" = 'sales.return.view';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Lập, chấp nhận, từ chối trả hàng/hoàn tiền' WHERE "code" = 'sales.return.process';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Đóng gói, tách kiện, sẵn sàng giao, bàn giao kiện, nhận hàng hoàn, báo thất lạc' WHERE "code" = 'fulfillment.order.process';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Cập nhật giao hàng đơn shop tự giao' WHERE "code" = 'fulfillment.delivery.update';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Huỷ bàn giao kiện' WHERE "code" = 'fulfillment.handover.revert';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xem sổ giao dịch, trạng thái thanh toán, đối soát công nợ sàn, cấu hình phí và thuế' WHERE "code" = 'finance.invoice.view';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Nhập sao kê sàn TikTok từ file (môi trường thử)' WHERE "code" = 'finance.voucher.create';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Soạn, tính thử cấu hình phí sàn, thuế, ngưỡng chênh lệch đối soát' WHERE "code" = 'finance.config.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Duyệt, từ chối cấu hình phí sàn, thuế, ngưỡng chênh lệch đối soát' WHERE "code" = 'finance.config.approve';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xử lý chênh lệch đối soát trong hạn mức tự xử lý' WHERE "code" = 'finance.settlement.resolve';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Duyệt xử lý chênh lệch đối soát vượt hạn mức tự xử lý' WHERE "code" = 'finance.settlement.approve';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Ngắt kết nối gian hàng' WHERE "code" = 'channel.shop.disconnect';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Đăng bán, gỡ listing; đồng bộ giá, tồn lên sàn' WHERE "code" = 'channel.listing.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Liên kết SKU sàn với variant' WHERE "code" = 'channel.listing.match';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Quản lý tài liệu cho trợ lý AI' WHERE "code" = 'assistant.document.manage';
--> statement-breakpoint
UPDATE "core"."permissions" SET "description" = 'Xuất file báo cáo' WHERE "code" = 'report.dashboard.export';
