-- Biểu phí mẫu của nền tảng (Documents/21 §21.6): commerio_app chỉ đọc (ghi bằng role chủ bảng ở route quản trị nền tảng), dữ liệu TikTok ban đầu.
-- Bảng không có `company_id` nên không RLS (dữ liệu chuẩn dùng chung, như `channel.platform_categories`). Quyền mặc định
-- của 0002 cấp đủ SELECT, INSERT, UPDATE, DELETE cho bảng mới: thu lại phần ghi.
REVOKE INSERT, UPDATE, DELETE ON finance.fee_templates FROM commerio_app;--> statement-breakpoint
-- Số theo trang chính sách TikTok Shop VN, truy cập 21/11/2026 (`.claude/issues/luong-san-pham/tra-phi-san.md` mục 2.4):
-- hoa hồng mặc định 14% shop thường, 16% Mall (từ 03/08/2026; bảng theo ngành cấp 3 ở tệp PDF, quản trị nền tảng nhập vào
-- `categoryRates` khi có); phí giao dịch 6% (đơn từ 09/05/2026); phí xử lý đơn 3.000đ mỗi đơn giao thành công.
-- Lazada chưa có mẫu: không có trang chính thức ghi tỷ lệ phí xử lý đơn hàng, phí cố định chỉ có trong tệp theo ngành.
-- Chạy lại được (trùng sàn, loại shop thì bỏ qua).
INSERT INTO finance.fee_templates (platform, shop_type, shop_type_label, payload, sources, effective_from, note)
VALUES
  (
    'tiktok', 'standard', 'Shop thường',
    '{"fixedPct":14,"transactionPct":6,"servicePct":0,"optionalPct":0,"returnFee":0,"perItemFee":3000}'::jsonb,
    '[{"title":"Phí Hoa Hồng Nền Tảng","url":"https://seller-vn.tiktok.com/university/essay?knowledge_id=3396736626312961","updatedAt":"2026-09-30"},{"title":"Phí Giao Dịch","url":"https://seller-vn.tiktok.com/university/essay?knowledge_id=753295858337537","updatedAt":"2026-10-13"},{"title":"Phí Xử Lý Đơn Hàng","url":"https://seller-vn.tiktok.com/university/essay?knowledge_id=2968734088120080","updatedAt":"2025-10-11"}]'::jsonb,
    '2026-08-03',
    'Hoa hồng 14% là mức mặc định cho ngành không có trong bảng phí suất; ngành có trong bảng (tệp "Phí suất từ ngày 20 tháng 10 năm 2026") thì thêm dòng theo category. Phí giao dịch được giảm 0–1,5% theo bậc chi quảng cáo 30 ngày (từ 21/10/2026), mẫu để 6%. Phí xử lý đơn 3.000đ tính theo đơn, app chia cho một món. Ưu đãi shop mới (giảm 50% hoa hồng, tối đa 3%) không tính vào mẫu. Voucher Xtra (5%, tối đa 50.000đ mỗi sản phẩm) nếu tham gia thì cộng vào phí tuỳ chọn.'
  ),
  (
    'tiktok', 'mall', 'Mall',
    '{"fixedPct":16,"transactionPct":6,"servicePct":0,"optionalPct":0,"returnFee":0,"perItemFee":3000}'::jsonb,
    '[{"title":"Phí Hoa Hồng Nền Tảng","url":"https://seller-vn.tiktok.com/university/essay?knowledge_id=3396736626312961","updatedAt":"2026-09-30"},{"title":"Phí Giao Dịch","url":"https://seller-vn.tiktok.com/university/essay?knowledge_id=753295858337537","updatedAt":"2026-10-13"},{"title":"Phí Xử Lý Đơn Hàng","url":"https://seller-vn.tiktok.com/university/essay?knowledge_id=2968734088120080","updatedAt":"2025-10-11"}]'::jsonb,
    '2026-08-03',
    'Hoa hồng 16% là mức mặc định của Mall cho ngành không có trong bảng phí suất; ngành có trong bảng thì thêm dòng theo category. Phí giao dịch được giảm 0–1,5% theo bậc chi quảng cáo 30 ngày (từ 21/10/2026), mẫu để 6%. Phí xử lý đơn 3.000đ tính theo đơn, app chia cho một món. Voucher Xtra nếu tham gia thì cộng vào phí tuỳ chọn.'
  )
ON CONFLICT (platform, shop_type) DO NOTHING;
