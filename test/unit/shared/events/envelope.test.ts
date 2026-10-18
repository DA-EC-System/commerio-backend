import { describe, expect, it } from 'vitest';
import { topicOf } from '#src/shared/events/envelope.ts';

describe('topicOf', () => {
  it('topic là <tiền tố>.<module phát>, module lấy từ phần trước dấu chấm của type (D4)', () => {
    expect(topicOf('inventory.stock_changed', 'commerio')).toBe('commerio.inventory');
    expect(topicOf('fulfillment.order_status_changed', 'commerio-w2')).toBe('commerio-w2.fulfillment');
  });
});
