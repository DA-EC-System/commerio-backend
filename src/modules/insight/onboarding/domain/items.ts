// Checklist thiết lập ban đầu (#461, Documents/21 mục 23): suy từ dữ liệu thật, không lưu cờ.

export const ONBOARDING_KEYS = [
  'company_profile',
  'invite_staff',
  'connect_shop',
  'setup_shop',
  'first_product',
  'opening_stock',
] as const;
export type OnboardingKey = (typeof ONBOARDING_KEYS)[number];

/** Quyền để thấy từng mục (bảng mục 23). */
export const ONBOARDING_PERMISSION: Readonly<Record<OnboardingKey, string>> = {
  company_profile: 'platform.company.manage',
  invite_staff: 'identity.account.manage',
  connect_shop: 'channel.shop.connect',
  setup_shop: 'channel.shop.connect',
  first_product: 'catalog.product.manage',
  opening_stock: 'inventory.receipt.create',
};

const OPTIONAL: ReadonlySet<OnboardingKey> = new Set(['invite_staff']);

/** Kết quả các cổng đọc ở mục 11.3. */
export interface OnboardingFacts {
  profileFilled: boolean;
  team: { otherActiveMembers: number; invitations: number };
  shops: { connected: readonly { id: string; status: string }[]; setUp: number };
  hasProduct: boolean;
  opening: { openingPosted: boolean; pendingOpening: { id: string } | null; hasMoves: boolean };
}

export type OnboardingRef = { type: 'shop' | 'stock_document'; id: string } | null;

export interface OnboardingItem {
  key: OnboardingKey;
  done: boolean;
  optional: boolean;
  ref: OnboardingRef;
}

export interface Onboarding {
  items: OnboardingItem[];
  /** Chỉ đếm mục bắt buộc */
  done: number;
  total: number;
}

function state(key: OnboardingKey, f: OnboardingFacts): { done: boolean; ref: OnboardingRef } {
  switch (key) {
    case 'company_profile':
      return { done: f.profileFilled, ref: null };
    case 'invite_staff':
      return { done: f.team.otherActiveMembers > 0 || f.team.invitations > 0, ref: null };
    case 'connect_shop':
      return { done: f.shops.connected.length > 0, ref: null };
    case 'setup_shop': {
      if (f.shops.setUp > 0) return { done: true, ref: null };
      const pending = f.shops.connected.find((s) => s.status === 'connecting');
      return { done: false, ref: pending ? { type: 'shop', id: pending.id } : null };
    }
    case 'first_product':
      return { done: f.hasProduct, ref: null };
    case 'opening_stock': {
      const { openingPosted, pendingOpening, hasMoves } = f.opening;
      // Gian hàng đầu tiên bắt buộc kiểm kê đầu kỳ; chưa có gian hàng thì tồn vào qua phiếu nhận cũng tính.
      if (openingPosted || (!pendingOpening && hasMoves)) return { done: true, ref: null };
      return { done: false, ref: pendingOpening ? { type: 'stock_document', id: pendingOpening.id } : null };
    }
  }
}

/** `can(permission)`: quyền có hiệu lực của người xem (đã bỏ quyền của phân hệ đang tắt). */
export function onboardingItems(facts: OnboardingFacts, can: (permission: string) => boolean): Onboarding {
  const items = ONBOARDING_KEYS.filter((key) => can(ONBOARDING_PERMISSION[key])).map((key) => ({
    key,
    optional: OPTIONAL.has(key),
    ...state(key, facts),
  }));
  const required = items.filter((i) => !i.optional);
  return { items, done: required.filter((i) => i.done).length, total: required.length };
}
