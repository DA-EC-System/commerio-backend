// Registry adapter theo sàn (#103 B7, mẫu `GatewayFactory` của payment). Thêm sàn = thêm một file và một dòng ở đây.
import { env } from '../../../../../shared/config/env.ts';
import { reservePlatformCall } from '../../repository/api-usage.ts';
import type { ConnectMethod, MarketplaceAdapter, ShopCapabilities } from './common.ts';
import { createLazadaAdapter } from './lazada.ts';
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

/** Sàn nối được trên môi trường này, theo thứ tự đăng ký; mỗi adapter tự khai cách nối (#163) và năng lực (#200). */
export function connectablePlatforms(): {
  platform: string;
  name: string;
  methods: readonly ConnectMethod[];
  capabilities: ShopCapabilities;
}[] {
  return Object.entries(adapters)
    .map(([platform, adapter]) => ({
      platform,
      name: adapter.name,
      methods: adapter.connectMethods(),
      capabilities: adapter.capabilities,
    }))
    .filter((p) => p.methods.length > 0);
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
