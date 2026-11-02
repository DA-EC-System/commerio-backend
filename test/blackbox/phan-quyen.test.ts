import { describe, expect, inject, it } from 'vitest';
import { BUILTIN_ROLES } from '#src/modules/core/access/domain/catalog.ts';
import { api, type Role } from './lib/client.ts';
import { served } from './lib/contract.ts';

// Ma trận quyền (Documents/kiem-thu/ma-tran-quyen.md, sinh từ BUILTIN_ROLES) kiểm trên route đọc của server: vai trò
// có một trong các quyền của route thì 200, không thì 403 `forbidden`. Chỉ route GET để không đổi dữ liệu.

const tokens = inject('tokens');
const ROLE_OF: Record<Exclude<Role, 'lead' | 'ceoB'>, keyof typeof BUILTIN_ROLES> = {
  ceo: 'ceo',
  admin: 'admin',
  sale: 'sale',
  kho: 'kho',
  buyer: 'buyer',
};

/** Route đọc và quyền mở nó (`anyOf` thì liệt kê đủ). */
const ROUTES: [route: string, permissions: string[]][] = [
  ['GET /catalog/products', ['catalog.product.view']],
  ['GET /catalog/categories', ['catalog.product.view']],
  ['GET /inventory/stock', ['inventory.stock.view']],
  ['GET /purchasing/requests', ['purchasing.request.manage', 'purchasing.request.approve', 'purchasing.receipt.manage', 'purchasing.return.manage']],
  ['GET /purchasing/suppliers', ['purchasing.request.manage', 'purchasing.request.approve', 'purchasing.receipt.manage', 'purchasing.return.manage']],
  ['GET /finance/invoices', ['finance.invoice.view']],
  ['GET /finance/payment-vouchers', ['finance.invoice.view']],
  ['GET /identity/staff', ['identity.account.view']],
  ['GET /identity/roles', ['identity.role.view', 'identity.account.view']],
  ['GET /channel/shops', ['channel.shop.view']],
];

const live = (await Promise.all(ROUTES.map(async (r) => ((await served(r[0])) ? [r] : [])))).flat();
const cases = Object.entries(ROLE_OF).flatMap(([role, builtin]) =>
  live.map(([route, permissions]) => {
    const held: readonly string[] = BUILTIN_ROLES[builtin].permissions;
    return [role as Role, route, permissions.some((p) => held.includes(p)) ? 200 : 403] as const;
  }),
);

describe('ma trận quyền trên route đọc', () => {
  it.each(cases)('%s gọi %s nhận %i', async (role, route, expected) => {
    const res = await api(tokens[role]).get(route.split(' ')[1]!);
    expect([res.status, expected === 403 ? res.body.code : undefined], JSON.stringify(res.body)).toEqual([
      expected,
      expected === 403 ? 'forbidden' : undefined,
    ]);
  });
});
