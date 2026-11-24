import { describe, expect, it } from 'vitest';
import { PUSH_BATCH, pushBatches } from '#src/modules/channel/channel/service/listing-sync.ts';

// Lô đẩy của lượt đồng bộ (21 §18 "Kết quả lượt đồng bộ"): tối đa 20 listing, giữ các SKU một sản phẩm sàn chung lô.
const item = (product: string, i: number) => ({ row: { externalProductId: product }, i });

describe('pushBatches', () => {
  it('gom theo sản phẩm sàn, không tách sản phẩm sang hai lô khi lô hiện tại không đủ chỗ', () => {
    const plan = [...Array.from({ length: 15 }, (_, i) => item('A', i)), ...Array.from({ length: 10 }, (_, i) => item('B', i))];
    const batches = pushBatches(plan);
    expect(batches.map((b) => b.length)).toEqual([15, 10]);
    expect(batches[1]!.every((p) => p.row.externalProductId === 'B')).toBe(true);
  });

  it('sản phẩm hơn 20 SKU thì chia thành lô 20; lô không vượt trần; giữ đủ phần tử', () => {
    const plan = [...Array.from({ length: 45 }, (_, i) => item('A', i)), item('B', 0), item('C', 0)];
    const batches = pushBatches(plan);
    expect(batches.every((b) => b.length <= PUSH_BATCH)).toBe(true);
    expect(batches.flat()).toHaveLength(47);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 7]);
  });

  it('kế hoạch rỗng: không lô nào', () => {
    expect(pushBatches([])).toEqual([]);
  });
});
