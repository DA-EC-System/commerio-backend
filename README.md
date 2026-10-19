# commerio-backend

Backend của Commerio, hệ thống thương mại điện tử doanh nghiệp (đồ án chuyên ngành). Kiến trúc modular monolith: một mã nguồn, 19 module, ba tiến trình `api`, `worker`, `realtime` dùng chung một image.

## Chạy trên máy

Cần Node.js 24 và Docker Desktop (đang bật).

```bash
npm install
cp .env.example .env
npm run infra:up      # PostgreSQL, Redis, Kafka trong Docker
npm run db:migrate    # tạo bảng
npm run dev           # http://localhost:3000/health, Swagger ở http://localhost:3000/api/docs
```

Kiểm tra trước khi mở PR: `npm run check` (lint, typecheck, ranh giới module, test). Test integration tự bật một PostgreSQL tạm trong Docker rồi xoá khi chạy xong, nên Docker phải đang bật.

## Database

Mỗi người code trên **database riêng trong Docker** ở máy mình. Cả team giống nhau nhờ chạy cùng một bộ **file migration** trong git (`db/migrations/`), không phải nhờ dùng chung một database.

```
             git: db/migrations/0000, 0001, 0002, ...
        │ pull              │ pull              │ merge vào develop
        ▼                   ▼                   ▼
  DB Docker máy A     DB Docker máy B     Staging (Supabase)
  code, test          code, test          FE, demo, GVHD xem
```

### Ba database

| Database | Ai dùng | Kết nối |
|---|---|---|
| Docker trên máy | Người làm backend, để code và thử | `localhost:5432`, user `commerio`, mật khẩu `commerio`, database `commerio` (khai trong `deploy/compose.yaml`, chuỗi kết nối ở `DATABASE_URL` trong `.env`) |
| Staging trên Supabase | FE, demo, xem dữ liệu chung | Chuỗi **Session pooler** do trưởng nhóm gửi riêng, không commit |
| PostgreSQL tạm khi chạy test | Vitest tự bật và xoá | Không cần làm gì |

Xem dữ liệu bằng DataGrip (hay trình quản lý DB nào cũng được): tạo kết nối PostgreSQL theo thông số trên. Mỗi module là một schema (`platform`, `identity`, `staff`, `access`, ...).

### Việc hằng ngày

1. **Kéo code mới về thì cập nhật DB:**
   ```bash
   git pull
   npm run db:migrate    # chỉ chạy những migration máy mình chưa có
   ```
   Drizzle ghi các migration đã chạy vào bảng `drizzle.__drizzle_migrations`, nên chạy lại nhiều lần không sao.

2. **Đổi bảng (thêm bảng, thêm cột):**
   ```bash
   # sửa src/modules/<module>/repository/schema.ts
   npm run db:generate -- --name <mo-ta-ngan>   # sinh db/migrations/NNNN_<mo-ta-ngan>.sql
   npm run db:migrate                            # áp lên DB máy mình
   ```
   Commit cả file migration lẫn `db/migrations/meta/` vào PR. Thứ Drizzle không sinh được (RLS, trigger, extension) thì viết tay, xem `db/CLAUDE.md`.

3. **Không tạo hay sửa bảng bằng tay trong DataGrip.** Người khác không có thay đổi đó, và migration lần sau sẽ lệch.

4. **Không sửa file migration đã merge vào `develop`.** Cần đổi thì sinh migration mới.

### Staging

