-- Khớp sao kê chỉ thêm như sổ tiền (#235; Documents/21 mục 21.1: `bankMatch` lưu ở bảng riêng, sổ chỉ thêm): role ứng
-- dụng ghi được một lần, không sửa, không xoá. Khớp nhầm thì thêm dòng `adjustment` ở sổ, không sửa dòng khớp.
REVOKE UPDATE, DELETE ON finance.bank_matches FROM commerio_app;
