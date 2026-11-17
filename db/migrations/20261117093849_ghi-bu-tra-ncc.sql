-- Ghi bù khoản trả NCC cho phiếu nhận đã ghi sổ trước #357 (chỉ dữ liệu, chạy lại được). Cùng luật với
-- `postSupplierPayment` (finance/domain/ledger.ts): −Σ (đạt + lỗi giữ lại) × giá dòng đề nghị, làm tròn trên tổng phiếu
-- (nửa đồng làm tròn ra xa số 0), ngày ghi sổ giờ Việt Nam, dòng thực tế nguồn `goods_receipt`; phiếu của đề nghị bù
-- hàng và phiếu tổng 0 đồng không ghi. Phiếu đã có dòng nguồn `goods_receipt` thì bỏ qua.
insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, source_type, source_id)
select r.company_id,
       'supplier_payment',
       -round(sum((l.accepted_qty + l.defective_qty) * rl.unit_price)),
       false,
       (r.posted_at at time zone 'Asia/Ho_Chi_Minh')::date,
       'goods_receipt',
       r.id
from product.goods_receipts r
join product.purchase_requests q on q.id = r.request_id
join product.goods_receipt_lines l on l.receipt_id = r.id
join product.purchase_request_lines rl on rl.id = l.request_line_id
where r.posted_at is not null
  and q.source_return_id is null
  and not exists (select 1 from finance.ledger_entries e where e.source_type = 'goods_receipt' and e.source_id = r.id)
group by r.company_id, r.id, r.posted_at
having round(sum((l.accepted_qty + l.defective_qty) * rl.unit_price)) <> 0;
