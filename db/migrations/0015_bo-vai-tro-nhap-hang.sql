-- Bỏ vai trò có sẵn nhập hàng riêng (id ...0005, #188, chốt 02/11/2026): Nhân viên kho mang hai quyền của nó,
-- thành viên, lời mời, tài liệu trợ lý đang gắn vai trò này chuyển sang Nhân viên kho. Khớp access/domain/catalog.ts.
INSERT INTO "core"."role_permissions" ("role_id", "permission_code") VALUES
  ('00000000-0000-4000-8000-000000000004', 'purchasing.request.manage'),
  ('00000000-0000-4000-8000-000000000004', 'purchasing.return.manage');
--> statement-breakpoint
INSERT INTO "core"."member_roles" ("membership_id", "role_id", "company_id")
SELECT "membership_id", '00000000-0000-4000-8000-000000000004', "company_id" FROM "core"."member_roles"
WHERE "role_id" = '00000000-0000-4000-8000-000000000005'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "core"."member_roles" WHERE "role_id" = '00000000-0000-4000-8000-000000000005';
--> statement-breakpoint
UPDATE "core"."invitations"
SET "role_ids" = array_remove("role_ids", '00000000-0000-4000-8000-000000000005'::uuid)
  || CASE WHEN '00000000-0000-4000-8000-000000000004'::uuid = ANY("role_ids") THEN '{}'::uuid[]
          ELSE ARRAY['00000000-0000-4000-8000-000000000004'::uuid] END
WHERE '00000000-0000-4000-8000-000000000005'::uuid = ANY("role_ids");
--> statement-breakpoint
INSERT INTO "insight"."document_roles" ("document_id", "role_id", "company_id")
SELECT "document_id", '00000000-0000-4000-8000-000000000004', "company_id" FROM "insight"."document_roles"
WHERE "role_id" = '00000000-0000-4000-8000-000000000005'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "insight"."document_roles" WHERE "role_id" = '00000000-0000-4000-8000-000000000005';
--> statement-breakpoint
UPDATE "insight"."document_chunks"
SET "role_ids" = array_remove("role_ids", '00000000-0000-4000-8000-000000000005'::uuid)
  || CASE WHEN '00000000-0000-4000-8000-000000000004'::uuid = ANY("role_ids") THEN '{}'::uuid[]
          ELSE ARRAY['00000000-0000-4000-8000-000000000004'::uuid] END
WHERE '00000000-0000-4000-8000-000000000005'::uuid = ANY("role_ids");
--> statement-breakpoint
DELETE FROM "core"."roles" WHERE "id" = '00000000-0000-4000-8000-000000000005';
