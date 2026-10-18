import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishEvent, registerConsumer } from '#src/modules/platform/index.ts';

// Khung của #38 (AC-10): chữ ký đã chốt, thân chưa làm thì báo 501 rõ ràng.
describe('khung outbox của platform', () => {
  it('publishEvent báo 501 not_implemented', async () => {
    const id = randomUUID();
    await expect(
      publishEvent({ type: 'inventory.below_threshold', aggregateId: id, payload: { variantId: id, available: 1, minQty: 5 } }),
    ).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });

  it('registerConsumer báo 501 not_implemented', () => {
    expect(() => registerConsumer('sales.order_created', async () => undefined, { consumer: 'thu' })).toThrow(
      expect.objectContaining({ status: 501, code: 'not_implemented' }),
    );
  });
});
