-- RLS cho 24 bảng sales, fulfillment, channel, payment, finance, report (0008, 0009): mỗi bảng chỉ thấy dòng của
-- công ty đang chọn, cùng mẫu với 0003. Quyền SELECT/INSERT/UPDATE/DELETE của commerio_app đến từ ALTER DEFAULT
-- PRIVILEGES (0003). Tra mã thanh toán, khoá nhận webhook SePay trước khi biết công ty chạy bằng role chủ bảng (D16).
ALTER TABLE sales.customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON sales.customers
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sales.customer_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON sales.customer_identities
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sales.orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON sales.orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sales.order_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON sales.order_lines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sales.doc_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON sales.doc_counters
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE fulfillment.order_status_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON fulfillment.order_status_history
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE fulfillment.pick_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON fulfillment.pick_batches
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE fulfillment.pick_batch_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON fulfillment.pick_batch_orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel.shops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON channel.shops
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel.channel_listings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON channel.channel_listings
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel.raw_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON channel.raw_orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel.webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON channel.webhook_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payment.order_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON payment.order_payments
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payment.gateway_configs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON payment.gateway_configs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payment.payment_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON payment.payment_links
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payment.payment_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON payment.payment_transactions
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payment.webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON payment.webhook_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.sales_invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.sales_invoices
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.sales_invoice_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.sales_invoice_lines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.unmatched_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.unmatched_receipts
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.receipts
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.payment_vouchers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.payment_vouchers
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.doc_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.doc_counters
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE report.daily_channel_summary ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON report.daily_channel_summary
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- Lịch sử chuyển trạng thái đơn chỉ thêm, như thẻ kho.
REVOKE UPDATE, DELETE ON fulfillment.order_status_history FROM commerio_app;
