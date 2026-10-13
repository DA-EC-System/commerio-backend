# deploy/

Đóng gói và hạ tầng.

| Đường dẫn | Nội dung |
|---|---|
| `compose.yaml` | Hạ tầng cho máy dev: PostgreSQL 18 có pgvector, Redis, Kafka (KRaft một node). Profile `monitoring` thêm Prometheus (9090) và Grafana (3030). Ứng dụng chạy bằng `npm run dev` trên máy, không chạy trong compose |
| `docker/Dockerfile` | Một image cho cả ba tiến trình, mặc định chạy `api`. Build từ gốc repo: `docker build -f deploy/docker/Dockerfile .` |
| `monitoring/prometheus.yml` | Prometheus lấy `/metrics` của ba tiến trình trên máy dev qua `host.docker.internal` |
| `k8s/` | Chưa có. Sẽ có ba Deployment dùng chung image (`api`, `worker`, `realtime`), Service, Ingress, ConfigMap, Secret, Job chạy migration |

- Mật khẩu trong `compose.yaml` chỉ dùng cho máy dev. Secret thật đặt trong Kubernetes Secret, không commit.
- Image chạy bằng user `node`, chỉ cài dependency production, không có test và `CLAUDE.md` (`.dockerignore`).
- Đổi cổng hoặc tên tiến trình thì sửa cùng lúc `src/shared/config/env.ts`, `.env.example`, `prometheus.yml`.
