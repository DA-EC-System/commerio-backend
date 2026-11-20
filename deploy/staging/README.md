# Staging

Bản chạy chung cho FE, demo GVHD cuối mỗi phase (#37, `Documents/21` D12, V35–V38). Chạy trên k3s của VPS bằng `deploy/k8s/overlays/vps` (cài đặt: `deploy/k8s/README.md`, mục "Lên VPS"). Ba tiến trình `api`, `worker`, `realtime` cùng một image, FE là image của repo FE, cùng Kafka, Caddy, Prometheus và Grafana. Database là Supabase `commerio-staging` (PostgreSQL 17, Session pooler).

```
trình duyệt ──► Caddy ─┬─ /api/v1/notification/stream* ─► realtime:3002
                       ├─ /api/*                        ─► api:3000 ─► Supabase
                       └─ /                             ─► fe:80 (SPA, gọi backend thật)
```

FE và API cùng một origin nên **không bật CORS**, và cookie refresh (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity`) được trình duyệt gửi kèm. Chỉ Caddy mở cổng ra ngoài (80, 443); `/metrics`, Prometheus, Grafana, Kafka chỉ ở mạng của cluster. Cổng 6443 của k3s không mở ra ngoài.

## Khi merge vào `main`

Workflow `.github/workflows/deploy-staging.yml` chạy tuần tự, job trước đỏ thì job sau không chạy:

| Job | Việc |
|---|---|
| `check` | Gọi `.github/workflows/test-suite.yml` (cùng bộ với CI): job `static` (`db:ci-check`, lint, typecheck, depcruise) và `npm test` chia 3 phần chạy song song (`test (phần n/3)`, `vitest --shard`) |
| `image` | Build `linux/amd64` + `linux/arm64`, đẩy `ghcr.io/da-ec-system/commerio-backend:sha-<7 ký tự>` (nhãn `org.opencontainers.image.revision` = commit) |
| `migrate` | Từ runner: `npm run db:migrate` rồi `npm run db:seed` lên Supabase (image không có `drizzle-kit`, V36). `db:migrate` dừng, không chạy gì, nếu có migration lệch thứ tự (`db/CLAUDE.md`) |
| `tag-develop` | Gắn tag `develop` cho image vừa build, chỉ sau khi migration xanh |
| `deploy` | SSH vào `ci-deploy@<VPS>` gửi tag; VPS chạy `commerio-deploy backend`: blue-green cho `api`, `realtime` (bật màu nghỉ với image mới, chờ sẵn sàng, chuyển Service, tắt màu cũ), rolling update cho `worker` (`deploy/k8s/README.md`). **Bỏ qua khi chưa đặt biến `STAGING_SSH_HOST`** |
| `blackbox` | `npm run test:blackbox` gọi vào `STAGING_API_URL` bằng tài khoản QA. **Bỏ qua khi chưa đặt biến `STAGING_API_URL`** (hoặc khi `deploy` bị bỏ qua) |

Repo FE có workflow cùng tên: build image `ghcr.io/da-ec-system/commerio-fe:sha-<7 ký tự>` (gọi backend thật), rồi `commerio-deploy fe` đổi image của Deployment `fe`.

Hai lần merge sát nhau: lần sau chờ lần trước xong; commit ở giữa có thể không có image riêng.

### Secret và biến của repo (Settings → Secrets and variables → Actions)

| Tên | Loại | Giá trị |
|---|---|---|
| `STAGING_DATABASE_URL` | secret | Chuỗi Session pooler (cổng 5432) của **user `postgres.<mã project>`**, cùng user đã chạy migration 0003 |
| `STAGING_SEED_PASSWORD` | secret | Mật khẩu chung của 4 tài khoản demo, ít nhất 8 ký tự, có cả chữ và số (cùng luật với đăng ký; seed chỉ kiểm độ dài) |
| `STAGING_SSH_HOST`, `STAGING_SSH_USER` | biến | IP của VPS, `ci-deploy` |
| `STAGING_SSH_KEY`, `STAGING_SSH_KNOWN_HOSTS` | secret | Khoá riêng `ci-deploy-backend` do `ci-deploy/setup.sh` sinh, dòng `ssh-keyscan -t ed25519 <host>` |
| `STAGING_API_URL` | biến | Gốc của staging, vd `https://<tên miền>` (không có `/api`). Có thì job `blackbox` chạy bộ test hộp đen (#120) sau `deploy` |

`DATABASE_URL`, cặp khoá JWT và khoá kho tệp mà ứng dụng dùng **không** đi qua CI: chúng nằm trong `deploy/k8s/overlays/vps/.env` trên VPS (Secret `app-env`). Thư (#350) đi qua Brevo: `SMTP_URL`, `MAIL_FROM`, xem mục "Gửi thư". Kho tệp (#212) là Cloudflare R2: điền các biến `S3_*` theo `.env.example`, với `S3_KEY_PREFIX=staging` để tệp staging không lẫn với tệp máy dev trên cùng bucket. Thiếu thì api vẫn chạy, chỉ `POST /files/uploads` trả 503 `storage_unavailable`. Đổi giá trị thì sửa file đó rồi `kubectl apply -k deploy/k8s/overlays/vps` và `kubectl -n commerio rollout restart deploy/api deploy/worker deploy/realtime`.

## Gửi thư (Brevo)

Worker gửi thư mã OTP, thư báo người duyệt và thư báo kết quả của luồng mời nhân viên (#350) qua SMTP của Brevo, gói Free (300 thư/ngày). Thiếu `SMTP_URL`, `MAIL_FROM` thì người được mời không nhận được mã, log worker ghi "chưa cấu hình SMTP_URL hoặc MAIL_FROM".

1. Brevo → Senders, domains, IPs → **Senders**: thêm địa chỉ gửi, mở thư xác minh. Chờ trạng thái **Verified**.
2. Brevo → **SMTP & API** → tab SMTP: lấy Login (dạng `<mã>@smtp-brevo.com`) và tạo SMTP key.
3. Thêm vào `deploy/k8s/overlays/vps/.env` trên VPS (viết `@` trong login thành `%40`):
   ```
   SMTP_URL=smtp://<login>%40smtp-brevo.com:<smtp-key>@smtp-relay.brevo.com:587
   MAIL_FROM=Commerio <địa chỉ đã Verified>
   ```
4. Áp vào Secret `app-env` như đoạn trên, rồi `kubectl -n commerio rollout restart deploy/worker` (chỉ worker gửi thư).
5. Kiểm: `kubectl -n commerio logs deploy/worker | grep SMTP` có "SMTP dùng được"; tạo link mời, xin mã, thư tới trong vòng một phút. Người nhận thấy người gửi là `<địa chỉ>@<mã>.brevosend.com` vì địa chỉ Gmail không có bản ghi domain; muốn đẹp hơn thì xác thực domain riêng ở Brevo.

Đã làm trên staging ngày 17/11/2026 với địa chỉ gửi của nhóm.

## Mã thử đăng ký (#459)

E2E trên staging (FE `e2e/be`, Bình ở #191) không đọc được hộp thư, nên dùng mã thử: email thuộc miền thử nhận mã cố định thay cho thư (`Documents/21` mục 2.1). Chỉ đặt ở staging, **không đặt ở production**. Không ghi giá trị vào repo, issue hay PR.

1. Thêm vào `deploy/k8s/overlays/vps/.env` trên VPS:
   ```
   APP_ENV=staging
   REGISTRATION_TEST_EMAIL_DOMAIN=<miền đuôi .test, .invalid hoặc .example>
   REGISTRATION_TEST_CODE=<6 chữ số>
   ```
   Mã **không** dùng `246810`: giá trị đó là mã test ghi công khai trong `vitest.config.ts`. Đặt thiếu một biến, miền sai đuôi, mã không đủ 6 số hoặc `APP_ENV` khác `staging`/`test` thì api, worker không khởi động (`registrationTestIssues`, `src/shared/config/env.ts`).
2. Áp vào Secret `app-env` như đoạn đầu trang, rồi `kubectl -n commerio rollout restart deploy/api deploy/worker deploy/realtime` (api kiểm cấu hình lúc khởi động, worker ghi mã thử).
3. Đặt cùng giá trị cho hai secret của repo FE: `E2E_REGISTRATION_TEST_EMAIL_DOMAIN`, `E2E_REGISTRATION_TEST_CODE` (job `e2e-be`).
4. Kiểm: đăng ký trên staging bằng email thuộc miền thử, nhập mã thử thì vào thẳng công ty; log worker có "lần đăng ký thử: đã đặt mã thử" và không có mã.

Đổi mã thì đổi cả ba chỗ (VPS, hai secret của FE) cùng lúc.

## Cảnh báo qua email

Prometheus tính các luật ở `deploy/monitoring/rules/alerts.yml` (tiến trình chết, lỗi 5xx, outbox kẹt, SMTP hỏng, VPS đầy đĩa…) và gửi cảnh báo sang Alertmanager (`deploy/k8s/overlays/vps/alertmanager.yaml`). Alertmanager gửi email qua cùng SMTP Brevo ở trên, kèm email "đã hết" khi cảnh báo tự hết.

1. Trên VPS, chép `deploy/k8s/overlays/vps/alertmanager/alertmanager.yml.example` thành `alertmanager.yml` cùng thư mục (đã gitignore), điền `smtp_from` (địa chỉ đã Verified), `smtp_auth_username`, `smtp_auth_password` (login và SMTP key như `SMTP_URL`, không mã hoá `%40`), `to` (hộp thư nhận cảnh báo).
2. Áp manifest như đoạn "Secret và biến của repo" (Secret `alertmanager-config`, Deployment `alertmanager`, ConfigMap Prometheus mới).
3. Kiểm: `kubectl -n commerio exec deploy/prometheus -- wget -qO- localhost:9090/api/v1/alertmanagers` có `alertmanager:9093` trong `activeAlertmanagers`. Thử gửi một cảnh báo giả: `kubectl -n commerio exec deploy/alertmanager -- amtool alert add ThuCanhBao severity=warning --annotation=summary="Thử kênh cảnh báo" --alertmanager.url=http://localhost:9093`, email tới sau khoảng 30 giây.

## Dữ liệu demo

`npm run db:seed` (`db/seed/`): công ty "Công ty Demo Commerio" và bốn tài khoản `ceo@`, `admin@`, `sale@`, `kho@bk.demo` với vai trò có sẵn tương ứng, mật khẩu là `SEED_PASSWORD`. Chạy lại không sinh trùng, thiếu thì bù. Dừng với mã lỗi nếu một email demo đã thuộc người hay công ty khác (ví dụ ai đó tự đăng ký `ceo@bk.demo` với mật khẩu khác). Seed nhận ra tài khoản CEO của mình bằng mật khẩu, nên **đổi `STAGING_SEED_PASSWORD` thì phải đổi mật khẩu cả bốn tài khoản demo theo** (đăng nhập, đổi mật khẩu); không thì job `migrate` đỏ và chặn deploy. Sản phẩm, kho thêm vào seed khi có #12, #16.

Seed tạo thêm hai công ty cho bộ test hộp đen (#120), cùng mật khẩu seed: "Công ty QA Hộp Đen A" (`qa-ceo@`, `qa-admin@`, `qa-sale@`, `qa-kho@`, `qa-truong-kho@bk.demo`; bật Nhập hàng, Kênh bán, Báo cáo) và "Công ty QA Hộp Đen B" (`qa-ceo-b@bk.demo`). Mỗi lần chạy test thêm bản ghi mới vào hai công ty này; buổi demo dùng "Công ty Demo Commerio".

## Tài khoản quản trị nền tảng

Seed không tạo quản trị nền tảng (quyền cao nhất, không dùng chung mật khẩu demo). Cấp bằng script, chạy từ máy với chuỗi kết nối staging như `db:migrate:staging` (#152):

```bash
PLATFORM_ADMIN_PASSWORD='<mật khẩu riêng>' node --env-file=.env.staging db/platform-admin.ts <email>   # tạo hoặc bật cờ
node --env-file=.env.staging db/platform-admin.ts <email> --revoke                                    # gỡ cờ
```

Tài khoản chưa có thì tạo mới (mật khẩu theo luật đăng ký, họ tên lấy từ `PLATFORM_ADMIN_NAME`). Từ chối tài khoản đang thuộc một công ty: quản trị nền tảng là tài khoản riêng, đăng nhập vào thẳng `/platform`. Gỡ cờ có hiệu lực ở request kế tiếp. Trên máy: `npm run platform-admin -- <email>`.

## Chạy giống staging trên máy

Dùng `deploy/k8s/overlays/local` trên Kubernetes của Docker Desktop (`deploy/k8s/README.md`, mục "Chạy trên máy").

## Xem trạng thái, log, deploy lại

Các lệnh dưới chạy trên VPS bằng root (`K="kubectl -n commerio"`).

- **Trạng thái deploy:** tab Actions, workflow "Deploy staging" của từng repo (hoặc `gh run list -w deploy-staging.yml`).
- **Tình trạng tiến trình:** `$K get pods`; mọi pod `1/1 Running`. Image đang chạy: `$K get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image`.
- **Log trên trình duyệt (không cần SSH):** `https://<tên miền>/logs/` (Dozzle, mục "Xem log bằng Dozzle" bên dưới).
- **Log bằng kubectl:** `$K logs -l app.kubernetes.io/name=api -f --prefix` (chọn theo nhãn nên gồm cả `api-blue`, `api-green`; tương tự `worker`, `realtime`, `fe`, `caddy`; thêm `--since=1h` để giới hạn). Pod vừa khởi động lại: `$K logs <tên pod> --previous`.
- **Deploy lại một commit cũ:**
  - Qua CI: mở run của commit đó trong Actions → "Re-run all jobs" (trong 30 ngày kể từ run gốc).
  - Trên VPS, quay về bản vừa thay: `sudo -u ci-deploy -H env SSH_ORIGINAL_COMMAND=rollback commerio-deploy backend` (hoặc `fe`): bật lại màu vừa nghỉ, vẫn giữ image cũ, rồi chuyển Service về đó. Về một commit bất kỳ: `SSH_ORIGINAL_COMMAND=sha-<7 ký tự>`.
  - Chỉ lùi được code, **không lùi schema**: migration đã chạy vẫn giữ. Migration mới phải tương thích với code của bản trước một bước.

## Xem log bằng Dozzle

`https://<tên miền>/logs/` hiện log trực tiếp của mọi pod trong namespace `commerio`, tìm và lọc trên giao diện, xem CPU/RAM từng pod. Dành cho cả người không có khoá SSH. Một tài khoản dùng chung cả nhóm, tên `commerio`; đăng nhập giữ 72 giờ.

- Manifest: `deploy/k8s/overlays/vps/dozzle.yaml`. Quyền trong cụm chỉ đọc pod và log của `commerio`; tắt actions và shell nên không restart, xoá hay exec được pod từ giao diện.
- Dozzle không lưu log: pod bị thay (deploy blue-green, restart) thì log của pod cũ mất, như `kubectl logs`.
- Tốn khoảng 20–40 MB RAM, CPU gần 0 khi không ai mở.
- Dựng lần đầu, hoặc đổi mật khẩu (`--doi-mat-khau`), trên VPS bằng root: `bash /opt/commerio/repo/deploy/k8s/overlays/vps/dozzle/setup.sh`. Script sinh mật khẩu ngẫu nhiên, ghi bản băm bcrypt vào `overlays/vps/dozzle/users.yml` (gitignore, chỉ có trên VPS), apply riêng object Dozzle, ConfigMap Caddyfile và Deployment `caddy` (không apply cả overlay), rồi in mật khẩu một lần. Từ lần này `kubectl apply -k overlays/vps` cần có `dozzle/users.yml`.

## Supabase

Gói Free tạm dừng project sau 7 ngày không dùng: vào dashboard bấm Restore.

### Ngân sách kết nối (#335)

Session pooler (Supavisor) chỉ nhận số kết nối bằng **Pool Size** của nó (dashboard → Database → Connection pooling; mặc định 15). Vượt thì pooler từ chối với `EMAXCONNSESSION`, request nhận 503 `service_unavailable` (trước #335 là 500). Mỗi tiến trình chỉ có một pool (pg-boss dùng chung), trần là `DB_POOL_MAX` đặt trong `deploy/k8s`. Điều kiện:

```
2 × api + worker + 2 × realtime + 1 (db:migrate) ≤ Pool Size
```

Hai lần `api`, `realtime` vì lúc đổi màu blue-green bản cũ và bản mới cùng sống. `worker` một lần vì nó đổi image kiểu `Recreate` (tắt bản cũ rồi mới bật bản mới); để RollingUpdate thì lúc đổi có hai worker và phải tính hai lần. `check.mjs` tự đếm số pod cùng sống theo `strategy` của từng Deployment, nên đổi strategy mà quên ngân sách thì CI đỏ. Đang đặt Pool Size **40** (Compute Nano có `max_connections` 60, chừa phần còn lại cho dashboard và kết nối trực tiếp), chia `api` 7, `worker` 19, `realtime` 2: 2 × 7 + 19 + 2 × 2 + 1 = 38. `worker` cần ít nhất (khoá phiên giữ cùng lúc + việc pg-boss song song + 2), cách tính ghi cạnh `DB_POOL_MAX` trong `deploy/k8s/base/app.yaml`.

Job `manifests` của CI cộng các `DB_POOL_MAX` theo công thức và đỏ khi vượt biến repo `STAGING_DB_POOL_SIZE` (chưa đặt thì lấy 40). Đổi Pool Size ở dashboard thì đổi biến này theo. Đổi `DB_POOL_MAX` xong phải `kubectl apply -k deploy/k8s/overlays/vps` trên VPS (`commerio-deploy` chỉ đổi image). Không chạy `Documents/erd/supabase-*.sql` lên database này.
