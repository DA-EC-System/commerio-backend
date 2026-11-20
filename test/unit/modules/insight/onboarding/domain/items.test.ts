import { describe, expect, it } from 'vitest';
import { ONBOARDING_KEYS, type OnboardingFacts, onboardingItems } from '#src/modules/insight/onboarding/domain/items.ts';

const blank: OnboardingFacts = {
  profileFilled: false,
  team: { otherActiveMembers: 0, invitations: 0 },
  shops: { connected: [], setUp: 0 },
  hasProduct: false,
  opening: { openingPosted: false, pendingOpening: null, hasMoves: false },
};
const all = () => true;
const item = (facts: OnboardingFacts, key: string) => onboardingItems(facts, all).items.find((i) => i.key === key)!;

describe('onboardingItems (Documents/21 mục 23)', () => {
  it('công ty mới: đủ 6 mục đúng thứ tự, chưa xong mục nào; mời nhân viên là tuỳ chọn, không tính vào total', () => {
    const r = onboardingItems(blank, all);
    expect(r.items.map((i) => i.key)).toEqual([...ONBOARDING_KEYS]);
    expect(r.items.every((i) => !i.done && i.ref === null)).toBe(true);
    expect(r.items.filter((i) => i.optional).map((i) => i.key)).toEqual(['invite_staff']);
    expect(r).toMatchObject({ done: 0, total: 5 });
  });

  it('mời nhân viên xong khi có thành viên ngoài CEO hoặc đã có lời mời; done không đổi', () => {
    expect(item({ ...blank, team: { otherActiveMembers: 0, invitations: 1 } }, 'invite_staff').done).toBe(true);
    expect(item({ ...blank, team: { otherActiveMembers: 1, invitations: 0 } }, 'invite_staff').done).toBe(true);
    expect(onboardingItems({ ...blank, team: { otherActiveMembers: 1, invitations: 0 } }, all).done).toBe(0);
  });

  it('gian hàng đang kết nối chưa thiết lập: kết nối xong, thiết lập chưa xong và trỏ tới gian hàng cũ nhất đang chờ', () => {
    const facts = {
      ...blank,
      shops: { connected: [{ id: 'a', status: 'needs_reauth' }, { id: 'b', status: 'connecting' }, { id: 'c', status: 'connecting' }], setUp: 0 },
    };
    expect(item(facts, 'connect_shop').done).toBe(true);
    expect(item(facts, 'setup_shop')).toMatchObject({ done: false, ref: { type: 'shop', id: 'b' } });
  });

  it('có gian hàng đã hoàn tất thiết lập thì mục thiết lập xong, không trỏ đi đâu', () => {
    const facts = { ...blank, shops: { connected: [{ id: 'a', status: 'active' }, { id: 'b', status: 'connecting' }], setUp: 1 } };
    expect(item(facts, 'setup_shop')).toMatchObject({ done: true, ref: null });
  });

  it('tồn đầu kỳ: phiếu đầu kỳ đang mở thì chưa xong và trỏ tới phiếu, kể cả khi đã có thẻ kho', () => {
    const facts = { ...blank, opening: { openingPosted: false, pendingOpening: { id: 'd' }, hasMoves: true } };
    expect(item(facts, 'opening_stock')).toMatchObject({ done: false, ref: { type: 'stock_document', id: 'd' } });
  });

  it('tồn đầu kỳ xong khi đã ghi sổ phiếu đầu kỳ, hoặc chưa có phiếu đầu kỳ mà đã có thẻ kho', () => {
    expect(item({ ...blank, opening: { openingPosted: true, pendingOpening: { id: 'd' }, hasMoves: true } }, 'opening_stock').done).toBe(true);
    expect(item({ ...blank, opening: { openingPosted: false, pendingOpening: null, hasMoves: true } }, 'opening_stock').done).toBe(true);
  });

  it('chỉ trả mục người xem có quyền, total đếm trên mục đã lọc', () => {
    const r = onboardingItems({ ...blank, hasProduct: true }, (p) => p === 'catalog.product.manage' || p === 'identity.account.manage');
    expect(r.items.map((i) => i.key)).toEqual(['invite_staff', 'first_product']);
    expect(r).toMatchObject({ done: 1, total: 1 });
  });

  it('không có quyền nào: danh sách rỗng, 0/0', () => {
    expect(onboardingItems(blank, () => false)).toEqual({ items: [], done: 0, total: 0 });
  });
});
