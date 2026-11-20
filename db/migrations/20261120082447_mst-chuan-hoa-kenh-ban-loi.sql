-- #459: chuẩn hoá mã số thuế công ty, đặt NULL mã sai định dạng hoặc trùng (giữ công ty cũ nhất), bật Kênh bán (phân hệ lõi) cho mọi công ty.
-- Chạy trước migration sinh thêm UNIQUE `companies_tax_code_unique`. Chạy lại được.
ALTER TABLE "core"."companies" ALTER COLUMN "tax_code" DROP NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  invalid_count int;
  duplicate_count int;
BEGIN
  -- Cùng luật với src/modules/core/platform/domain/tax-code.ts: 10 số, 12 số, 13 số lưu dạng 0123456789-001.
  WITH normalized AS (
    SELECT id, regexp_replace(tax_code, '[[:space:].-]', '', 'g') AS digits
    FROM core.companies
    WHERE tax_code IS NOT NULL
  )
  UPDATE core.companies c
  SET tax_code = CASE
      WHEN n.digits ~ '^([0-9]{10}|[0-9]{12})$' THEN n.digits
      WHEN n.digits ~ '^[0-9]{13}$' THEN left(n.digits, 10) || '-' || right(n.digits, 3)
    END
  FROM normalized n
  WHERE c.id = n.id
    AND c.tax_code IS DISTINCT FROM CASE
      WHEN n.digits ~ '^([0-9]{10}|[0-9]{12})$' THEN n.digits
      WHEN n.digits ~ '^[0-9]{13}$' THEN left(n.digits, 10) || '-' || right(n.digits, 3)
    END;
  GET DIAGNOSTICS invalid_count = ROW_COUNT;

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY tax_code ORDER BY created_at, id) AS rn
    FROM core.companies
    WHERE tax_code IS NOT NULL
  )
  UPDATE core.companies c
  SET tax_code = NULL
  FROM ranked r
  WHERE c.id = r.id AND r.rn > 1;
  GET DIAGNOSTICS duplicate_count = ROW_COUNT;

  RAISE NOTICE '#459 tax_code: % dòng đổi khi chuẩn hoá (gồm dòng sai định dạng thành NULL), % dòng trùng đặt NULL',
    invalid_count, duplicate_count;
END $$;--> statement-breakpoint
INSERT INTO "core"."company_modules" ("company_id", "module_code", "enabled")
SELECT "id", 'channel', true FROM "core"."companies"
ON CONFLICT ("company_id", "module_code") DO UPDATE SET "enabled" = true;
