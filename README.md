# commerio-backend

Backend của Commerio, hệ thống thương mại điện tử doanh nghiệp (đồ án chuyên ngành). Kiến trúc modular monolith: một mã nguồn, 6 module lớn (19 module con), ba tiến trình `api`, `worker`, `realtime` dùng chung một image.

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

### Chạy đủ ba tiến trình

`npm run dev` chỉ bật `api`. Muốn chạy đủ thì mở thêm hai terminal:

| Lệnh | Tiến trình | Dùng để | Cổng (mặc định) |
|---|---|---|---|
| `npm run dev` | `api` | REST, Swagger | `API_PORT` 3000, `API_OPS_PORT` 9464 (`/metrics`) |
| `npm run dev:worker` | `worker` | Việc nền: relay outbox, consumer Kafka, tra cứu thanh toán quá hạn, dựng báo cáo | `WORKER_PORT` 3001 (`/health`, `/metrics`) |
| `npm run dev:realtime` | `realtime` | Kênh SSE thông báo `/api/v1/notification/stream` | `REALTIME_PORT` 3002, `REALTIME_OPS_PORT` 3003 (`/health`, `/metrics`) |

Chỉ thử API thì `api` là đủ. Thiếu `worker` thì sự kiện giữa module không được chuyển đi và thanh toán quá hạn không được tra lại; thiếu `realtime` thì không có thông báo thời gian thực.

