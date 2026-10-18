# Outbox và Kafka (`platform/service/outbox`)

Sự kiện giữa module đi theo đường: giao dịch nghiệp vụ ghi `platform.outbox_messages` → relay trong `worker` đẩy lên Kafka → consumer gọi handler. Quyết định: `Documents/21` D4–D7, V39, V40; kiến trúc: `Documents/17` mục 4. Chỉ thư mục này import client Kafka (luật depcruise `kafka-chi-o-outbox`).

## Phát sự kiện

```ts
import { publishEvent } from '../platform/index.ts';

await withCompany(companyId, async () => {
  await lockVariantRow(variantId);           // khoá dòng đối tượng TRƯỚC khi ghi outbox (xem "Thứ tự")
  await updateStock(...);
  await publishEvent({ type: 'inventory.stock_changed', aggregateId: variantId, payload: { ... } });
});
```

- Phải gọi trong `withCompany`; ngoài giao dịch, hay trong giao dịch không thuộc công ty, thì ném lỗi.
- Payload kiểm bằng schema Zod của danh mục (`platform/domain/events.ts`); sai thì ném, giao dịch rollback.
- Topic `<KAFKA_TOPIC_PREFIX>.<module phát>`, key = `aggregateId`. Giao dịch rollback thì sự kiện mất theo; commit thì không mất kể cả khi Kafka đang dừng (relay gửi khi Kafka chạy lại).

## Nghe sự kiện

```ts
registerConsumer('inventory.stock_changed', async (event) => { ... }, { consumer: 'channel-stock-push' });
registerConsumer('inventory.below_threshold', async (event) => { ... }, { consumer: 'channel-stock-push' });
```

| `scope` | Chạy ở | Nhận | Handler chạy trong | Lỗi |
|---|---|---|---|---|
| `shared` (mặc định) | `worker` | mỗi sự kiện một bản sao worker | `withCompany(event.companyId)` + ghi `processed_events` cùng giao dịch | thử lại sau 1 s, 5 s, 30 s; vẫn lỗi → `<topic>.dlq` |
| `instance` | tiến trình gọi (vd `realtime`) | mọi bản sao, chỉ sự kiện mới | không giao dịch | ghi log, bỏ qua |

- Đăng ký mọi loại của một tên consumer **liền nhau trong một khối đồng bộ** (lúc import hoặc đầu `startBackground`). Thêm loại vào tên đã chạy thì ném lỗi.
- **Đúng một lần chỉ với tác động trong DB.** Gọi ra ngoài (đẩy tồn lên sàn, email) là "ít nhất một lần": gửi giá trị tuyệt đối (số tồn), không gửi chênh lệch.
- Lỗi mất kết nối DB không bị đẩy vào DLQ: message được giao lại. Mất kết nối giữa truy vấn hiện làm worker thoát (chưa gắn listener `error` cho pool, sửa ở PR dọn dẹp); sự kiện không mất vì offset chưa commit.
- Message lỗi giữ partition của nó đứng tối đa ~36 s trong lúc thử lại; partition khác chạy tiếp.
- Tên consumer `shared` **mới** đọc topic từ đầu phần Kafka còn giữ (tới 7 ngày, mọi công ty): handler gọi ra ngoài phải chịu được sự kiện cũ, hoặc tự bỏ sự kiện có `occurredAt` quá xa.
- Lỗi mạng của chính handler (gọi API sàn hỏng) tính là lỗi handler: thử lại rồi DLQ. Chỉ lỗi kết nối PostgreSQL mới được giao lại không giới hạn (chờ lùi 1 s → 30 s).

## Thứ tự

Kafka giữ thứ tự trong một partition; key = `aggregateId` nên các sự kiện của một đối tượng đến đúng thứ tự ghi outbox (`id`). Điều kiện: nghiệp vụ khoá dòng đối tượng (`SELECT … FOR UPDATE`) trước khi ghi outbox, vì `id` cấp lúc INSERT chứ không theo thứ tự commit.

Giới hạn đã biết:
- Sau khi một sự kiện sang DLQ, sự kiện sau cùng key đi trước nó; đẩy lại DLQ thì nó tới muộn.
- Lô relay hỏng giữa chừng do hết `message.timeout.ms` (Kafka chập chờn) có thể làm consumer thấy m2, m1, m2: m2 lần hai bị bỏ qua vì trùng, trạng thái cuối là m1. Sẽ thêm `sequence` vào envelope ở PR dọn dẹp trước #21.

## Chạy worker

```bash
npm run infra:up          # Kafka, PostgreSQL
npm run dev:worker        # relay + consumer; /metrics ở WORKER_PORT
```

Dừng worker (SIGTERM) chờ lượt relay đang gửi tối đa `message.timeout.ms` (30 s) rồi ngắt consumer: Kubernetes nên đặt `terminationGracePeriodSeconds` ≥ 45 (#36). Worker lên được khi Kafka chưa chạy (relay tự nối lại, chờ lùi tới 30 s). Lúc nối được, worker tạo topic của mọi module có sự kiện, kèm `.dlq`, mỗi topic 3 partition. Dòng outbox đã gửi và `processed_events` giữ 7 ngày, dọn mỗi giờ.

Số liệu trên `http://localhost:<WORKER_PORT>/metrics`: `outbox_pending_messages`, `outbox_oldest_pending_age_seconds`, `outbox_dead_lettered_total{topic,consumer}`.

## Xem và đẩy lại DLQ

```bash
# Xem (header x-error, x-attempts, x-consumer, x-original-topic/partition/offset)
docker compose -f deploy/compose.yaml exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic commerio.inventory.dlq --from-beginning \
  --property print.headers=true --property print.key=true

# Đếm thử, rồi đẩy lại về topic gốc
node --env-file=.env src/modules/platform/service/outbox/replay-dlq.ts commerio.inventory.dlq --dry-run
node --env-file=.env src/modules/platform/service/outbox/replay-dlq.ts commerio.inventory.dlq
```

Script đọc từ chỗ lần đẩy trước dừng tới offset cuối lúc bắt đầu. Script hỏng giữa chừng (quá 5 phút) thì chưa commit gì: chạy lại sẽ đẩy lại cả phần đã đẩy, consumer `shared` bỏ qua nhờ chống trùng. `eventId` giữ nguyên: consumer `shared` đã xử lý sự kiện đó thì bỏ qua; consumer `instance` nhận lại. Trên Git Bash thêm `MSYS_NO_PATHCONV=1` trước lệnh `docker compose exec`.

## Test

`test/unit/modules/platform/service/outbox/` (quyết định của consumer, không Kafka) và `test/integration/platform/outbox/` (PostgreSQL + Kafka `apache/kafka:4.1.0` trong container riêng của file test, khởi động ~35 s).
