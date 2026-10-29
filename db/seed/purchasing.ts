import { allPages, type SeedApi } from './api.ts';
import type { SeedProduct } from './catalog.ts';

interface Request { id: string; note: string; version: number; status: string }
const scenarios = [[], ['submit'], ['submit', 'approve'], ['submit', 'request_changes'],
  ['submit', 'reject'], ['submit', 'approve', 'order'], ['submit', 'approve']] as const;

export async function seedPurchasing(ceo: SeedApi, buyer: SeedApi, products: SeedProduct[], now: Date) {
  const suppliers = await ceo<{ id: string; name: string }[]>('GET', '/purchasing/suppliers');
  const ids: string[] = [];
  for (const name of ['[DEMO] Xưởng may Sao Giả Lập', '[DEMO] Phụ kiện Mây Giả Lập', '[DEMO] Dệt Vải Giả Lập']) {
    const supplier = suppliers.find((s) => s.name === name) ?? await buyer<{ id: string }>('POST', '/purchasing/suppliers', {
      name, email: `supplier${ids.length + 1}@example.invalid`, address: 'Khu dữ liệu giả lập', note: 'Chỉ dùng demo',
    });
    ids.push(supplier.id);
  }
  const existing = await allPages<Request>(ceo, '/purchasing/requests');
  for (const [index, actions] of scenarios.entries()) {
    const note = `[DEMO:v1:purchase:${index + 1}]`;
    // Chứng từ đã tồn tại thuộc về người dùng sau lần tạo; không tua lại trạng thái khi chạy lại.
    if (existing.some((r) => r.note === note)) continue;
    const author = index === 6 ? ceo : buyer;
    let request = await author<Request>('POST', '/purchasing/requests', {
      supplierId: ids[index % ids.length], note,
      lines: products.slice(0, 3).map((p, i) => ({ variantId: p.variants[0]!.id, quantity: 10 + index + i, unitCost: 65000 + i * 15000 })),
    });
    for (const action of actions) {
      const actor = action === 'submit' || action === 'order' ? author : ceo;
      request = await actor<Request>('POST', `/purchasing/requests/${request.id}/${action}`, {
        version: request.version, reason: 'Tình huống kiểm thử demo',
        expectedDeliveryDate: new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10),
      });
    }
  }
  return { suppliers: ids.length, requests: scenarios.length };
}
