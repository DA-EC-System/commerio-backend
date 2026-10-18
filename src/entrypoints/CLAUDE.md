# src/entrypoints/

Mỗi file là lệnh khởi động một tiến trình. Cả ba dùng chung một Docker image, chỉ khác lệnh `node src/entrypoints/<tên>.ts`.

| File | Cổng (env) | Hiện có | Sẽ thêm |
|---|---|---|---|
| `api.ts` | `API_PORT` 3000, `API_OPS_PORT` 9464 | App từ `app.ts` (`/health`, router module) trên cổng public; `/metrics` trên cổng vận hành riêng | Route nghiệp vụ theo từng module |
| `worker.ts` | `WORKER_PORT` 3001 | Cổng vận hành (`/health`, `/metrics`); gọi `startBackground(ctx)` của mọi module có khai | Relay outbox (#38), consumer, tra cứu định kỳ: viết trong module, không sửa file này |
| `realtime.ts` | `REALTIME_PORT` 3002 | Cổng vận hành | Kênh SSE; mỗi bản sao một consumer group Kafka để bản nào cũng nhận đủ sự kiện |

Quy tắc:

- File ở đây chỉ ráp và khởi động, không chứa nghiệp vụ. Consumer của module X đặt trong module X và được export qua `index.ts`, entrypoint chỉ đăng ký chúng.
- Mọi tài nguyên mở ra (server, pool DB, consumer Kafka) phải đóng trong `onShutdown()` để Kubernetes dừng pod êm.
- `/metrics` chỉ nằm trên cổng vận hành, không đưa ra Ingress. Không thêm `/metrics` vào `app.ts`.
- `worker` và `realtime` chạy việc lâu hoặc giữ kết nối dài, nên tách khỏi `api` để `api` co giãn độc lập (`docs/03` mục 12).
