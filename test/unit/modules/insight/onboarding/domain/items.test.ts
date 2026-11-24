import { describe, expect, it } from 'vitest';
import {
  type DraftConfirmed,
  missingRequired,
  ONBOARDING_KEYS,
  type OnboardingFacts,
  onboardingItems,
} from '#src/modules/insight/onboarding/domain/items.ts';

const noDraft: DraftConfirmed = { link_skus: null, assign_groups: null, stock_sync: null };
const blank: OnboardingFacts = {
  profileFilled: false,
  team: { otherActiveMembers: 0, invitations: 0 },
  shops: { connected: [], setUp: 0, current: null },
  hasProduct: false,
  reportEnabled: false,
  opening: { openingPosted: false, pendingOpening: null, hasMoves: false },
  completedAt: null,
};
const all = () => true;
const only =
  (...perms: string[]) =>
  (p: string) =>
    perms.includes(p);
const item = (facts: OnboardingFacts, key: string) => onboardingItems(facts, all).items.find((i) => i.key === key)!;

const REQUIRED = ['company_profile', 'connect_shop', 'link_skus', 'assign_groups', 'stock_sync', 'order_cutoff', 'opening_stock'];

/** Công ty đã làm xong mọi mục bắt buộc. */
const finished: OnboardingFacts = {
  ...blank,
  profileFilled: true,
  shops: { connected: [{ id: 's', status: 'active' }], setUp: 1, current: null },
  opening: { openingPosted: true, pendingOpening: null, hasMoves: true },
};

/** Gian hàng đang thiết lập với các mốc xác nhận cho trước. */
const setting = (confirmed: Partial<DraftConfirmed>, status = 'connecting'): OnboardingFacts => ({
  ...blank,
  profileFilled: true,
  shops: { connected: [{ id: 's', status }], setUp: 0, current: { id: 's', status, draftConfirmed: { ...noDraft, ...confirmed } } },
});

describe('onboardingItems: mục (Documents/21 mục 23, đổi 24/11/2026)', () => {
  it('công ty mới: 7 mục bắt buộc theo thứ tự làm rồi 3 mục tuỳ chọn; chưa xong mục nào; total chỉ đếm mục bắt buộc', () => {
    const r = onboardingItems(blank, all);
    expect(r.items.map((i) => i.key)).toEqual([...ONBOARDING_KEYS]);
    expect(r.items.map((i) => i.key)).toEqual([...REQUIRED, 'first_product', 'invite_staff', 'enable_report']);
    expect(r.items.every((i) => !i.done && i.ref === null)).toBe(true);
    expect(r.items.filter((i) => i.optional).map((i) => i.key)).toEqual(['first_product', 'invite_staff', 'enable_report']);
    expect(r).toMatchObject({ done: 0, total: 7, completedAt: null });
  });

  it('mời nhân viên xong khi có thành viên ngoài CEO hoặc đã có lời mời; done không đổi', () => {
    expect(item({ ...blank, team: { otherActiveMembers: 0, invitations: 1 } }, 'invite_staff').done).toBe(true);
    expect(item({ ...blank, team: { otherActiveMembers: 1, invitations: 0 } }, 'invite_staff').done).toBe(true);
    expect(onboardingItems({ ...blank, team: { otherActiveMembers: 1, invitations: 0 } }, all).done).toBe(0);
  });

  it('bật Báo cáo chỉ hiện với người có platform.module.manage', () => {
    const r = onboardingItems(blank, only('platform.module.manage'));
    expect(r.items).toEqual([{ key: 'enable_report', done: false, optional: true, ref: null }]);
    expect(r).toMatchObject({ done: 0, total: 0 });
  });

  it('gian hàng đang thiết lập: bốn mục thiết lập trỏ tới gian hàng đó, xong theo mốc xác nhận của nháp', () => {
    const f = setting({ link_skus: '2026-11-24T10:00:00.000Z', assign_groups: '2026-11-24T10:00:00.000Z' });
    expect(item(f, 'connect_shop').done).toBe(true);
    expect(item(f, 'link_skus')).toMatchObject({ done: true, ref: { type: 'shop', id: 's' } });
    expect(item(f, 'assign_groups')).toMatchObject({ done: true, ref: { type: 'shop', id: 's' } });
    expect(item(f, 'stock_sync')).toMatchObject({ done: false, ref: { type: 'shop', id: 's' } });
    expect(item(f, 'order_cutoff')).toMatchObject({ done: false, ref: { type: 'shop', id: 's' } });
  });

  it('gian hàng đang thiết lập mất uỷ quyền: vẫn trỏ tới gian hàng đó, giữ mốc đã xác nhận', () => {
    const f = setting({ link_skus: '2026-11-24T10:00:00.000Z' }, 'needs_reauth');
    expect(item(f, 'link_skus')).toMatchObject({ done: true, ref: { type: 'shop', id: 's' } });
    expect(item(f, 'order_cutoff')).toMatchObject({ done: false, ref: { type: 'shop', id: 's' } });
  });

  it('có gian hàng đã hoàn tất thiết lập: bốn mục thiết lập xong, không trỏ đi đâu', () => {
    for (const key of ['link_skus', 'assign_groups', 'stock_sync', 'order_cutoff']) {
      expect(item(finished, key)).toMatchObject({ done: true, ref: null });
    }
  });

  it('tồn đầu kỳ: phiếu đầu kỳ đang mở thì chưa xong và trỏ tới phiếu, kể cả khi đã có thẻ kho', () => {
    const f = { ...blank, opening: { openingPosted: false, pendingOpening: { id: 'd', status: 'draft' as const }, hasMoves: true } };
    expect(item(f, 'opening_stock')).toMatchObject({ done: false, ref: { type: 'stock_document', id: 'd' } });
  });

  it('tồn đầu kỳ xong khi đã ghi sổ phiếu đầu kỳ (kể cả phiếu rỗng), hoặc chưa có phiếu đầu kỳ mà đã có thẻ kho', () => {
    expect(item({ ...blank, opening: { openingPosted: true, pendingOpening: null, hasMoves: false } }, 'opening_stock').done).toBe(true);
    expect(item({ ...blank, opening: { openingPosted: false, pendingOpening: null, hasMoves: true } }, 'opening_stock').done).toBe(true);
  });

  it('chỉ trả mục người xem có quyền, total đếm trên mục đã lọc; không quyền nào thì rỗng', () => {
    const r = onboardingItems({ ...blank, hasProduct: true }, only('catalog.product.manage', 'identity.account.manage'));
    expect(r.items.map((i) => i.key)).toEqual(['first_product', 'invite_staff']);
    expect(r).toMatchObject({ done: 0, total: 0 });
    expect(onboardingItems(blank, () => false)).toMatchObject({ items: [], done: 0, total: 0 });
  });
});

