// Dùng router công khai: cùng validate, phân quyền, RLS và service như Swagger.
import { once } from 'node:events';
import { createApp } from '#src/app.ts';
import { findAccountByEmail, loadCompanyAccess, verifyPassword } from '#src/modules/core/index.ts';
import { signAccessToken } from '#src/shared/auth/jwt.ts';

export type SeedApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export async function openSeedApi() {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Không mở được API seed');
  return {
    async as(companyId: string, email: string, password: string): Promise<SeedApi> {
      const account = await findAccountByEmail(email);
      if (!account || !(await verifyPassword(account.passwordHash, password))) throw new Error('Sai tài khoản seed');
      const access = await loadCompanyAccess(account.id, companyId);
      if (!access) throw new Error('Tài khoản seed không thuộc công ty');
      // Không tạo refresh token khi seed; router vẫn đọc lại quyền và trạng thái từ DB.
      const token = await signAccessToken({
        accountId: account.id, companyId, permissions: access.permissions,
        mustChangePassword: account.mustChangePassword,
        passwordChangedAt: access.passwordChangedAt?.getTime() ?? null,
      });
      return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
          method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result = response.status === 204 ? null : await response.json();
        if (!response.ok) throw new Error(`Seed ${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
        return result as T;
      };
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
      server.closeIdleConnections();
    }),
  };
}

export async function allPages<T>(api: SeedApi, path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const next = await api<{ items: T[]; total: number }>('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=100&page=${page}`);
    result.push(...next.items);
    if (result.length >= next.total || !next.items.length) return result;
  }
}
