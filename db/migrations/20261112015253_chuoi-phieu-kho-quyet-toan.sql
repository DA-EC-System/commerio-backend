ALTER TABLE "product"."supplier_returns" DROP CONSTRAINT "supplier_returns_result_by";--> statement-breakpoint
DROP INDEX "finance"."ledger_entries_external_txn_uq";--> statement-breakpoint
ALTER TABLE "finance"."ledger_entries" ADD COLUMN "external_order_id" text;--> statement-breakpoint
ALTER TABLE "product"."stock_documents" ADD COLUMN "source_number" text;--> statement-breakpoint
ALTER TABLE "product"."stock_documents" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."stock_documents" ADD COLUMN "shop_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."goods_receipts" ADD COLUMN "follows_up_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "product"."purchase_request_lines" ADD COLUMN "excluded_reason" text;--> statement-breakpoint
ALTER TABLE "product"."purchase_requests" ADD COLUMN "supplier_order_code" text;--> statement-breakpoint
ALTER TABLE "product"."supplier_returns" ADD COLUMN "result_self_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_opening_uq" ON "product"."stock_documents" USING btree ("company_id","source_id") WHERE "product"."stock_documents"."source_type" = 'shop_setup' and "product"."stock_documents"."status" in ('draft', 'pending');--> statement-breakpoint
-- Mã giao dịch quyết toán ghi trước #250 chưa bỏ khoảng trắng: chuẩn hoá để kéo lại kỳ cũ không ghi trùng (review #274).
-- Dòng mà mã đã chuẩn hoá trùng một dòng khác của cùng gian hàng thì giữ nguyên, tránh vỡ unique mới.
UPDATE "finance"."ledger_entries" e SET "external_transaction_id" = regexp_replace(e."external_transaction_id", '\s+', '', 'g')
WHERE e."source_type" = 'settlement_batch' AND e."external_transaction_id" ~ '\s'
  AND NOT EXISTS (
    SELECT 1 FROM "finance"."ledger_entries" o
    WHERE o."company_id" = e."company_id" AND o."shop_id" IS NOT DISTINCT FROM e."shop_id" AND o."id" <> e."id"
      AND regexp_replace(o."external_transaction_id", '\s+', '', 'g') = regexp_replace(e."external_transaction_id", '\s+', '', 'g')
  );--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_external_txn_uq" ON "finance"."ledger_entries" USING btree ("company_id","shop_id","external_transaction_id") WHERE "finance"."ledger_entries"."external_transaction_id" is not null;--> statement-breakpoint
-- Dòng đã loại trước #243 chưa có lý do: ghi lý do mặc định để CHECK mới không chặn dữ liệu cũ
UPDATE "product"."purchase_request_lines" SET "excluded_reason" = 'Loại trước khi có lý do' WHERE "excluded" AND "excluded_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "product"."purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_excluded_reason" CHECK (not "product"."purchase_request_lines"."excluded" or "product"."purchase_request_lines"."excluded_reason" is not null);--> statement-breakpoint
ALTER TABLE "product"."supplier_returns" ADD CONSTRAINT "supplier_returns_result_by" CHECK ("product"."supplier_returns"."result_by" is null or "product"."supplier_returns"."result_by" is distinct from "product"."supplier_returns"."sent_by" or "product"."supplier_returns"."result_self_approved");