ALTER TABLE "product"."purchase_request_lines" ADD COLUMN "excluded_reason" text;--> statement-breakpoint
ALTER TABLE "product"."purchase_requests" ADD COLUMN "supplier_order_code" text;--> statement-breakpoint
-- Dòng đã loại trước #243 chưa có lý do: ghi lý do mặc định để CHECK mới không chặn dữ liệu cũ
UPDATE "product"."purchase_request_lines" SET "excluded_reason" = 'Loại trước khi có lý do' WHERE "excluded" AND "excluded_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "product"."purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_excluded_reason" CHECK (not "product"."purchase_request_lines"."excluded" or "product"."purchase_request_lines"."excluded_reason" is not null);