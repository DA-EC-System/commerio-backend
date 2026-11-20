-- #459: lần đăng ký chờ mã chỉ luồng đăng ký (role chủ bảng, ngoài withCompany) đụng tới; commerio_app không có quyền nào.
REVOKE ALL ON core.registrations FROM commerio_app;
