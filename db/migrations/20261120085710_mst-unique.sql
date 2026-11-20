ALTER TABLE "core"."companies" ALTER COLUMN "tax_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."companies" ADD CONSTRAINT "companies_tax_code_unique" UNIQUE("tax_code");