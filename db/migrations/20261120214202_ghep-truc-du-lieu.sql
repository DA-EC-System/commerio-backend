-- Ghép trục theo platform_kind cho spec có sẵn (#448, chỉ dữ liệu, chạy lại được): trục `__custom` của channel.product_specs đổi sang mã sales attribute chuẩn đầu tiên (theo attributes.platform_kind) mà leaf của spec có (kind = 'sales'), mỗi mã một trục; leaf không có mã nào thì giữ `__custom`.
-- Bảng mã chuẩn chép từ `standardSalesAttributes` của adapter (TikTok: color 100000, size 100007 rồi 100001, volume 100089, flavor 100092; Lazada: color_family, size, volume, flavor). Spec version >= 1 tăng version (người đang mở form gặp 409 thay vì đè); version 0 (bản chép chưa ai lưu) giữ nguyên.
DO $$
DECLARE
  s record;
  k text;
  kind text;
  candidates text[];
  pick text;
  used text[];
  new_map jsonb;
BEGIN
  FOR s IN
    SELECT id, platform::text AS platform, external_category_id, axis_map, version
    FROM channel.product_specs
    WHERE axis_map::text LIKE '%"__custom"%'
  LOOP
    new_map := s.axis_map;
    SELECT coalesce(array_agg(e.value), '{}') INTO used FROM jsonb_each_text(s.axis_map) e WHERE e.value <> '__custom';
    FOR k IN SELECT e.key FROM jsonb_each_text(s.axis_map) e WHERE e.value = '__custom' ORDER BY e.key LOOP
      kind := NULL;
      IF k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT a.platform_kind INTO kind FROM product.attributes a WHERE a.id = k::uuid;
      END IF;
      candidates := CASE
        WHEN s.platform = 'tiktok' AND kind = 'color' THEN ARRAY['100000']
        WHEN s.platform = 'tiktok' AND kind = 'size' THEN ARRAY['100007', '100001']
        WHEN s.platform = 'tiktok' AND kind = 'volume' THEN ARRAY['100089']
        WHEN s.platform = 'tiktok' AND kind = 'flavor' THEN ARRAY['100092']
        WHEN s.platform = 'lazada' AND kind = 'color' THEN ARRAY['color_family']
        WHEN s.platform = 'lazada' AND kind = 'size' THEN ARRAY['size']
        WHEN s.platform = 'lazada' AND kind = 'volume' THEN ARRAY['volume']
        WHEN s.platform = 'lazada' AND kind = 'flavor' THEN ARRAY['flavor']
        ELSE ARRAY[]::text[]
      END;
      SELECT c.code INTO pick
      FROM unnest(candidates) WITH ORDINALITY AS c(code, ord)
      WHERE NOT (c.code = ANY (used))
        AND EXISTS (
          SELECT 1 FROM channel.platform_category_attributes pa
          WHERE pa.platform::text = s.platform AND pa.external_category_id = s.external_category_id
            AND pa.code = c.code AND pa.kind = 'sales'
        )
      ORDER BY c.ord
      LIMIT 1;
      IF pick IS NOT NULL THEN
        new_map := jsonb_set(new_map, ARRAY[k], to_jsonb(pick));
        used := used || pick;
      END IF;
    END LOOP;
    IF new_map IS DISTINCT FROM s.axis_map THEN
      UPDATE channel.product_specs
      SET axis_map = new_map,
          version = CASE WHEN s.version >= 1 THEN s.version + 1 ELSE s.version END,
          updated_at = now()
      WHERE id = s.id;
    END IF;
  END LOOP;
END $$;
