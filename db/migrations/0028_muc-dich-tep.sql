CREATE TYPE "core"."file_purpose" AS ENUM('product_image', 'attachment');--> statement-breakpoint
ALTER TABLE "core"."files" ADD COLUMN "purpose" "core"."file_purpose" NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."files" ADD CONSTRAINT "files_size_positive" CHECK ("core"."files"."size_bytes" > 0);