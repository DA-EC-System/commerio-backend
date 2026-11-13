-- #230: đổi trạng thái phiên bản cấu hình `expired` → `superseded` (Documents/25 §10.4, 21 §21.4, chốt 02/11/2026).
-- Viết tay thay câu drizzle sinh (đổi cột sang text, xoá và tạo lại kiểu): đổi tên giá trị enum giữ nguyên dòng đang
-- `expired` trên staging và không đụng ràng buộc EXCLUDE `config_versions_no_overlap`. Snapshot vẫn do drizzle sinh.
ALTER TYPE "finance"."config_status" RENAME VALUE 'expired' TO 'superseded';--> statement-breakpoint
ALTER TABLE "finance"."config_versions" DROP CONSTRAINT "config_versions_effective";--> statement-breakpoint
ALTER TABLE "finance"."config_versions" DROP CONSTRAINT "config_versions_approved";--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD CONSTRAINT "config_versions_effective" CHECK ("finance"."config_versions"."status" not in ('scheduled', 'active', 'superseded') or "finance"."config_versions"."effective_from" is not null);--> statement-breakpoint
ALTER TABLE "finance"."config_versions" ADD CONSTRAINT "config_versions_approved" CHECK ("finance"."config_versions"."status" not in ('scheduled', 'active', 'superseded') or "finance"."config_versions"."approved_by" is not null);
