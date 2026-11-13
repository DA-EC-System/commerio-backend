CREATE TABLE "finance"."ledger_package_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"variant_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"unit_cost" numeric(18, 2),
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_package_lines_line_uq" UNIQUE("package_id","line_no"),
	CONSTRAINT "ledger_package_lines_quantity" CHECK ("finance"."ledger_package_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "finance"."ledger_replacements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actual_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_replacements_actual_uq" UNIQUE("actual_id"),
	CONSTRAINT "ledger_replacements_estimate_uq" UNIQUE("estimate_id"),
	CONSTRAINT "ledger_replacements_distinct" CHECK ("finance"."ledger_replacements"."actual_id" <> "finance"."ledger_replacements"."estimate_id")
);
--> statement-breakpoint
ALTER TABLE "finance"."ledger_replacements" ADD CONSTRAINT "ledger_replacements_actual_id_ledger_entries_id_fk" FOREIGN KEY ("actual_id") REFERENCES "finance"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."ledger_replacements" ADD CONSTRAINT "ledger_replacements_estimate_id_ledger_entries_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "finance"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_package_lines_occurred_on_index" ON "finance"."ledger_package_lines" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "ledger_package_lines_order_id_index" ON "finance"."ledger_package_lines" USING btree ("order_id");