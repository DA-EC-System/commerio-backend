CREATE TABLE "channel"."axis_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"attribute_code" text NOT NULL,
	"priority" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "axis_mappings_code_uq" UNIQUE("company_id","attribute_id","platform","attribute_code"),
	CONSTRAINT "axis_mappings_priority_uq" UNIQUE("company_id","attribute_id","platform","priority"),
	CONSTRAINT "axis_mappings_priority" CHECK ("channel"."axis_mappings"."priority" >= 1)
);
