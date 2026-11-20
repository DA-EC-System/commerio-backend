-- #355: hoàn tiền khách chỉ ghi tới mức doanh thu đã ghi của các dòng trả (Documents/25 mục 10.1, E174). Trước #355,
-- `recordReturnRefunded` ghi `customer_refund` bằng đúng số sàn báo, kể cả đơn chưa có doanh thu (kiện chưa giao, COD hoàn
-- về), làm Phải thu sàn và lãi theo đơn âm. Migration này sửa dữ liệu cũ, sổ chỉ thêm: với mỗi nguồn `return_refund` có
-- dòng ước tính `customer_refund` vượt trần, thêm một dòng `adjustment` ước tính đảo phần vượt (cùng nguồn, đơn, gian
-- hàng, ngày của dòng hoàn tiền) và bật Cần xử lý của yêu cầu trả với đúng câu code ghi (`refundExcessNote`).
--
-- Trần tính đúng công thức `refundCap` (finance/domain/ledger.ts), test so hai đường
-- (test/integration/finance/finance/refund-cap-migration.test.ts): min(Σ số trả × đơn giá của dòng trả mà kiện đã có
-- doanh thu ước tính, doanh thu ước tính của đơn − tiền hoàn đã ghi của các nguồn hoàn tiền ghi trước), không âm. Đi theo
-- thứ tự ghi dòng hoàn tiền, dòng đảo vừa thêm tính vào tiền hoàn đã ghi của nguồn sau.
--
-- Chạy lại không ghi trùng: bỏ nguồn đã có dòng `adjustment`. Bỏ dòng ước tính đã được dòng thực tế của sàn thay
-- (`ledger_replacements`): sàn đã quyết toán khoản hoàn đó, số thực tế đã đúng.
DO $$
DECLARE
  r record;
  lines_revenue numeric;
  order_revenue numeric;
  refunded numeric;
  cap numeric;
  excess numeric;
  note text;
  reversed integer := 0;
BEGIN
  FOR r IN
    SELECT e.id, e.company_id, e.order_id, e.shop_id, e.source_id, e.occurred_on, e.created_at, -e.amount AS refund
    FROM finance.ledger_entries e
    WHERE e.kind = 'customer_refund'
      AND e.is_estimate
      AND e.source_type = 'return_refund'
      AND e.order_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM finance.ledger_entries a
        WHERE a.source_type = 'return_refund' AND a.source_id = e.source_id AND a.kind = 'adjustment'
      )
      AND NOT EXISTS (SELECT 1 FROM finance.ledger_replacements p WHERE p.estimate_id = e.id)
    ORDER BY e.created_at, e.id
  LOOP
    SELECT coalesce(sum(l.quantity * l.unit_price), 0) INTO lines_revenue
    FROM "order".return_request_lines l
    WHERE l.request_id = r.source_id
      AND l.package_id IN (
        SELECT v.package_id FROM finance.ledger_entries v
        WHERE v.order_id = r.order_id AND v.kind = 'revenue' AND v.is_estimate AND v.source_type = 'package' AND v.package_id IS NOT NULL
        GROUP BY v.package_id
        HAVING sum(v.amount) > 0
      );

    SELECT coalesce(sum(v.amount), 0) INTO order_revenue
    FROM finance.ledger_entries v
    WHERE v.order_id = r.order_id AND v.kind = 'revenue' AND v.is_estimate AND v.source_type = 'package' AND v.package_id IS NOT NULL;

    SELECT -coalesce(sum(x.amount), 0) INTO refunded
    FROM finance.ledger_entries x
    WHERE x.order_id = r.order_id
      AND x.is_estimate
      AND x.source_type = 'return_refund'
      AND x.kind IN ('customer_refund', 'adjustment')
      AND x.source_id IN (
        SELECT c.source_id FROM finance.ledger_entries c
        WHERE c.order_id = r.order_id AND c.kind = 'customer_refund' AND c.is_estimate AND c.source_type = 'return_refund'
          AND (c.created_at, c.id) < (r.created_at, r.id)
      );

    cap := greatest(0, least(lines_revenue, order_revenue - refunded));
    excess := r.refund - least(r.refund, cap);
    CONTINUE WHEN excess <= 0;

    INSERT INTO finance.ledger_entries
      (company_id, kind, amount, is_estimate, occurred_on, order_id, return_request_id, shop_id, source_type, source_id, reason)
    VALUES
      (r.company_id, 'adjustment', round(excess, 2), true, r.occurred_on, r.order_id, r.source_id, r.shop_id, 'return_refund', r.source_id,
       'Đảo phần hoàn tiền vượt doanh thu đã ghi của phần trả (#355)');

    note := 'Sàn báo hoàn ' || replace(to_char(round(r.refund), 'FM999,999,999,999,990'), ',', '.') || ' ₫'
      || ' vượt doanh thu đã ghi của phần trả (' || replace(to_char(round(cap), 'FM999,999,999,999,990'), ',', '.') || ' ₫)'
      || '; phần vượt ' || replace(to_char(round(excess), 'FM999,999,999,999,990'), ',', '.') || ' ₫'
      || ' không ghi sổ (kiện chưa giao hoặc COD hoàn về), đối chiếu với sàn';

    UPDATE "order".return_requests
    SET needs_attention = true,
        attention_note = CASE WHEN needs_attention AND attention_note IS NOT NULL THEN attention_note || '. ' || note ELSE note END,
        version = version + 1,
        updated_at = now()
    WHERE id = r.source_id
      AND NOT (needs_attention AND coalesce(strpos(attention_note, note), 0) > 0);

    reversed := reversed + 1;
  END LOOP;
  RAISE NOTICE '#355: đảo % dòng hoàn tiền vượt doanh thu đã ghi', reversed;
END $$;
