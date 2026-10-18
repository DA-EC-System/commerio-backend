# Staging

Bản chạy chung cho FE, demo GVHD cuối mỗi phase (#37, `Documents/21` D12, V35–V38). Ba tiến trình `api`, `worker`, `realtime` chạy cùng một image, cùng Redis, Kafka và Caddy. Database là Supabase `commerio-staging` (PostgreSQL 17, Session pooler).

```
trình duyệt ──► Caddy ─┬─ /api/v1/notification/stream* ─► realtime:3002
                       ├─ /api/*                        ─► api:3000 ─► Supabase
                       └─ /  (dist/ của FE, SPA)
```

FE và API cùng một origin nên **không bật CORS**, và cookie refresh (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity`) được trình duyệt gửi kèm. Chỉ Caddy mở cổng ra ngoài; `/metrics`, cổng vận hành, Redis, Kafka chỉ ở mạng nội bộ của compose.

## Khi merge vào `develop`

Workflow `.github/workflows/deploy-staging.yml` chạy tuần tự, job trước đỏ thì job sau không chạy:

| Job | Việc |
|---|---|
| `check` | `npm run check` |
| `image` | Build `linux/amd64` + `linux/arm64`, đẩy `ghcr.io/da-ec-system/commerio-backend:sha-<7 ký tự>` (nhãn `org.opencontainers.image.revision` = commit) |
| `migrate` | Từ runner: `npm run db:migrate` rồi `npm run db:seed` lên Supabase (image không có `drizzle-kit`, V36) |
| `tag-develop` | Gắn tag `develop` cho image vừa build, chỉ sau khi migration xanh |
| `deploy` | SSH vào VPS, ghi `.env`, `docker compose pull && up -d --wait`. **Bỏ qua khi chưa đặt biến `STAGING_SSH_HOST`** (chưa có VPS) |

Hai lần merge sát nhau: lần sau chờ lần trước xong; commit ở giữa có thể không có image riêng.

### Secret và biến của repo (Settings → Secrets and variables → Actions)

| Tên | Loại | Khi nào cần | Giá trị |
|---|---|---|---|
| `STAGING_DATABASE_URL` | secret | ngay | Chuỗi Session pooler (cổng 5432) của **user `postgres.<mã project>`**, cùng user đã chạy migration 0003 |
| `STAGING_SEED_PASSWORD` | secret | ngay | Mật khẩu chung của 4 tài khoản demo, ít nhất 8 ký tự, có cả chữ và số (cùng luật với đăng ký; seed chỉ kiểm độ dài) |
| `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SITE_ADDRESS`, `STAGING_GHCR_USER` | biến | có VPS | IP/tên máy, user SSH, tên miền cho Caddy, tài khoản GitHub sở hữu `GHCR_PULL_TOKEN` |
| `STAGING_SSH_KEY`, `STAGING_SSH_KNOWN_HOSTS` | secret | có VPS | Khoá riêng deploy, dòng `ssh-keyscan <host>` |
| `STAGING_JWT_PRIVATE_KEY`, `STAGING_JWT_PUBLIC_KEY` | secret | có VPS | Cặp Ed25519 dạng PEM, xuống dòng viết `\n` |
| `GHCR_PULL_TOKEN` | secret | có VPS | PAT `read:packages` để VPS kéo image private |

## Dữ liệu demo

`npm run db:seed` (`db/seed/`): công ty "Công ty Demo Commerio" và bốn tài khoản `ceo@`, `admin@`, `sale@`, `kho@commerio.dev` với vai trò có sẵn tương ứng, mật khẩu là `SEED_PASSWORD`. Chạy lại không sinh trùng, thiếu thì bù. Dừng với mã lỗi nếu một email demo đã thuộc người hay công ty khác (ví dụ ai đó tự đăng ký `ceo@commerio.dev` với mật khẩu khác). Seed nhận ra tài khoản CEO của mình bằng mật khẩu, nên **đổi `STAGING_SEED_PASSWORD` thì phải đổi mật khẩu cả bốn tài khoản demo theo** (đăng nhập, đổi mật khẩu); không thì job `migrate` đỏ và chặn deploy. Sản phẩm, kho thêm vào seed khi có #12, #16.

## Chạy staging trên máy (trước khi có VPS)

Cần Docker Desktop. Tất cả lệnh chạy ở gốc repo backend.

1. **Image:** sau khi merge, kéo image của CI (`gh auth refresh -s read:packages`, rồi `gh auth token | docker login ghcr.io -u <tài khoản> --password-stdin`). Thử nhánh chưa merge thì tự build:
   ```bash
   docker build -f deploy/docker/Dockerfile --label org.opencontainers.image.revision=$(git rev-parse HEAD) -t commerio-backend:local .
   ```
2. **FE:** build từ `origin/develop` của repo FE, ngoài cây làm việc của FE:
   ```bash
   mkdir -p /tmp/fe && git -C ../FE fetch && git -C ../FE archive origin/develop | tar -x -C /tmp/fe
   (cd /tmp/fe && pnpm install --frozen-lockfile && pnpm build)   # để trống VITE_API_BASE_URL, VITE_USE_MOCKS
   ```
3. **Cấu hình:** `cp deploy/staging/.env.example deploy/staging/.env` rồi điền `DATABASE_URL`, cặp khoá JWT, `FE_DIST=/tmp/fe/dist`; image tự build thì `IMAGE=commerio-backend`, `IMAGE_TAG=local`. Trước khi merge, trỏ DB Docker của máy (`postgres://commerio:commerio@host.docker.internal:5432/commerio_<n>`), không trỏ Supabase: staging chỉ nhận code đã merge.
4. **Chạy:** `docker compose -f deploy/staging/compose.yaml up -d --wait`, mở `http://localhost:8037`. Chrome nhận cookie `Secure` trên `http://localhost` nên không cần HTTPS; mở qua IP LAN của máy thì cookie refresh không được lưu.
5. **Tắt:** `docker compose -f deploy/staging/compose.yaml down` (project `commerio-staging`, không đụng `deploy/compose.yaml` của máy dev).

## Xem trạng thái, log, deploy lại

- **Trạng thái deploy:** tab Actions, workflow "Deploy staging" (hoặc `gh run list -w deploy-staging.yml`). Image: `docker buildx imagetools inspect ghcr.io/da-ec-system/commerio-backend:develop`.
- **Tình trạng tiến trình:** `docker compose -f deploy/staging/compose.yaml ps` (trên VPS: `cd /opt/commerio && docker compose ps`); `api`, `worker`, `realtime` phải `healthy`. Image đang chạy ứng với commit nào: `docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' commerio-staging-api-1`.
- **Log:** `docker compose -f deploy/staging/compose.yaml logs -f api worker realtime` (thêm `--since 1h` để giới hạn).
- **Deploy lại một commit cũ:**
  - Trên máy hay VPS: đặt `IMAGE_TAG=sha-<7 ký tự>` trong `.env` rồi `docker compose up -d --wait`.
  - Qua CI: mở run của commit đó trong Actions → "Re-run all jobs" (trong 30 ngày kể từ run gốc).
  - Chỉ lùi được code, **không lùi schema**: migration đã chạy vẫn giữ. Migration mới phải tương thích với code của bản trước một bước.

## Khi có VPS

1. Cài Docker; mở cổng 22, 80, 443 ở cả tường lửa nhà cung cấp lẫn trên máy; trỏ tên miền về IP.
2. Tạo user deploy, đặt khoá công khai tương ứng `STAGING_SSH_KEY`; tạo `/opt/commerio` thuộc user đó.
3. Thêm các secret và biến "có VPS" ở bảng trên. Lần merge sau, job `deploy` tự chạy.
4. FE lên VPS bằng workflow của repo FE (Khoa): build `dist/` rồi chép vào `/opt/commerio/site`.

## Supabase

Gói Free tạm dừng project sau 7 ngày không dùng: vào dashboard bấm Restore. Không chạy `Documents/erd/supabase-*.sql` lên database này.
