CREATE TABLE "channel"."platform_categories" (
	"platform" "channel"."marketplace" NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"name" text NOT NULL,
	"is_leaf" boolean NOT NULL,
	"path" text NOT NULL,
	"path_search" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"synced_at" timestamp with time zone,
	"size_chart_rule" text,
	"attributes_fetched_at" timestamp with time zone,
	CONSTRAINT "platform_categories_platform_external_id_pk" PRIMARY KEY("platform","external_id"),
	CONSTRAINT "platform_categories_status" CHECK ("channel"."platform_categories"."status" in ('active', 'removed')),
	CONSTRAINT "platform_categories_size_chart_rule" CHECK ("channel"."platform_categories"."size_chart_rule" in ('required', 'optional', 'unsupported'))
);
--> statement-breakpoint
CREATE TABLE "channel"."platform_category_attributes" (
	"platform" "channel"."marketplace" NOT NULL,
	"external_category_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"input" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_custom" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"required_when" jsonb,
	"is_key" boolean DEFAULT false NOT NULL,
	"tier" text NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_category_attributes_platform_external_category_id_code_pk" PRIMARY KEY("platform","external_category_id","code"),
	CONSTRAINT "platform_category_attributes_kind" CHECK ("channel"."platform_category_attributes"."kind" in ('sales', 'property')),
	CONSTRAINT "platform_category_attributes_input" CHECK ("channel"."platform_category_attributes"."input" in ('select', 'multiselect', 'text', 'number', 'date', 'image', 'cascade')),
	CONSTRAINT "platform_category_attributes_tier" CHECK ("channel"."platform_category_attributes"."tier" in ('category', 'product', 'company'))
);
--> statement-breakpoint
CREATE TABLE "channel"."product_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"platform" "channel"."marketplace" NOT NULL,
	"external_category_id" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"axis_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"category_status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_specs_product_platform_uq" UNIQUE("product_id","platform"),
	CONSTRAINT "product_specs_source" CHECK ("channel"."product_specs"."source" in ('push', 'match')),
	CONSTRAINT "product_specs_category_status" CHECK ("channel"."product_specs"."category_status" in ('ok', 'changed', 'removed')),
	CONSTRAINT "product_specs_version" CHECK ("channel"."product_specs"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel"."shop_category_permissions" (
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"external_category_id" text NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shop_category_permissions_shop_id_external_category_id_pk" PRIMARY KEY("shop_id","external_category_id"),
	CONSTRAINT "shop_category_permissions_status" CHECK ("channel"."shop_category_permissions"."status" in ('available', 'invite_only', 'non_main_category', 'prohibited'))
);
--> statement-breakpoint
ALTER TABLE "channel"."listings" ADD COLUMN "external_category_id" text;--> statement-breakpoint
ALTER TABLE "channel"."platform_category_attributes" ADD CONSTRAINT "platform_category_attributes_category_fk" FOREIGN KEY ("platform","external_category_id") REFERENCES "channel"."platform_categories"("platform","external_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."shop_category_permissions" ADD CONSTRAINT "shop_category_permissions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_categories_parent_idx" ON "channel"."platform_categories" USING btree ("platform","parent_external_id");--> statement-breakpoint
CREATE INDEX "platform_categories_path_search_trgm" ON "channel"."platform_categories" USING gin ("path_search" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "product_specs_category_idx" ON "channel"."product_specs" USING btree ("platform","external_category_id");