describe('onboardingItems: next, mustWizard', () => {
  it('next là mục bắt buộc chưa xong đầu tiên của công ty, không lọc theo quyền', () => {
    const r = onboardingItems(setting({ link_skus: 'x' }), only('inventory.receipt.create'));
    expect(r.next).toEqual({ key: 'assign_groups', mine: false });
  });

  it('CEO công ty mới: next là hồ sơ công ty, bị đưa vào wizard', () => {
    expect(onboardingItems(blank, all)).toMatchObject({ next: { key: 'company_profile', mine: true }, mustWizard: true });
  });

  it('Nhân viên kho khi CEO còn làm bước 1–6: không bị đưa vào wizard', () => {
    const r = onboardingItems(setting({}), only('inventory.receipt.create'));
    expect(r).toMatchObject({ next: { key: 'link_skus', mine: false }, mustWizard: false });
    expect(r.total).toBe(1);
  });

  it('bước tồn đầu kỳ, phiếu nháp hoặc bị từ chối: Nhân viên kho làm (mine), bị đưa vào wizard', () => {
    for (const status of ['draft', 'rejected'] as const) {
      const f = { ...finished, opening: { openingPosted: false, pendingOpening: { id: 'd', status }, hasMoves: false } };
      expect(onboardingItems(f, only('inventory.receipt.create'))).toMatchObject({
        next: { key: 'opening_stock', mine: true },
        mustWizard: true,
      });
    }
  });

  it('chưa có phiếu đầu kỳ nào: quyền lập phiếu là mine', () => {
    const f = { ...finished, opening: { openingPosted: false, pendingOpening: null, hasMoves: false } };
    expect(onboardingItems(f, only('inventory.receipt.create')).next).toEqual({ key: 'opening_stock', mine: true });
  });

  it('phiếu đầu kỳ chờ duyệt: Nhân viên kho ra khỏi wizard, CEO (quyền duyệt) bị đưa về bước 7', () => {
    const f = { ...finished, opening: { openingPosted: false, pendingOpening: { id: 'd', status: 'pending' as const }, hasMoves: false } };
    expect(onboardingItems(f, only('inventory.receipt.create'))).toMatchObject({
      next: { key: 'opening_stock', mine: false },
      mustWizard: false,
    });
    expect(onboardingItems(f, all)).toMatchObject({ next: { key: 'opening_stock', mine: true }, mustWizard: true });
  });

  it('mọi mục bắt buộc xong, chưa hoàn tất: next null, người có quyền hoàn tất bị giữ ở "Sẵn sàng bán", người khác không', () => {
    expect(onboardingItems(finished, all)).toMatchObject({ next: null, mustWizard: true, done: 7, total: 7 });
    expect(onboardingItems(finished, only('inventory.receipt.create', 'channel.shop.connect'))).toMatchObject({
      next: null,
      mustWizard: false,
    });
  });

  it('đã hoàn tất onboarding: không bao giờ đưa vào wizard, kể cả khi ngắt hết gian hàng', () => {
    const completedAt = '2026-11-24T10:00:00.000Z';
    const r = onboardingItems({ ...blank, completedAt }, all);
    expect(r).toMatchObject({ completedAt, mustWizard: false, next: { key: 'company_profile', mine: true } });
  });

  it('Sale không thấy mục bắt buộc nào: total 0, không bao giờ vào wizard', () => {
    const r = onboardingItems(blank, only('catalog.product.manage'));
    expect(r).toMatchObject({ total: 0, mustWizard: false, next: { key: 'company_profile', mine: false } });
  });
});

describe('missingRequired (POST /onboarding/complete)', () => {
  it('trả các key bắt buộc chưa xong theo thứ tự bảng, không xét quyền', () => {
    expect(missingRequired(setting({ link_skus: 'x', assign_groups: 'x' }))).toEqual(['stock_sync', 'order_cutoff', 'opening_stock']);
    expect(missingRequired(blank)).toEqual(REQUIRED);
  });

  it('mọi mục bắt buộc xong: rỗng', () => {
    expect(missingRequired(finished)).toEqual([]);
  });
});
