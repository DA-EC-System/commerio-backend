// Registry adapter theo sàn (#103 B7, mẫu `GatewayFactory` của payment). Thêm sàn = thêm một file và một dòng ở đây.
import { env } from '../../../../../shared/config/env.ts';
import type { MarketplaceAdapter } from './common.ts';
import { createLazadaAdapter } from './lazada.ts';

export type * from './common.ts';
export { MarketplaceError } from './common.ts';

const lazada = createLazadaAdapter({
  appKey: env.LAZADA_APP_KEY,
  appSecret: env.LAZADA_APP_SECRET,
  redirectUrl: env.LAZADA_REDIRECT_URL,
  apiUrl: env.LAZADA_API_URL,
  authUrl: env.LAZADA_AUTH_URL,
});

const defaults: Readonly<Record<string, MarketplaceAdapter>> = { lazada };
let adapters: Record<string, MarketplaceAdapter> = { ...defaults };

/** Adapter của sàn, `undefined` khi chưa có (bên gọi trả 422 `marketplace_unsupported`). */
export function getAdapter(platform: string): MarketplaceAdapter | undefined {
  return adapters[platform];
}

/** Test thay adapter thật bằng adapter giả; `resetAdapters()` trả lại như cũ. */
export function registerAdapter(platform: string, adapter: MarketplaceAdapter): void {
  adapters[platform] = adapter;
}

export function resetAdapters(): void {
  adapters = { ...defaults };
}
