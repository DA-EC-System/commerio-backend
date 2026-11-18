ALTER TABLE "channel"."shop_reauth_mails" DROP CONSTRAINT "shop_reauth_mails_shop_id_shops_id_fk";
--> statement-breakpoint
ALTER TABLE "channel"."shop_reauth_mails" ADD CONSTRAINT "shop_reauth_mails_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "channel"."shops"("id") ON DELETE cascade ON UPDATE no action;