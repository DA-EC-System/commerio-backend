ALTER TABLE "channel"."api_usage" DROP CONSTRAINT "api_usage_platform_day_pk";--> statement-breakpoint
ALTER TABLE "channel"."api_usage" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "channel"."api_usage" ADD CONSTRAINT "api_usage_platform_day_company_uq" UNIQUE NULLS NOT DISTINCT("platform","day","company_id");