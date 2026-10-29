/**
 * Vỏ chung của mọi sự kiện đi qua outbox và Kafka (Documents/21 D4). Danh mục loại sự kiện và schema
 * payload là nghiệp vụ, nằm ở module platform (`platform/domain/events.ts`).
 */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  /** uuid, khoá chống xử lý trùng của consumer. */
  readonly eventId: string;
  /** `<module phát>.<việc>`, vd `inventory.stock_changed`. */
  readonly type: TType;
  /** Trống với sự kiện cấp nền tảng. */
  readonly companyId: string | null;
  /** Đối tượng của sự kiện, cũng là key Kafka để giữ thứ tự theo đối tượng. */
  readonly aggregateId: string;
  /** Thời điểm xảy ra, ISO 8601. */
  readonly occurredAt: string;
  /**
   * Số thứ tự tăng dần (`id` dòng outbox). Consumer bỏ sự kiện có `sequence` ≤ số đã xử lý của cùng
   * `aggregateId` (chỉ đúng khi bên phát khoá dòng đối tượng trước khi ghi outbox, xem outbox/README.md).
   * Trống với message gửi trước khi có trường này hoặc phát lại từ DLQ cũ.
   */
  readonly sequence?: number;
  readonly payload: TPayload;
}

/** Topic của một loại sự kiện: `<tiền tố>.<module phát>`; tiền tố là `KAFKA_TOPIC_PREFIX`. */
export function topicOf(type: string, prefix: string): string {
  return `${prefix}.${type.split('.')[0]}`;
}
