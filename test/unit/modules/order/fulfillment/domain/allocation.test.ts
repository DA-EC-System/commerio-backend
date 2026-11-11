import { describe, expect, it } from 'vitest';
import {
  type AllocationCandidate,
  allocationQueue,
  needOf,
  planAllocation,
  planDismantle,
  planReclaim,
  type ReclaimCandidate,
} from '#src/modules/order/fulfillment/domain/allocation.ts';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const day = (d: number, h = 9) => new Date(Date.UTC(2026, 10, d, h));

const cand = (code: string, o: Partial<AllocationCandidate> = {}): AllocationCandidate => ({
  id: code,
  code,
  status: 'backordered',
  shipBy: null,
  orderCreatedAt: day(1),
  lines: [{ variantId: A, quantity: 1 }],
  ...o,
});

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('allocationQueue (25 §7.4, spec 199b D5)', () => {
  it('kiện packed hạn muộn đứng trước kiện backordered hạn sớm', () => {
    const q = allocationQueue([cand('K1', { shipBy: day(2) }), cand('K2', { status: 'packed', shipBy: day(9) })]);
    expect(ids(q)).toEqual(['K2', 'K1']);
  });

  it('hạn sớm trước hạn muộn; hạn null đứng sau mọi kiện có hạn', () => {
    const q = allocationQueue([cand('K1'), cand('K2', { shipBy: day(5) }), cand('K3', { shipBy: day(3) })]);
    expect(ids(q)).toEqual(['K3', 'K2', 'K1']);
  });

  it('cùng hạn thì đơn kéo về trước; cùng nốt thì theo mã kiện', () => {
    const q = allocationQueue([
      cand('K3', { shipBy: day(3), orderCreatedAt: day(1, 10) }),
      cand('K2', { shipBy: day(3), orderCreatedAt: day(1, 8) }),
      cand('K1', { shipBy: day(3), orderCreatedAt: day(1, 10) }),
    ]);
    expect(ids(q)).toEqual(['K2', 'K1', 'K3']);
  });
});

describe('planAllocation', () => {
  it('kiện đầu thiếu thì bỏ qua, kiện sau đủ thì chọn', () => {
    const q = [cand('K1', { lines: [{ variantId: A, quantity: 5 }] }), cand('K2', { lines: [{ variantId: A, quantity: 2 }] })];
    expect(ids(planAllocation(q, new Map([[A, 3]])))).toEqual(['K2']);
  });

  it('nguyên kiện: thiếu một SKU thì không chọn', () => {
    const q = [cand('K1', { lines: [{ variantId: A, quantity: 1 }, { variantId: B, quantity: 1 }] })];
    expect(planAllocation(q, new Map([[A, 1], [B, 0]]))).toEqual([]);
  });

  it('SKU không có trong bản đếm tính là 0', () => {
    expect(planAllocation([cand('K1')], new Map())).toEqual([]);
  });

  it('Review Focus 1: ba dòng cùng SKU tính theo tổng số', () => {
    const lines = [1, 2, 3].map(() => ({ variantId: A, quantity: 1 }));
    expect(planAllocation([cand('K1', { lines })], new Map([[A, 2]]))).toEqual([]);
    expect(ids(planAllocation([cand('K1', { lines })], new Map([[A, 3]])))).toEqual(['K1']);
  });

  it('bản đếm tạm trừ dần: hai kiện cùng cần A×2, có A = 3 thì chỉ chọn kiện đầu', () => {
    const q = [cand('K1', { lines: [{ variantId: A, quantity: 2 }] }), cand('K2', { lines: [{ variantId: A, quantity: 2 }] })];
    expect(ids(planAllocation(q, new Map([[A, 3]])))).toEqual(['K1']);
  });
});

describe('planReclaim (25 §7.4)', () => {
  const rc = (id: string, o: Partial<ReclaimCandidate> = {}): ReclaimCandidate => ({
    id,
    orderStatus: 'processing',
    reservedAt: day(1),
    lines: [{ variantId: A, quantity: 1 }],
    ...o,
  });

  it('đơn unpaid bị lấy trước đơn processing, dù giữ sớm hơn', () => {
    const r = planReclaim(new Map([[A, 1]]), [rc('P', { reservedAt: day(3) }), rc('U', { orderStatus: 'unpaid', reservedAt: day(1) })]);
    expect(ids(r)).toEqual(['U']);
  });

  it('trong nhóm, kiện giữ sau cùng bị lấy trước', () => {
    const r = planReclaim(new Map([[A, 1]]), [rc('S', { reservedAt: day(1, 9) }), rc('L', { reservedAt: day(1, 10) })]);
    expect(ids(r)).toEqual(['L']);
  });

  it('lấy đủ phần thiếu rồi dừng', () => {
    const two = [{ variantId: A, quantity: 2 }];
    const r = planReclaim(new Map([[A, 3]]), [
      rc('K9', { reservedAt: day(1, 9), lines: two }),
      rc('K10', { reservedAt: day(1, 10), lines: two }),
      rc('K8', { reservedAt: day(1, 8), lines: two }),
    ]);
    expect(ids(r)).toEqual(['K10', 'K9']);
  });

  it('kiện không chứa SKU thiếu không bị lấy; không thiếu gì thì rỗng', () => {
    expect(planReclaim(new Map([[A, 1]]), [rc('KB', { lines: [{ variantId: B, quantity: 1 }] })])).toEqual([]);
    expect(planReclaim(new Map(), [rc('K1')])).toEqual([]);
  });
});

describe('needOf', () => {
  it('gộp số lượng theo SKU', () => {
    expect(needOf([{ variantId: A, quantity: 1 }, { variantId: B, quantity: 2 }, { variantId: A, quantity: 3 }])).toEqual(
      new Map([[A, 4], [B, 2]]),
    );
  });
});

describe('planDismantle: kiện đã đóng cần kho kiểm lại sau phiếu kiểm kê (25 §7.4)', () => {
  const sealed = (id: string, lines: { variantId: string; quantity: number }[], needsAttention = false) => ({ id, needsAttention, lines });

  it('kiện đang giữ SKU còn thiếu sau khi lấy lại thì được chọn, kiện chỉ giữ SKU khác thì không', () => {
    const r = planDismantle(
      [sealed('KA', [{ variantId: A, quantity: 1 }]), sealed('KB', [{ variantId: B, quantity: 1 }]), sealed('KAB', [{ variantId: B, quantity: 1 }, { variantId: A, quantity: 2 }])],
      new Map([[A, 1]]),
    );
    expect(ids(r)).toEqual(['KA', 'KAB']);
  });

  it('kiện đã bật Cần xử lý thì giữ nguyên, không đè ghi chú', () => {
    expect(planDismantle([sealed('KA', [{ variantId: A, quantity: 1 }], true)], new Map([[A, 1]]))).toEqual([]);
  });

  it('hết thiếu (hoặc số thiếu không dương) thì không chọn kiện nào', () => {
    const k = [sealed('KA', [{ variantId: A, quantity: 1 }])];
    expect(planDismantle(k, new Map())).toEqual([]);
    expect(planDismantle(k, new Map([[A, 0]]))).toEqual([]);
  });
});
