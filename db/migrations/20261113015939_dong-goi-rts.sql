ALTER TABLE "order"."packages" ADD COLUMN "carrier_code" text;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "carrier_name" text;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD COLUMN "label_error" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order"."packages" ADD CONSTRAINT "packages_carrier" CHECK (("order"."packages"."carrier_code" is null) = ("order"."packages"."carrier_name" is null));