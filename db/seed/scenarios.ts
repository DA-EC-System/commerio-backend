import { OPTIONAL_MODULES } from '#src/modules/core/index.ts';
import { withSessionLock } from '#src/shared/db/client.ts';
import { openSeedApi } from './api.ts';
import { seedCatalog } from './catalog.ts';
import { defaultDemo, demoCompanyId, seedDemo, type SeedDemoInput } from './demo.ts';
import { seedInventory } from './inventory.ts';
import { seedPurchasing } from './purchasing.ts';

export const SECTIONS = ['all', 'catalog', 'inventory', 'purchasing', 'secondary'] as const;
export type SeedSection = typeof SECTIONS[number];

export function parseSection(args: string[]): SeedSection {
  if (!args.length) return 'all';
  if (args.length === 2 && args[0] === '--only' && SECTIONS.includes(args[1] as SeedSection)) return args[1] as SeedSection;
  throw new Error(`Cú pháp: npm run db:seed -- --only ${SECTIONS.join('|')}`);
}

export function secondaryDemo(password: string): SeedDemoInput {
  const input = defaultDemo(password);
  return { ...input, company: { name: 'Công ty Demo Cách Ly', taxCode: '0000000038' },
    accounts: { ...input.accounts, ceo: { email: 'ceo2@commerio.dev', fullName: 'CEO Demo Cách Ly' } } };
}

export async function seedScenarios(input: SeedDemoInput, options: {
  only?: SeedSection; secondary?: SeedDemoInput; now?: Date;
} = {}) {
  const result = await withSessionLock(`demo-seed:${input.accounts.ceo.email}`, async () => {
    const { companyId } = await seedDemo(input);
    const server = await openSeedApi();
    try {
      const ceo = await server.as(companyId, input.accounts.ceo.email, input.password);
      const modules = await ceo<{ code: string; enabled: boolean }[]>('GET', '/platform/modules');
      for (const code of OPTIONAL_MODULES) {
        if (!modules.find((m) => m.code === code)?.enabled) await ceo('PUT', `/platform/modules/${code}`, { enabled: true, aiConsent: true });
      }
      const only = options.only ?? 'all';
      const summary: Record<string, unknown> = { companyId, accounts: Object.values(input.accounts).length, modules: OPTIONAL_MODULES.length };
      if (only !== 'secondary') {
        const products = await seedCatalog(ceo);
        summary.catalog = { products: products.length, variants: products.reduce((n, p) => n + p.variants.length, 0) };
        if (only === 'all' || only === 'inventory') summary.inventory = await seedInventory(ceo, products);
        if (only === 'all' || only === 'purchasing') {
          if (!input.accounts.buyer) throw new Error('Cần tài khoản buyer cho seed purchasing');
          const buyer = await server.as(companyId, input.accounts.buyer.email, input.password);
          summary.purchasing = await seedPurchasing(ceo, buyer, products, options.now ?? new Date());
        }
      }
      if (only === 'all' || only === 'secondary') {
        const second = options.secondary ?? secondaryDemo(input.password);
        const secondId = await demoCompanyId(second);
        const api = await server.as(secondId, second.accounts.ceo.email, second.password);
        const products = await seedCatalog(api, true);
        summary.secondary = { companyId: secondId, accounts: 1, products: products.length };
      }
      return summary;
    } finally { await server.close(); }
  });
  if (result === 'busy') throw new Error('Một tiến trình khác đang seed công ty này; chạy lại sau');
  return result;
}
