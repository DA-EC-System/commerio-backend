-- RLS cho 15 bảng purchasing, inbox, assistant, finance (0013): mỗi bảng chỉ thấy dòng của công ty đang chọn, cùng
-- mẫu với 0003. Quyền SELECT/INSERT/UPDATE/DELETE của commerio_app đến từ ALTER DEFAULT PRIVILEGES (0003).
ALTER TABLE purchasing.suppliers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON purchasing.suppliers
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE purchasing.purchase_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON purchasing.purchase_orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE purchasing.purchase_order_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON purchasing.purchase_order_lines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE inbox.message_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON inbox.message_channels
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE inbox.conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON inbox.conversations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE inbox.conversation_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON inbox.conversation_notes
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE inbox.messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON inbox.messages
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE inbox.tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON inbox.tags
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE inbox.conversation_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON inbox.conversation_tags
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE assistant.documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON assistant.documents
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE assistant.document_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON assistant.document_chunks
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE assistant.document_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON assistant.document_roles
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.supplier_invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.supplier_invoices
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.settlement_statements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.settlement_statements
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE finance.settlement_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON finance.settlement_lines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
