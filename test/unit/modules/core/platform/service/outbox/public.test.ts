import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishEvent, registerConsumer } from '#src/modules/core/platform/index.ts';

// Phần không cần DB, Kafka của khung outbox (#38). Luồng ghi thật ở test/integration/platform/outbox/.
describe('publishEvent', () => {
  it('từ chối payload sai schema trước khi chạm DB', async () => {
    await expect(
      publishEvent({
        type: 'inventory.below_threshold',
        aggregateId: randomUUID(),
        payload: { variantId: 'khong-phai-uuid', available: 1, minQty: 5 },
      }),
    ).rejects.toThrow(/inventory\.below_threshold/);
  });
});

describe('registerConsumer', () => {
  const noop = async () => undefined;

  it('từ chối loại sự kiện không có trong danh mục', () => {
    // @ts-expect-error loại không tồn tại
    expect(() => registerConsumer('khong.co', noop, { consumer: 'u1' })).toThrow(/khong\.co/);
  });

  it('từ chối đăng ký hai lần cùng một loại cho một consumer', () => {
    registerConsumer('sales.order_created', noop, { consumer: 'u2' });
    expect(() => registerConsumer('sales.order_created', noop, { consumer: 'u2' })).toThrow(/u2/);
  });

  it('từ chối một tên consumer dùng hai scope', () => {
    registerConsumer('sales.order_created', noop, { consumer: 'u3' });
    expect(() => registerConsumer('payment.succeeded', noop, { consumer: 'u3', scope: 'instance' })).toThrow(/scope/);
  });
});
