-- Bỏ tên sàn khỏi nhãn quyền người dùng thấy ở màn vai trò ("Thiết kế cho nhiều sàn"). Chỉ đổi description; khớp access/domain/catalog.ts.
UPDATE "core"."permissions" SET "description" = 'Nhập sao kê của sàn từ file (môi trường thử)' WHERE "code" = 'finance.voucher.create';
