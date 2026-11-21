CREATE TABLE "finance"."fee_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"shop_type" text NOT NULL,
	"shop_type_label" text NOT NULL,
	"payload" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fee_templates_platform_shop_type_uq" UNIQUE("platform","shop_type"),
	CONSTRAINT "fee_templates_shop_type" CHECK ("finance"."fee_templates"."shop_type" ~ '^[a-z][a-z0-9_]{0,29}$'),
	CONSTRAINT "fee_templates_label" CHECK (length("finance"."fee_templates"."shop_type_label") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD COLUMN "source_template_id" uuid;--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD COLUMN "source_template_version" integer;--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD CONSTRAINT "config_versions_source_template_id_fee_templates_id_fk" FOREIGN KEY ("source_template_id") REFERENCES "finance"."fee_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD CONSTRAINT "config_versions_source_template" CHECK (("finance"."config_versions"."source_template_id" is null or "finance"."config_versions"."kind" = 'fee') and ("finance"."config_versions"."source_template_id" is null) = ("finance"."config_versions"."source_template_version" is null));