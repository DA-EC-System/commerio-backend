ALTER TYPE "finance"."ledger_kind" ADD VALUE 'withdrawal';--> statement-breakpoint
CREATE TABLE "finance"."bank_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"bank_ref" text NOT NULL,
	"matched_by" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_matches_entry_uq" UNIQUE("entry_id"),
	CONSTRAINT "bank_matches_ref" CHECK (length(trim("finance"."bank_matches"."bank_ref")) > 0)
);
--> statement-breakpoint
ALTER TABLE "finance"."ledger_entries" ADD COLUMN "external_transaction_id" text;--> statement-breakpoint
ALTER TABLE "finance"."settlement_batches" ADD COLUMN "duplicates" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."settlement_batches" ADD COLUMN "wallet_diff" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "finance"."bank_matches" ADD CONSTRAINT "bank_matches_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "finance"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_external_txn_uq" ON "finance"."ledger_entries" USING btree ("company_id","external_transaction_id") WHERE "finance"."ledger_entries"."external_transaction_id" is not null;