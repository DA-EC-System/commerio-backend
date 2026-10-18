# deploy/

Đóng gói và hạ tầng.

| Đường dẫn | Nội dung |
|---|---|
| `compose.yaml` | Hạ tầng cho máy dev: PostgreSQL 18 có pgvector, Redis, Kafka (KRaft một node). Profile `monitoring` thêm Prometheus (9090) và Grafana (3030). Ứng dụng chạy bằng `npm run dev` trên máy, không chạy trong compose |
| `docker/Dockerfile` | Một image cho cả ba tiến trình, mặc định chạy `api`. Build từ gốc repo: `docker build -f deploy/docker/Dockerfile .` |
| `staging/` | Staging (#37): `compose.yaml` chạy ba tiến trình từ image GHCR cùng Redis, Kafka (quảng bá `kafka:9092`) và Caddy (FE ở `/`, API ở `/api`, cùng origin). DB là Supabase. Workflow `.github/workflows/deploy-staging.yml`; cách chạy, secret, log ở `staging/README.md` |
| `monitoring/prometheus.yml` | Prometheus lấy `/metrics` từ cổng vận hành của ba tiến trình (9464, 3001, 3002) qua `host.docker.internal` |
| `k8s/` | Chưa có. Sẽ có ba Deployment dùng chung image (`api`, `worker`, `realtime`), Service, Ingress, ConfigMap, Secret, Job chạy migration |

- Cổng trong `compose.yaml` chỉ mở trên `127.0.0.1`, mật khẩu chỉ dùng cho máy dev. Secret thật đặt trong Kubernetes Secret, không commit.
- Image chạy bằng user `node`, chỉ cài dependency production, không có test và `CLAUDE.md` (`.dockerignore`).
- Đổi cổng hoặc tên tiến trình thì sửa cùng lúc `src/shared/config/env.ts`, `.env.example`, `prometheus.yml`.
