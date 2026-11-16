// Link tới FE trong link mời và thư của luồng mời (#7 [C], Documents/21 mục 3.1). Một chỗ để mọi thư dùng cùng gốc.
import { env } from '../../../../shared/config/env.ts';

/** Gốc FE; máy dev chưa đặt `PUBLIC_WEB_URL` thì là Vite mặc định. Staging, production phải đặt. */
export const webBase = (): string => (env.PUBLIC_WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

export const joinLink = (token: string): string => `${webBase()}/tham-gia#${token}`;
export const pendingQueueLink = (): string => `${webBase()}/admin/staff?tab=pending`;
export const loginLink = (): string => `${webBase()}/login`;
