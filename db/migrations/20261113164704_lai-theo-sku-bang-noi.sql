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
	"actual_is_estimate" boolean DEFAULT false NOT NULL,
	"estimate_id" uuid NOT NULL,
	"estimate_is_estimate" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_replacements_actual_uq" UNIQUE("actual_id"),
	CONSTRAINT "ledger_replacements_estimate_uq" UNIQUE("estimate_id"),
	CONSTRAINT "ledger_replacements_distinct" CHECK ("finance"."ledger_replacements"."actual_id" <> "finance"."ledger_replacements"."estimate_id"),
	CONSTRAINT "ledger_replacements_actual_flag" CHECK (not "finance"."ledger_replacements"."actual_is_estimate"),
	CONSTRAINT "ledger_replacements_estimate_flag" CHECK ("finance"."ledger_replacements"."estimate_is_estimate")
);
--> statement-breakpoint
CREATE INDEX "ledger_package_lines_occurred_on_index" ON "finance"."ledger_package_lines" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "ledger_package_lines_order_id_index" ON "finance"."ledger_package_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_source_type_source_id_index" ON "finance"."ledger_entries" USING btree ("source_type","source_id");--> statement-breakpoint
ALTER TABLE "finance"."ledger_entries" ADD CONSTRAINT "ledger_entries_id_estimate_uq" UNIQUE("id","is_estimate");