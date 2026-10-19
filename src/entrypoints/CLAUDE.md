# src/entrypoints/

Mỗi file là lệnh khởi động một tiến trình. Cả ba dùng chung một Docker image, chỉ khác lệnh `node src/entrypoints/<tên>.ts`.

| File | Cổng (env, mặc định) | Chạy gì |
|---|---|---|
| `api.ts` | `API_PORT` 3000 (public), `API_OPS_PORT` 9464 (vận hành) | App từ `app.ts`: `/health`, router mọi module, Swagger. `/metrics` chỉ ở cổng vận hành |
| `worker.ts` | `WORKER_PORT` 3001 (vận hành) | Gọi `startBackground(ctx)` của mọi module có khai: relay outbox và consumer `shared` (platform, #38), tra cứu thanh toán quá hạn (payment), dựng lại báo cáo (report). Việc nền mới viết trong module, không sửa file này |
| `realtime.ts` | `REALTIME_PORT` 3002 (stream), `REALTIME_OPS_PORT` 3003 (vận hành) | Kênh SSE thông báo (#33): consumer Kafka `instance` (mỗi bản sao một group) đẩy sự kiện xuống trình duyệt. Cổng stream chỉ có `/api/v1/notification/stream` |

Cổng vận hành của worker và realtime (`/health`, `/metrics`) dựng bằng `startOpsServer` (`src/shared/observability/ops-server.ts`). Prometheus lấy số liệu ở cổng có tên `metrics` của cả ba tiến trình; probe của worker, realtime cũng ở cổng đó, còn api probe `/health` trên cổng `http` (`deploy/k8s/base/app.yaml`).

Quy tắc:

- File ở đây chỉ ráp và khởi động, không chứa nghiệp vụ. Consumer của module X đặt trong module X và được export qua `index.ts`, entrypoint chỉ đăng ký chúng.
- Mọi tài nguyên mở ra (server, pool DB, consumer Kafka) phải đóng trong `onShutdown()` để Kubernetes dừng pod êm. `worker` đăng ký `onShutdown` trước vòng khởi động; `realtime` gọi `stopInstanceConsumers()` trước khi đóng DB.
- `/metrics` chỉ nằm trên cổng vận hành, không đưa ra ngoài (Caddy chỉ đưa `/api/*` của api và đường dẫn stream của realtime). Không thêm `/metrics` vào `app.ts` hay app stream.
- `worker` và `realtime` chạy việc lâu hoặc giữ kết nối dài, nên tách khỏi `api` để `api` co giãn độc lập (`docs/03` mục 12).
