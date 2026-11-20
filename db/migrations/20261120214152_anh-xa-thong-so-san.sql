CREATE TABLE "channel"."spec_field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"attribute_code" text NOT NULL,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_field_mappings_code_uq" UNIQUE("company_id","field_id","platform","attribute_code"),
	CONSTRAINT "spec_field_mappings_priority_uq" UNIQUE("company_id","field_id","platform","priority"),
	CONSTRAINT "spec_field_mappings_attribute_uq" UNIQUE("company_id","platform","attribute_code"),
	CONSTRAINT "spec_field_mappings_priority" CHECK ("channel"."spec_field_mappings"."priority" >= 1)
);
--> statement-breakpoint
CREATE TABLE "channel"."spec_option_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"attribute_code" text NOT NULL,
	"platform_option_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_option_mappings_uq" UNIQUE("company_id","option_id","platform","attribute_code")
);
--> statement-breakpoint
ALTER TABLE "channel"."spec_option_mappings" ADD CONSTRAINT "spec_option_mappings_field_fk" FOREIGN KEY ("company_id","field_id","platform","attribute_code") REFERENCES "channel"."spec_field_mappings"("company_id","field_id","platform","attribute_code") ON DELETE cascade ON UPDATE no action;