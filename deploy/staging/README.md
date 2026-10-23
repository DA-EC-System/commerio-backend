# Staging

Bản chạy chung cho FE, demo GVHD cuối mỗi phase (#37, `Documents/21` D12, V35–V38). Chạy trên k3s của VPS bằng `deploy/k8s/overlays/vps` (cài đặt: `deploy/k8s/README.md`, mục "Lên VPS"). Ba tiến trình `api`, `worker`, `realtime` cùng một image, FE là image của repo FE, cùng Kafka, Caddy, Prometheus và Grafana. Database là Supabase `commerio-staging` (PostgreSQL 17, Session pooler).

```
trình duyệt ──► Caddy ─┬─ /api/v1/notification/stream* ─► realtime:3002
                       ├─ /api/*                        ─► api:3000 ─► Supabase
                       ├─ /mock/*  (bỏ tiền tố)         ─► fe-mock:80 (SPA, MSW, dữ liệu giả)
                       └─ /                             ─► fe:80 (SPA, gọi backend thật)
```

FE và API cùng một origin nên **không bật CORS**, và cookie refresh (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity`) được trình duyệt gửi kèm. Chỉ Caddy mở cổng ra ngoài (80, 443); `/metrics`, Prometheus, Grafana, Kafka chỉ ở mạng của cluster. Cổng 6443 của k3s không mở ra ngoài.

## Khi merge vào `develop`

Workflow `.github/workflows/deploy-staging.yml` chạy tuần tự, job trước đỏ thì job sau không chạy:

| Job | Việc |
|---|---|
| `check` | `npm run check` |
| `image` | Build `linux/amd64` + `linux/arm64`, đẩy `ghcr.io/da-ec-system/commerio-backend:sha-<7 ký tự>` (nhãn `org.opencontainers.image.revision` = commit) |
| `migrate` | Từ runner: `npm run db:migrate` rồi `npm run db:seed` lên Supabase (image không có `drizzle-kit`, V36) |
| `tag-develop` | Gắn tag `develop` cho image vừa build, chỉ sau khi migration xanh |
| `deploy` | SSH vào `ci-deploy@<VPS>` gửi tag; VPS chạy `commerio-deploy backend`: `kubectl set image` cho `api`, `worker`, `realtime` rồi chờ rollout. **Bỏ qua khi chưa đặt biến `STAGING_SSH_HOST`** |

Repo FE có workflow cùng tên: build hai image `ghcr.io/da-ec-system/commerio-fe:sha-<7 ký tự>` (gọi backend thật) và `commerio-fe-mock:sha-<7 ký tự>` (MSW, `/mock/`), rồi `commerio-deploy fe` đổi image của Deployment `fe` và `fe-mock`.

Hai lần merge sát nhau: lần sau chờ lần trước xong; commit ở giữa có thể không có image riêng.

### Secret và biến của repo (Settings → Secrets and variables → Actions)

| Tên | Loại | Giá trị |
|---|---|---|
| `STAGING_DATABASE_URL` | secret | Chuỗi Session pooler (cổng 5432) của **user `postgres.<mã project>`**, cùng user đã chạy migration 0003 |
| `STAGING_SEED_PASSWORD` | secret | Mật khẩu chung của 4 tài khoản demo, ít nhất 8 ký tự, có cả chữ và số (cùng luật với đăng ký; seed chỉ kiểm độ dài) |
| `STAGING_SSH_HOST`, `STAGING_SSH_USER` | biến | IP của VPS, `ci-deploy` |
| `STAGING_SSH_KEY`, `STAGING_SSH_KNOWN_HOSTS` | secret | Khoá riêng `ci-deploy-backend` do `ci-deploy/setup.sh` sinh, dòng `ssh-keyscan -t ed25519 <host>` |

`DATABASE_URL` và cặp khoá JWT mà ứng dụng dùng **không** đi qua CI: chúng nằm trong `deploy/k8s/overlays/vps/.env` trên VPS (Secret `app-env`). Đổi giá trị thì sửa file đó rồi `kubectl apply -k deploy/k8s/overlays/vps` và `kubectl -n commerio rollout restart deploy/api deploy/worker deploy/realtime`.

## Dữ liệu demo

`npm run db:seed` (`db/seed/`): công ty "Công ty Demo Commerio" và bốn tài khoản `ceo@`, `admin@`, `sale@`, `kho@commerio.dev` với vai trò có sẵn tương ứng, mật khẩu là `SEED_PASSWORD`. Chạy lại không sinh trùng, thiếu thì bù. Dừng với mã lỗi nếu một email demo đã thuộc người hay công ty khác (ví dụ ai đó tự đăng ký `ceo@commerio.dev` với mật khẩu khác). Seed nhận ra tài khoản CEO của mình bằng mật khẩu, nên **đổi `STAGING_SEED_PASSWORD` thì phải đổi mật khẩu cả bốn tài khoản demo theo** (đăng nhập, đổi mật khẩu); không thì job `migrate` đỏ và chặn deploy. Sản phẩm, kho thêm vào seed khi có #12, #16.

## Chạy giống staging trên máy

Dùng `deploy/k8s/overlays/local` trên Kubernetes của Docker Desktop (`deploy/k8s/README.md`, mục "Chạy trên máy").

## Xem trạng thái, log, deploy lại

Các lệnh dưới chạy trên VPS bằng root (`K="kubectl -n commerio"`).

- **Trạng thái deploy:** tab Actions, workflow "Deploy staging" của từng repo (hoặc `gh run list -w deploy-staging.yml`).
- **Tình trạng tiến trình:** `$K get pods`; mọi pod `1/1 Running`. Image đang chạy: `$K get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image`.
- **Log:** `$K logs deploy/api -f` (tương tự `worker`, `realtime`, `fe`, `caddy`; thêm `--since=1h` để giới hạn).
- **Deploy lại một commit cũ:**
  - Qua CI: mở run của commit đó trong Actions → "Re-run all jobs" (trong 30 ngày kể từ run gốc).
  - Trên VPS: `$K set image deploy/api api=ghcr.io/da-ec-system/commerio-backend:sha-<7 ký tự>` (tương tự `worker`, `realtime`), hoặc `$K rollout undo deploy/<tên>` để về bản ngay trước.
  - Chỉ lùi được code, **không lùi schema**: migration đã chạy vẫn giữ. Migration mới phải tương thích với code của bản trước một bước.

## Supabase

Gói Free tạm dừng project sau 7 ngày không dùng: vào dashboard bấm Restore. Không chạy `Documents/erd/supabase-*.sql` lên database này.
