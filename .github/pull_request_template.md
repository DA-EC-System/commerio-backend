## Issue

Closes #

## Thay đổi

-

## Cách kiểm

<!-- Lệnh đã chạy, mã ca trong Documents/kiem-thu/ca-theo-so-do.md đã có test (vd A1-01..A1-18, A1-04p). -->

## Checklist

- [ ] `npm run check` xanh trên máy (lint, typecheck, depcruise, test)
- [ ] Test mới nằm trong `test/`, đúng thư mục theo `test/CLAUDE.md`
- [ ] Route mới: `authorize` trước `validate`, schema response Zod đăng ký trong `api/openapi.ts`, khớp `Documents/21`
- [ ] Chuyển trạng thái đi qua khung máy trạng thái chung, bảng chuyển trùng bảng FE (`src/lib/machines`)
- [ ] Có migration thì đã chạy `npm run db:generate` và thử trên DB trống
- [ ] Không commit `.env`, khoá cổng, secret

<!--
Chốt bản phát hành (gắn tag trên main): thay checklist trên bằng điều kiện ở Documents/26-ke-hoach-kiem-thu.md §6
- [ ] CI xanh trên main ở commerio-backend và FE
- [ ] Test chạy được trên PostgreSQL 17: TEST_PG_IMAGE=pgvector/pgvector:pg17 npm test
- [ ] Không còn bug S1, S2 mở thuộc milestone
- [ ] Issue test luồng của milestone có kết quả đạt trên staging
- [ ] Không còn lệch hợp đồng API mở cho route của milestone
- [ ] QA duyệt
-->
