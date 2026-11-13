-- #230: `tax_rules` thêm `outputVatPct` (thuế suất GTGT đầu ra của doanh nghiệp, Documents/21 §21.4). Phiên bản đã có
-- (soạn trước khi có trường này) điền 0: không đổi cách tính cho tới khi soạn phiên bản mới. Chạy lại được.
UPDATE "finance"."config_versions"
SET "payload" = "payload" || '{"outputVatPct": 0}'::jsonb
WHERE "kind" = 'tax_rules' AND NOT ("payload" ? 'outputVatPct');
