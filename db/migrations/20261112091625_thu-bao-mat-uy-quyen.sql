CREATE TABLE "channel"."shop_reauth_mails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_reauth_mails_milestone_uq" UNIQUE("shop_id","deadline","stage","seq"),
	CONSTRAINT "shop_reauth_mails_stage" CHECK ("channel"."shop_reauth_mails"."stage" in ('expiring_3d', 'expiring_1d', 'lost')),
	CONSTRAINT "shop_reauth_mails_seq" CHECK ("channel"."shop_reauth_mails"."seq" >= 0 and ("channel"."shop_reauth_mails"."stage" = 'lost' or "channel"."shop_reauth_mails"."seq" = 0))
);
--> statement-breakpoint
ALTER TABLE "channel"."shop_reauth_mails" ADD CONSTRAINT "shop_reauth_mails_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE no action ON UPDATE no action;