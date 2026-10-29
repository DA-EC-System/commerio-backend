# deploy/

Đóng gói và hạ tầng.

| Đường dẫn | Nội dung |
|---|---|
| `compose.yaml` | Hạ tầng cho máy dev: PostgreSQL 18 có pgvector, Redis, Kafka (KRaft một node), Mailpit (SMTP 1025, xem thư ở 8025). Profile `monitoring` thêm Prometheus (9090) và Grafana (3030, đã có dashboard "Commerio"). Profile `lazada-mock` thêm sàn giả lập Lazada (#115): WireMock (admin 8091) và cổng kiểm chữ ký (8090), cách dùng ở `scripts/lazada-mock/README.md`. Ứng dụng chạy bằng `npm run dev` trên máy, không chạy trong compose |
| `docker/Dockerfile` | Một image cho cả ba tiến trình, mặc định chạy `api`. Build từ gốc repo: `docker build -f deploy/docker/Dockerfile .` |
| `staging/` | Staging (#37) chạy trên k3s của VPS bằng `k8s/overlays/vps`; DB là Supabase. Workflow `.github/workflows/deploy-staging.yml`; secret, log, deploy lại ở `staging/README.md` |
| `monitoring/` | `prometheus.yml`: Prometheus máy dev lấy `/metrics` của ba tiến trình (9464, 3001, 3003) qua `host.docker.internal`. `k8s/prometheus.yml`, `rules/` (cảnh báo + test), `grafana/provisioning/`, `dashboards/`: dùng chung cho máy dev và Kubernetes |
| `k8s/` | Kustomize (#36): `base/` (ba Deployment cùng image, FE, Kafka, Caddy làm cổng vào thay Ingress, Prometheus, Grafana), `overlays/local` (Docker Desktop), `overlays/vps` (k3s). Migration chạy từ runner CI (V36), không có Job trong cluster. Cách chạy: `k8s/README.md` |

- Cổng trong `compose.yaml` chỉ mở trên `127.0.0.1`, mật khẩu chỉ dùng cho máy dev. Secret thật đặt trong Kubernetes Secret, không commit.
- Image chạy bằng user `node`, chỉ cài dependency production, không có test và `CLAUDE.md` (`.dockerignore`).
- Đổi cổng hoặc tên tiến trình thì sửa cùng lúc `src/shared/config/env.ts`, `.env.example`, `monitoring/prometheus.yml`, `k8s/base/app.yaml` (cổng tên `metrics`).
- Thêm hay đổi tên metric thì sửa `monitoring/dashboards/commerio.json` và `monitoring/rules/` nếu luật dùng nó.