- Chỉ nhận code **đã merge vào `develop`**. Không ai chạy `db:migrate` lên staging từ nhánh đang làm.
- Người được giao (hiện là trưởng nhóm) chạy migration bằng file `.env.staging` riêng trên máy mình. File `.env.*` đã nằm trong `.gitignore`. Khi có CI deploy (#37), CI tự chạy migration trước mỗi lần deploy.
  ```bash
  npm run db:migrate:staging   # đọc DATABASE_URL trong .env.staging, không đụng .env
  ```
  File `.env.staging` chỉ cần một dòng `DATABASE_URL=postgresql://postgres.<mã project>:<mật khẩu>@aws-...pooler.supabase.com:5432/postgres`.
- Kết nối dùng chuỗi **Session pooler** (cổng 5432). Kết nối trực tiếp của Supabase chỉ có IPv6, mạng thường không vào được.
- Gói Free của Supabase tạm dừng project sau 7 ngày không dùng. Vào dashboard bấm Restore.
- Tài khoản test tạo trên staging thì cả team thấy chung. Đặt tên dễ nhận, ví dụ `khoa.test@commerio.dev`. Chỉ dùng dữ liệu giả.
- Không chạy `Documents/erd/supabase-*.sql` lên database này. Script đó chỉ để xem ERD, sẽ đụng với migration.

### Dữ liệu

Migration chỉ đồng bộ **cấu trúc bảng** và **dữ liệu cố định** (danh mục quyền, vai trò có sẵn). Dữ liệu nhập tay không đồng bộ: trên máy, mỗi người tự đăng ký công ty test qua Swagger. Dữ liệu demo dùng chung sẽ là script seed ở `db/seed/`.

### Khi gặp sự cố

| Tình huống | Cách xử lý |
|---|---|
| Hai người cùng sinh migration trên hai nhánh, trùng số | Người merge sau xoá migration của mình, rebase lên `develop`, chạy lại `db:generate` |
| DB trên máy rối, migrate lỗi | `docker compose -f deploy/compose.yaml down -v`, rồi `npm run infra:up` và `npm run db:migrate`. Chỉ mất dữ liệu test trên máy mình |
| `npm test` hoặc `infra:up` báo không kết nối được Docker | Mở Docker Desktop, chờ chạy xong rồi thử lại |
| Cổng 5432 đã bị chiếm | Máy đang có PostgreSQL khác. Tắt nó, hoặc đổi cổng trong `deploy/compose.yaml` và `DATABASE_URL` cho khớp |

## Chạy song song nhiều worktree

Khi nhiều nhánh làm cùng lúc trên một máy (mỗi nhánh một `git worktree`), các bản dùng chung một bộ Docker (`npm run infra:up` một lần) nhưng mỗi bản một cổng, một database, một tiền tố topic Kafka:

| Worktree | `API_PORT` | `API_OPS_PORT` | `WORKER_PORT` | `REALTIME_PORT` | `REALTIME_OPS_PORT` | Database | `KAFKA_TOPIC_PREFIX` |
|---|---|---|---|---|---|---|---|
| gốc | 3000 | 9464 | 3001 | 3002 | 3003 | `commerio` | `commerio` |
| n = 1..5 | 3000+100n | 9464+n | 3001+100n | 3002+100n | 3003+100n | `commerio_<n>` | `commerio-w<n>` |

Một lần, trong `.env` của bản gốc: thêm cặp khoá JWT. Thiếu khoá thì mỗi tiến trình tự sinh khoá riêng, nên token do `api` cấp bị `realtime` (kênh thông báo) trả 401.

```bash
node -e 'console.log(); const { generateKeyPairSync } = require("node:crypto"); const k = generateKeyPairSync("ed25519"); const line = (n, p) => console.log(n + "=" + JSON.stringify(p.trim())); line("JWT_PRIVATE_KEY", k.privateKey.export({ type: "pkcs8", format: "pem" })); line("JWT_PUBLIC_KEY", k.publicKey.export({ type: "spki", format: "pem" }));' >> .env
```

Với worktree n:

```bash
cp ../backend/.env .env    # .env không theo git, worktree mới chưa có (kèm khoá JWT ở trên); sửa cổng, DATABASE_URL, KAFKA_TOPIC_PREFIX theo bảng
docker compose -f deploy/compose.yaml exec postgres createdb -U commerio commerio_<n>
npm run db:migrate
```

Role `commerio_app` ở mức cụm, migration `0003` tạo lại an toàn. Test integration không cần gì thêm (mỗi lượt một container riêng). Prometheus chỉ lấy số liệu của bản gốc.

## Tài liệu khác

| Chủ đề | File |
|---|---|
| Kiến trúc, luật ranh giới, quy ước code | [CLAUDE.md](CLAUDE.md), và `CLAUDE.md` của [src/](src/CLAUDE.md), [src/entrypoints/](src/entrypoints/CLAUDE.md), [src/modules/](src/modules/CLAUDE.md) (module đã có nghiệp vụ có thêm file riêng), [src/shared/](src/shared/CLAUDE.md), [db/](db/CLAUDE.md), [test/](test/CLAUDE.md), [deploy/](deploy/CLAUDE.md) |
| Sự kiện giữa module: outbox, Kafka, consumer, DLQ | [src/modules/platform/service/outbox/README.md](src/modules/platform/service/outbox/README.md) |
| Staging: chạy, secret, log, deploy lại | [deploy/staging/README.md](deploy/staging/README.md) |
| Kubernetes, Prometheus, Grafana | [deploy/k8s/README.md](deploy/k8s/README.md) |

## Nhánh

Theo Git Flow: `main` là bản phát hành, `develop` là nhánh tích hợp, mỗi việc đi trên `feature/<tên>` rồi mở PR vào `develop`.
