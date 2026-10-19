# Kubernetes

Cả hệ chạy trên Kubernetes (#36, `Documents/21` D13): ba tiến trình `api`, `worker`, `realtime` cùng một image, Kafka, Caddy làm cổng vào, Prometheus và Grafana có dashboard. Viết bằng Kustomize: `base/` là phần chung, mỗi nơi chạy một overlay.

```
                         ┌─ /api/v1/notification/stream* ─► realtime:3002 ─┐
trình duyệt ──► caddy ───┼─ /api/*                        ─► api:3000      ├─► PostgreSQL (ngoài cluster)
 (LoadBalancer)          └─ /  (dist/ của FE)                worker ───────┘
                                                             api, worker, realtime ◄─► kafka
prometheus ──► /metrics của api:9464, worker:3001, realtime:3003 (cổng tên "metrics")
grafana ──► prometheus          (cả hai chỉ có ClusterIP, mở bằng kubectl port-forward)
```

| Overlay | Nơi chạy | Image | Database |
|---|---|---|---|
| `overlays/local` | Kubernetes của Docker Desktop | `commerio-backend:local` tự build | DB Docker của máy qua `host.docker.internal` |
| `overlays/vps` | k3s trên VPS staging, thay compose của `deploy/staging` | `ghcr.io/da-ec-system/commerio-backend` (amd64 + arm64) | Supabase |

- Caddyfile ở `base/caddy/` chép nguyên `deploy/staging/Caddyfile`; CI (`.github/workflows/k8s.yml`) báo đỏ nếu hai file khác nhau.
- Migration **không** chạy trong cluster: runner CI chạy trước khi đổi image (`Documents/21` V36, workflow `deploy-staging.yml`). Trên máy: `npm run db:migrate` trỏ đúng database.
- Không có Redis (code chưa dùng). `api` một bản sao vì rate limit đăng nhập đếm trong bộ nhớ.
- Cấu hình Prometheus, luật cảnh báo, provisioning Grafana và dashboard nằm ở `deploy/monitoring/` (Kustomize không đọc file ngoài thư mục kustomization, nên thư mục đó có `kustomization.yaml` riêng).

> **Mọi lệnh `kubectl` ghi `--context`.** Máy có thể đang trỏ một cluster khác làm context mặc định. Dưới đây `K="kubectl --context docker-desktop -n commerio"`.

## Kiểm tĩnh (không cần cluster)

Giống CI. Cần Docker; `yq` chạy qua image nếu máy không có.

```bash
for f in $(find deploy/k8s/overlays -name .env.example); do [ -f "${f%.example}" ] || cp "$f" "${f%.example}"; done
for o in local vps; do
  kubectl kustomize deploy/k8s/overlays/$o > /tmp/$o.yaml
  docker run --rm -i ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -kubernetes-version 1.34.0 - < /tmp/$o.yaml
  docker run --rm -i mikefarah/yq:4.47.2 ea -o=json -I=0 '[.]' < /tmp/$o.yaml | node deploy/k8s/check.mjs
done
docker run --rm -v "$PWD/deploy/monitoring/rules:/r" --entrypoint promtool prom/prometheus:v3.5.0 test rules /r/alerts.test.yml
```

`check.mjs` kiểm điều kubeconform không bắt được: Secret, ConfigMap được tham chiếu có thật và cùng namespace; mọi container có `requests` và `limits.memory`; mọi pod có `enableServiceLinks: false`; ba tiến trình cùng image; không có Job; Kafka ghi vào PVC; chỉ `caddy` mở ra ngoài.

## Chạy trên máy (Kubernetes của Docker Desktop)

Bật Kubernetes trong Docker Desktop (Settings → Kubernetes), cần thêm khoảng 2 GB RAM cho VM của Docker. Lệnh chạy ở gốc repo backend.

1. **Database:** `npm run infra:up`, tạo database riêng rồi migrate:
   ```bash
   docker compose -f deploy/compose.yaml exec postgres createdb -U commerio commerio_k8s
   DATABASE_URL=<chuỗi postgres:// tới localhost:5432/commerio_k8s, user và mật khẩu dev như deploy/compose.yaml> npm run db:migrate
   ```
2. **Image:** `docker build -f deploy/docker/Dockerfile -t commerio-backend:local .` (Docker Desktop dùng chung kho image với Kubernetes).
3. **Bí mật:** chép `overlays/local/.env.example` → `.env` và `overlays/local/grafana/.env.example` → `grafana/.env`, điền (mật khẩu Grafana để trống thì Grafana dùng `admin/admin`). Giá trị **không** đặt trong dấu nháy (Kustomize giữ nguyên dấu nháy). Hai file đã gitignore.
4. **Chạy:** `kubectl --context docker-desktop apply -k deploy/k8s/overlays/local`, chờ `$K get pods` đều `Running` và `READY 1/1`.
5. **Mở:** ứng dụng ở `http://localhost:8036` (LoadBalancer của Docker Desktop có thể nghe cả mạng LAN, khác compose chỉ mở `127.0.0.1`; chưa đo) (`/api/docs` là Swagger). Caddy không có `/health` (mọi đường dẫn ngoài `/api` là FE), nên kiểm qua `/api`: `curl -i localhost:8036/api/v1/identity/me` ra 401. Muốn gọi thẳng `api`: `$K port-forward svc/api 3036:3000`.
6. **Grafana, Prometheus:** `$K port-forward svc/grafana 3030:3000` → `http://localhost:3030` (admin / mật khẩu ở `grafana/.env`), dashboard "Commerio" trong thư mục Commerio. `$K port-forward svc/prometheus 9090` → `http://localhost:9090/alerts`.
7. **Tắt:** `kubectl --context docker-desktop delete namespace commerio` (xoá cả PVC của Kafka).

Thử nhanh:
- Cảnh báo: `$K scale deploy/worker --replicas=0`, sau khoảng 1–2 phút `CommerioProcessDown{process="worker"}` sang `firing`; `--replicas=1` để trả lại.
- Cập nhật không gián đoạn: chạy `while true; do curl -s -o /dev/null -w '%{http_code}\n' localhost:8036/api/v1/identity/me; sleep 0.2; done` (mong 401) trong lúc `$K rollout restart deploy/api`; không được có `000`, `502`.
- `realtime` khởi động lại thì stream SSE đang mở bị đóng; FE tự nối lại sau 3 giây (`retry: 3000`).

## Lên VPS (k3s)

Chưa chạy thật (chờ VPS). Thay compose của `deploy/staging` trên cùng máy; muốn quay lại thì `k3s-killall.sh` rồi `docker compose up -d` như `deploy/staging/README.md`.

1. Cài k3s không có Traefik (Caddy giữ cổng 80/443 qua ServiceLB của k3s): `curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -`. Không mở cổng 6443 ra ngoài; deploy chạy `kubectl` trên chính VPS qua SSH. Máy sau NAT (IP công khai NAT 1:1) **không** đặt `--node-external-ip` khi dùng `externalTrafficPolicy: Local`.
2. Secret kéo image GHCR private (PAT `read:packages`, như `GHCR_PULL_TOKEN` của #37):
   `kubectl -n commerio create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=<tài khoản> --docker-password=<PAT>` (tạo namespace trước: `kubectl create namespace commerio`).
3. Điền `overlays/vps/.env` (DB Supabase, JWT), `grafana/.env`, `caddy/.env` (`SITE_ADDRESS=<tên miền>`), không dấu nháy. FE: `dist/` chép vào `/opt/commerio/site`.
4. `kubectl apply -k deploy/k8s/overlays/vps`. Đổi image theo commit: `kubectl -n commerio set image deploy/api api=ghcr.io/da-ec-system/commerio-backend:sha-<7 ký tự>` (tương tự `worker`, `realtime`).

Tổng `requests` khoảng 570m CPU, 1,6 GiB RAM, cộng k3s; máy 2 GB không đủ, 4 GB đủ. Số `resources` là ước lượng, đo lại bằng panel RAM của dashboard.

## Giám sát

Dashboard "Commerio" (`deploy/monitoring/dashboards/commerio.json`, cũng nạp vào Grafana của máy dev qua `deploy/compose.yaml` profile `monitoring`): tần suất, tỉ lệ 5xx, p95 theo route của `api`; tiến trình đang chạy, CPU, RAM, event loop; outbox (đang chờ, tuổi cũ nhất, DLQ); số stream SSE. Hàng "Nghiệp vụ" để trống cho metric đơn, thanh toán (#24, #25, #27). Sửa dashboard: sửa file JSON rồi apply lại (Grafana không lưu sửa trên giao diện).

Luật cảnh báo (`deploy/monitoring/rules/alerts.yml`, test ở `alerts.test.yml`) hiện ở `/alerts` của Prometheus, chưa gửi đi đâu:

| Cảnh báo | Khi nào |
|---|---|
| `CommerioProcessDown` | một tiến trình không trả `/metrics` hoặc không còn pod nào, quá 1 phút |
| `CommerioHighErrorRate` | hơn 5% yêu cầu (trừ `/health`) trả 5xx, suốt 5 phút |
| `CommerioOutboxLagging` | sự kiện outbox chờ hơn 60 giây, suốt 5 phút. Im lặng khi worker không đọc được DB (số liệu ra NaN) |
| `CommerioDeadLettered` | có sự kiện vào DLQ trong 10 phút qua. Báo nhầm một lần ngay sau khi Prometheus khởi động lại (số liệu không lưu qua lần khởi động) |