`api` và `realtime` phải dùng chung cặp `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` trong `.env`. Thiếu thì mỗi tiến trình tự sinh khoá riêng, token do `api` cấp bị stream trả 401. Lệnh sinh khoá ở mục [Chạy song song nhiều worktree](#chạy-song-song-nhiều-worktree), chạy một lần.

### Dữ liệu demo và đăng nhập

Thêm `SEED_PASSWORD=<ít nhất 8 ký tự>` vào `.env`, rồi:

```bash
npm run db:seed       # công ty "Công ty Demo Commerio", chạy lại không sinh trùng
```

Seed tạo bốn tài khoản `ceo@`, `admin@`, `sale@`, `kho@bk.demo`, mật khẩu là `SEED_PASSWORD`. Trong Swagger (`/api/docs`):

1. `POST /api/v1/identity/login` với email và mật khẩu, lấy `accessToken`.
2. `POST /api/v1/identity/select-company` với `companyId` trong `memberships`, lấy `accessToken` mới gắn công ty.
3. Bấm **Authorize**, dán token ở bước 2.

Cần quyền đủ để thử mọi API thì dùng `ceo@bk.demo`.

### Đăng nhập Google

`POST /api/v1/identity/google` nhận ID token lấy từ Google Identity Services, chỉ đăng nhập tài khoản đã có (liên kết theo email đã xác minh ở lần đầu), không tạo tài khoản. Cần một OAuth client ID:

1. Vào Google Cloud Console, **APIs & Services → Credentials → Create credentials → OAuth client ID**, loại **Web application**.
2. **Authorized JavaScript origins**: thêm gốc của FE, vd `http://localhost:5173` cho máy dev và domain staging. Không cần redirect URI vì không làm luồng chuyển hướng.
3. Đặt `GOOGLE_CLIENT_ID=<client id>` vào `.env` của BE và cấu hình tương ứng của FE. BE không cần client secret.

Chưa đặt `GOOGLE_CLIENT_ID` thì API trả 503 `google_unavailable`; đăng nhập mật khẩu không bị ảnh hưởng.

## Cổng thanh toán

Cổng thanh toán (VNPay, MoMo, ZaloPay, VietQR) ngoài MVP: route lưu khoá cổng, tạo mã thanh toán, giao dịch cổng, mô phỏng trả tiền đã gỡ ở #235 (Documents/21 mục 12 "(bỏ)"). Webhook `<PUBLIC_API_URL>/api/v1/payment/webhooks/...` và tra cứu quá hạn còn trong code. Chi tiết: `src/modules/finance/payment/CLAUDE.md`.

## Database

Mỗi người code trên **database riêng trong Docker** ở máy mình. Cả team giống nhau nhờ chạy cùng một bộ **file migration** trong git (`db/migrations/`), không phải nhờ dùng chung một database.

```
             git: db/migrations/0000 … 0028, rồi <thời điểm sinh>_<tên>
        │ pull              │ pull              │ merge vào main
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
   npm run db:generate -- --name <mo-ta-ngan>   # sinh db/migrations/<năm tháng ngày giờ phút giây>_<mo-ta-ngan>.sql
   npm run db:migrate                            # áp lên DB máy mình
   ```
   Tên file do `drizzle-kit` đặt theo giờ UTC lúc sinh, ví dụ `20261111030018_muc-dich-tep.sql` (từ 11/11/2026; 29 file đầu `0000`–`0028` giữ tên cũ). Không đặt tên tay, không đổi tên file đã sinh.
   Commit cả file migration lẫn `db/migrations/meta/` vào PR. Thứ Drizzle không sinh được (RLS, trigger, extension) thì viết tay, xem `db/CLAUDE.md`.

3. **Không tạo hay sửa bảng bằng tay trong DataGrip.** Người khác không có thay đổi đó, và migration lần sau sẽ lệch.

4. **Không sửa file migration đã merge vào `main`.** Cần đổi thì sinh migration mới.

### Staging

- Chỉ nhận code **đã merge vào `main`**. Không ai chạy `db:migrate` lên staging từ nhánh đang làm.
- Người được giao (hiện là trưởng nhóm) chạy migration bằng file `.env.staging` riêng trên máy mình. File `.env.*` đã nằm trong `.gitignore`. Khi có CI deploy (#37), CI tự chạy migration trước mỗi lần deploy.
  ```bash
  npm run db:migrate:staging   # đọc DATABASE_URL trong .env.staging, không đụng .env
  ```
  File `.env.staging` chỉ cần một dòng `DATABASE_URL=postgresql://postgres.<mã project>:<mật khẩu>@aws-...pooler.supabase.com:5432/postgres`.
- Kết nối dùng chuỗi **Session pooler** (cổng 5432). Kết nối trực tiếp của Supabase chỉ có IPv6, mạng thường không vào được.
- Gói Free của Supabase tạm dừng project sau 7 ngày không dùng. Vào dashboard bấm Restore.
- Tài khoản test tạo trên staging thì cả team thấy chung. Đặt tên dễ nhận, ví dụ `khoa.test@bk.demo`. Chỉ dùng dữ liệu giả.
- Không chạy `Documents/erd/supabase-*.sql` lên database này. Script đó chỉ để xem ERD, sẽ đụng với migration.

### Dữ liệu

Migration chỉ đồng bộ **cấu trúc bảng** và **dữ liệu cố định** (danh mục quyền, vai trò có sẵn). Dữ liệu nhập tay không đồng bộ: trên máy, mỗi người tự đăng ký công ty test qua Swagger. Dữ liệu demo dùng chung sẽ là script seed ở `db/seed/`.

### Khi gặp sự cố

| Tình huống | Cách xử lý |
|---|---|
| Hai người cùng sinh migration trên hai nhánh | Tên file không còn trùng, nhưng `meta/_journal.json` sẽ xung đột khi rebase. Người merge sau vẫn phải xoá migration của mình (file `.sql`, snapshot, dòng journal), rebase lên `main`, chạy lại `db:generate` (lý do ở `db/CLAUDE.md`) |
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
| Sự kiện giữa module: outbox, Kafka, consumer, DLQ | [src/modules/core/platform/service/outbox/README.md](src/modules/core/platform/service/outbox/README.md) |
| Staging: chạy, secret, log, deploy lại | [deploy/staging/README.md](deploy/staging/README.md) |
| Kubernetes, Prometheus, Grafana | [deploy/k8s/README.md](deploy/k8s/README.md) |

## Nhánh

Mỗi việc đi trên `feature/<tên>` rồi mở PR vào thẳng `main`; merge vào `main` là deploy staging. Không còn nhánh `develop` (bỏ từ 29/10/2026).
