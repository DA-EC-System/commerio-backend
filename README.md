# commerio-backend

Backend của Commerio, hệ thống thương mại điện tử doanh nghiệp (đồ án chuyên ngành). Kiến trúc modular monolith: một mã nguồn, 19 module, ba tiến trình `api`, `worker`, `realtime` dùng chung một image.

## Chạy trên máy

Cần Node.js 24 và Docker.

```bash
npm install
cp .env.example .env
npm run infra:up      # PostgreSQL, Redis, Kafka
npm run db:migrate
npm run dev           # http://localhost:3000/health
```

Kiểm tra trước khi mở PR: `npm run check` (lint, typecheck, ranh giới module, test).

## Nhánh

Theo Git Flow: `main` là bản phát hành, `develop` là nhánh tích hợp, mỗi việc đi trên `feature/<tên>` rồi mở PR vào `develop`.
