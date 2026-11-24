// Checklist thiết lập ban đầu (#461, #569; Documents/21 mục 23): `done` của từng mục suy từ dữ liệu thật, không lưu cờ.
// Ngoại lệ có chủ đích: `completedAt` (`core.companies.onboarding_completed_at`) chỉ quyết định có ép vào wizard hay không.

// Bảy mục bắt buộc theo thứ tự làm (các bước của wizard `/welcome`), rồi ba mục tuỳ chọn (đổi 24/11/2026, #569).
export const ONBOARDING_KEYS = [
  'company_profile',
  'connect_shop',
  'link_skus',
  'assign_groups',
  'stock_sync',
  'order_cutoff',
  'opening_stock',
  'first_product',
  'invite_staff',
  'enable_report',
] as const;
export type OnboardingKey = (typeof ONBOARDING_KEYS)[number];

/** Quyền để thấy từng mục (bảng mục 23). */
export const ONBOARDING_PERMISSION: Readonly<Record<OnboardingKey, string>> = {
  company_profile: 'platform.company.manage',
  connect_shop: 'channel.shop.connect',
  link_skus: 'channel.shop.connect',
  assign_groups: 'channel.shop.connect',
  stock_sync: 'channel.shop.connect',
  order_cutoff: 'channel.shop.connect',
  opening_stock: 'inventory.receipt.create',
  first_product: 'catalog.product.manage',
  invite_staff: 'identity.account.manage',
  enable_report: 'platform.module.manage',
};

/** Quyền gọi `POST /onboarding/complete`: quyền của mục bắt buộc đầu tiên. */
export const COMPLETE_PERMISSION = ONBOARDING_PERMISSION.company_profile;

/** Quyền duyệt phiếu kho: người làm bước tồn đầu kỳ khi phiếu đang chờ duyệt. */
const APPROVE_PERMISSION = 'inventory.document.approve';

const OPTIONAL: ReadonlySet<OnboardingKey> = new Set(['first_product', 'invite_staff', 'enable_report']);
const REQUIRED_KEYS = ONBOARDING_KEYS.filter((k) => !OPTIONAL.has(k));

/** Ba bước của nháp thiết lập gian hàng có mốc xác nhận (Documents/21 mục 18.7.5). */
export type DraftStep = 'link_skus' | 'assign_groups' | 'stock_sync';
export type DraftConfirmed = Readonly<Record<DraftStep, string | null>>;

/** Trạng thái phiếu đầu kỳ chưa ghi sổ, chưa huỷ. */
export type OpeningDocStatus = 'draft' | 'pending' | 'rejected';

/** Kết quả các cổng đọc ở mục 11.3. */
export interface OnboardingFacts {
  profileFilled: boolean;
  team: { otherActiveMembers: number; invitations: number };
  shops: {
    connected: readonly { id: string; status: string }[];
    setUp: number;
    /** Gian hàng đang thiết lập (cũ nhất, chưa có `order_cutoff_at`, `connecting` hoặc `needs_reauth`) */
    current: { id: string; status: string; draftConfirmed: DraftConfirmed } | null;
  };
  hasProduct: boolean;
  /** Phân hệ `report` đang bật */
  reportEnabled: boolean;
  opening: { openingPosted: boolean; pendingOpening: { id: string; status: string } | null; hasMoves: boolean };
  /** ISO; mốc hoàn tất onboarding của công ty */
  completedAt: string | null;
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
  completedAt: string | null;
  /** Mục bắt buộc chưa xong đầu tiên của công ty, không lọc theo quyền */
  next: { key: OnboardingKey; mine: boolean } | null;
  mustWizard: boolean;
}

function shopStep(f: OnboardingFacts, step: DraftStep | null): { done: boolean; ref: OnboardingRef } {
  if (f.shops.setUp > 0) return { done: true, ref: null };
  const current = f.shops.current;
  return {
    done: step !== null && current !== null && current.draftConfirmed[step] !== null,
    ref: current ? { type: 'shop', id: current.id } : null,
  };
}

function state(key: OnboardingKey, f: OnboardingFacts): { done: boolean; ref: OnboardingRef } {
  switch (key) {
    case 'company_profile':
      return { done: f.profileFilled, ref: null };
    case 'connect_shop':
      return { done: f.shops.connected.length > 0, ref: null };
    case 'link_skus':
    case 'assign_groups':
    case 'stock_sync':
      return shopStep(f, key);
    case 'order_cutoff':
      return shopStep(f, null);
    case 'opening_stock': {
      const { openingPosted, pendingOpening, hasMoves } = f.opening;
      // Gian hàng đầu tiên bắt buộc kiểm kê đầu kỳ; chưa có gian hàng thì tồn vào qua phiếu nhận cũng tính.
      if (openingPosted || (!pendingOpening && hasMoves)) return { done: true, ref: null };
      return { done: false, ref: pendingOpening ? { type: 'stock_document', id: pendingOpening.id } : null };
    }
    case 'first_product':
      return { done: f.hasProduct, ref: null };
    case 'invite_staff':
      return { done: f.team.otherActiveMembers > 0 || f.team.invitations > 0, ref: null };
    case 'enable_report':
      return { done: f.reportEnabled, ref: null };
  }
}

/** Mục bắt buộc chưa xong, theo thứ tự bảng, không xét quyền (`POST /onboarding/complete`: `missing`). */
export function missingRequired(f: OnboardingFacts): OnboardingKey[] {
  return REQUIRED_KEYS.filter((key) => !state(key, f).done);
}

/** Quyền của người làm mục `key` lúc này; tồn đầu kỳ theo trạng thái phiếu (chờ duyệt thì người duyệt làm). */
function workerPermission(key: OnboardingKey, f: OnboardingFacts): string {
  if (key === 'opening_stock' && f.opening.pendingOpening?.status === 'pending') return APPROVE_PERMISSION;
  return ONBOARDING_PERMISSION[key];
}

/** `can(permission)`: quyền có hiệu lực của người xem (đã bỏ quyền của phân hệ đang tắt). */
export function onboardingItems(facts: OnboardingFacts, can: (permission: string) => boolean): Onboarding {
  const items = ONBOARDING_KEYS.filter((key) => can(ONBOARDING_PERMISSION[key])).map((key) => ({
    key,
    optional: OPTIONAL.has(key),
    ...state(key, facts),
  }));
  const required = items.filter((i) => !i.optional);
  const total = required.length;
  const nextKey = missingRequired(facts)[0];
  const next = nextKey ? { key: nextKey, mine: can(workerPermission(nextKey, facts)) } : null;
  const mustWizard = facts.completedAt === null && total > 0 && (next ? next.mine : can(COMPLETE_PERMISSION));
  return { items, done: required.filter((i) => i.done).length, total, completedAt: facts.completedAt, next, mustWizard };
}
