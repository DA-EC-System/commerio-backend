DROP INDEX "finance"."ledger_entries_external_txn_uq";--> statement-breakpoint
ALTER TABLE "finance"."ledger_entries" ADD COLUMN "external_order_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_external_txn_uq" ON "finance"."ledger_entries" USING btree ("company_id","shop_id","external_transaction_id") WHERE "finance"."ledger_entries"."external_transaction_id" is not null;