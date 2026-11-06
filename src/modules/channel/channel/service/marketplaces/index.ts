// Registry adapter theo sàn (#103 B7, mẫu `GatewayFactory` của payment). Thêm sàn = thêm một file và một dòng ở đây.
import { env } from '../../../../../shared/config/env.ts';
import { reservePlatformCall } from '../../repository/api-usage.ts';
import type { ConnectMethod, MarketplaceAdapter, ShopCapabilities } from './common.ts';
import { createLazadaAdapter } from './lazada.ts';
import { TIKTOK_RATE_LIMIT } from './tiktok-client.ts';
import { createTiktokAdapter } from './tiktok.ts';

export type * from './common.ts';
export { MarketplaceError } from './common.ts';

const lazada = createLazadaAdapter({
  appKey: env.LAZADA_APP_KEY,
  appSecret: env.LAZADA_APP_SECRET,
  redirectUrl: env.LAZADA_REDIRECT_URL,
  apiUrl: env.LAZADA_API_URL,
  authUrl: env.LAZADA_AUTH_URL,
  reserveCall: () => reservePlatformCall('lazada', env.LAZADA_DAILY_CALL_LIMIT),
});

const tiktok = createTiktokAdapter({
  appKey: env.TIKTOK_APP_KEY,
  appSecret: env.TIKTOK_APP_SECRET,
  serviceId: env.TIKTOK_SERVICE_ID,
  apiUrl: env.TIKTOK_API_URL,
  authUrl: env.TIKTOK_AUTH_URL,
  reserveCall: () => reservePlatformCall('tiktok', env.TIKTOK_DAILY_CALL_LIMIT),
  rateLimit: TIKTOK_RATE_LIMIT,
});

const defaults: Readonly<Record<string, MarketplaceAdapter>> = { lazada, tiktok };
let adapters: Record<string, MarketplaceAdapter> = { ...defaults };

/** Adapter của sàn, `undefined` khi chưa có (bên gọi trả 422 `marketplace_unsupported`). Khoá của Object (`toString`) không tính. */
export function getAdapter(platform: string): MarketplaceAdapter | undefined {
  return Object.hasOwn(adapters, platform) ? adapters[platform] : undefined;
}

/** Sàn đăng ký mặc định (không tính adapter test thay); test kiểm mọi sàn có trong enum DB. */
export function registeredPlatforms(): string[] {
  return Object.keys(defaults);
}

/**
 * Sàn chưa có adapter mà vẫn hiện cho người dùng (Documents/21 §18.7.3), kèm lý do. Sàn có adapter đăng ký thì theo
 * adapter, mục ở đây bỏ qua. TikTok có adapter từ commerio-backend#217 nên không còn mục khai sẵn.
 */
const PLANNED: readonly { platform: string; name: string; reason: string }[] = [
  { platform: 'shopee', name: 'Shopee', reason: 'Shopee chưa cấp quyền API cho ứng dụng sinh viên' },
];

/** Không bao giờ hiện cho người dùng, kể cả khi có adapter đăng ký dưới mã này (§18.7.3). */
const HIDDEN = new Set(['mock']);

export interface PlatformEntry {
  platform: string;
  name: string;
  connectable: boolean;
  /** Câu cho người đọc khi `connectable: false`; null khi nối được. Không chứa khoá, URL, tên biến môi trường. */
  reason: string | null;
  methods: readonly ConnectMethod[];
  capabilities: ShopCapabilities;
}

/**
 * Mọi sàn hiện cho người dùng (#163, §18.7.3): adapter đăng ký theo thứ tự đăng ký, rồi sàn chưa có adapter. Adapter
 * khai ít nhất một cách nối (đủ cấu hình) thì `connectable: true`; khai rỗng là môi trường chưa cấu hình sàn đó.
 */
export function platformEntries(): PlatformEntry[] {
  const fromAdapters = Object.entries(adapters)
    .filter(([platform]) => !HIDDEN.has(platform))
    .map(([platform, adapter]): PlatformEntry => {
      const methods = adapter.connectMethods();
      const connectable = methods.length > 0;
      return {
        platform,
        name: adapter.name,
        connectable,
        reason: connectable ? null : `Môi trường này chưa cấu hình kết nối ${adapter.name}`,
        methods,
        capabilities: adapter.capabilities,
      };
    });
  const planned = PLANNED.filter((p) => !Object.hasOwn(adapters, p.platform)).map(
    (p): PlatformEntry => ({ ...p, connectable: false, methods: [], capabilities: CAUTIOUS }),
  );
  return [...fromAdapters, ...planned];
}

/** Không có adapter (sàn bị gỡ): giả định thận trọng thay vì 500 (#200 A9). */
const CAUTIOUS: ShopCapabilities = { listingReview: true, hideBy: 'zero_stock', splitLevel: 'none', returnWindow: 'platform_status' };

/** Năng lực của sàn theo adapter đang đăng ký. */
export function capabilitiesOf(platform: string): ShopCapabilities {
  return getAdapter(platform)?.capabilities ?? CAUTIOUS;
}

/** Test thay adapter thật bằng adapter giả; `resetAdapters()` trả lại như cũ. */
export function registerAdapter(platform: string, adapter: MarketplaceAdapter): void {
  adapters[platform] = adapter;
}

export function resetAdapters(): void {
  adapters = { ...defaults };
}
