// Điều khiển sàn giả lập Lazada (#115): nạp kịch bản vào WireMock, chuyển bước, gửi push có ký vào webhook của app,
// kiểm adapter của app gọi được sàn giả lập. Cách chạy: scripts/lazada-mock/README.md
import { createLazadaAdapter } from '../../src/modules/channel/channel/service/marketplaces/lazada.ts';
import { signPush, signRequest } from './sign.ts';
import { initialStates, ITEMS, mappingsFor, ORDER_ID, type Scenario, SCENARIOS, SELLER } from './stubs.ts';

const ADMIN = process.env.LAZADA_MOCK_ADMIN_URL ?? 'http://127.0.0.1:8091';
const GATE = process.env.LAZADA_MOCK_URL ?? 'http://127.0.0.1:8090';
const WEBHOOK = process.env.LAZADA_MOCK_WEBHOOK_URL ?? 'http://localhost:3000/api/v1/channel/webhooks/lazada';
const APP_KEY = process.env.LAZADA_MOCK_APP_KEY ?? 'mock-app-key';
const APP_SECRET = process.env.LAZADA_MOCK_APP_SECRET ?? 'mock-app-secret';
// Giá trị `message_type` lấy theo ví dụ ở lazada.md §8 (0: đơn); đơn ngược chưa đối chiếu trang Push Mechanism.
const MESSAGE_TYPE = { order: 0, reverse: 10 } as const;

async function admin(method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${ADMIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Không gọi được WireMock ở ${ADMIN}. Bật bằng: docker compose -f deploy/compose.yaml --profile lazada-mock up -d`);
  }
  if (!res.ok) throw new Error(`WireMock ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function scenarioOf(name: string | undefined): Scenario {
  const s = name ? SCENARIOS[name] : undefined;
  if (!s) throw new Error(`Kịch bản không có: ${name ?? '(trống)'}. Xem: npm run mock:lazada -- list`);
  return s;
}

/** Kịch bản đang nạp: ghi trong `metadata` của mapping bắt mọi đường dẫn. */
async function loaded(): Promise<string> {
  const { mappings } = (await admin('GET', '/__admin/mappings')) as { mappings: { metadata?: { kichBan?: string } }[] };
  const name = mappings.find((m) => m.metadata?.kichBan)?.metadata?.kichBan;
  if (!name) throw new Error('Chưa nạp kịch bản nào: npm run mock:lazada -- load <kịch bản>');
  return name;
}

async function states(): Promise<Record<string, string>> {
  const { scenarios } = (await admin('GET', '/__admin/scenarios')) as { scenarios: { name: string; state: string }[] };
  return Object.fromEntries(scenarios.map((s) => [s.name, s.state]));
}

async function load(name: string) {
  const s = scenarioOf(name);
  const mappings = mappingsFor(s).map((m) => (m.priority === 10 ? { ...m, metadata: { kichBan: name } } : m));
  await admin('POST', '/__admin/mappings/import', { mappings, importOptions: { duplicatePolicy: 'OVERWRITE', deleteAllNotInImport: true } });
  await admin('POST', '/__admin/scenarios/reset');
  for (const [scenario, state] of Object.entries(initialStates(s))) await admin('PUT', `/__admin/scenarios/${scenario}/state`, { state });
  console.log(`Đã nạp "${name}" (${s.title}): ${mappings.length} mapping. Trạng thái:`, await states());
}

async function push(kind: 'order' | 'reverse', status: string) {
  const now = Math.floor(Date.now() / 1000);
  for (const item of kind === 'order' ? ITEMS : ITEMS.slice(0, 1)) {
    const data =
      kind === 'order'
        ? { order_status: status, status_update_time: now, trade_order_id: String(ORDER_ID), trade_order_line_id: String(item.order_item_id) }
        : {
            reverse_status: status,
            status_update_time: now,
            trade_order_id: String(ORDER_ID),
            trade_order_line_id: String(item.order_item_id),
            reverse_order_id: '700000000000001',
            reverse_order_line_id: '700000000000101',
          };
    const raw = JSON.stringify({ seller_id: String(SELLER.seller_id), message_type: MESSAGE_TYPE[kind], data, timestamp: now, site: 'lazada_vn' });
    try {
      const res = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: signPush(raw, APP_KEY, APP_SECRET) },
        body: raw,
      });
      console.log(`  push ${kind} ${status} dòng ${item.order_item_id} → HTTP ${res.status}`);
    } catch {
      console.log(`  push ${kind} ${status}: không gọi được ${WEBHOOK} (app chưa chạy?)`);
    }
  }
}

/** Đi tới trạng thái sau: đơn trước, hết đơn thì yêu cầu trả. Gửi push như Lazada báo thay đổi. */
async function next(): Promise<boolean> {
  const s = scenarioOf(await loaded());
  const now = await states();
  const steps: [string, readonly string[], 'order' | 'reverse'][] = [['don', s.order, 'order']];
  if (s.reverse) steps.push(['tra', s.reverse.states, 'reverse']);
  for (const [scenario, path, kind] of steps) {
    const at = path.indexOf(now[scenario] ?? '');
    if (at < 0 || at === path.length - 1) continue;
    const to = path[at + 1]!;
    await admin('PUT', `/__admin/scenarios/${scenario}/state`, { state: to });
    console.log(`${scenario}: ${path[at]} → ${to}`);
    await push(kind, to);
    return true;
  }
  console.log('Kịch bản đã tới bước cuối:', now);
  return false;
}

async function signedGet(apiPath: string, params: Record<string, string>, secret = APP_SECRET) {
  const all = { app_key: APP_KEY, timestamp: String(Date.now()), sign_method: 'sha256', access_token: 'mock-access-token', ...params };
  const query = new URLSearchParams({ ...all, sign: signRequest(apiPath, all, secret) });
  return (await (await fetch(`${GATE}/rest${apiPath}?${query}`)).json()) as Record<string, unknown>;
}

/** Kiểm sàn giả lập bằng chính adapter của app (#103, #104) và vài lệnh gọi có ký. */
async function check() {
  const results: [string, boolean, string][] = [];
  const expect = (name: string, pass: boolean, detail = '') => results.push([name, pass, detail]);

  const bad = await signedGet('/seller/get', {}, 'sai-secret');
  expect('ký sai → IncompleteSignature', bad.code === 'IncompleteSignature', String(bad.code));

  const adapter = createLazadaAdapter({ appKey: APP_KEY, appSecret: APP_SECRET, redirectUrl: 'http://localhost:5173/cb', apiUrl: `${GATE}/rest`, authUrl: GATE });
  try {
    const token = await adapter.exchangeCode('mock-code');
    expect('adapter.exchangeCode', token.accessToken.startsWith('mock-access-token'));
    const seller = await adapter.getSeller(token.accessToken);
    expect('adapter.getSeller', seller.externalShopId === String(SELLER.seller_id), seller.shopName);
    const cats = await adapter.listCategories(token.accessToken);
    expect('adapter.listCategories', cats.length > 0, cats.map((c) => c.name).join('; '));
    const skus = await adapter.getSkus(token.accessToken, ITEMS.map((i) => i.sku));
    expect('adapter.getSkus', skus.length === ITEMS.length, skus.map((x) => `${x.sellerSku}:${x.state}`).join(', '));
    const pq = await adapter.updatePriceQuantity(token.accessToken, [
      { externalProductId: String(ITEMS[0].item_id), externalSkuId: String(ITEMS[0].sku_id), price: '129000', quantity: 10 },
    ]);
    expect('adapter.updatePriceQuantity', pq.every((r) => r.ok), JSON.stringify(pq));
  } catch (err) {
    expect('adapter', false, String(err));
  }
  const orders = await signedGet('/orders/get', { created_after: '2026-10-01T00:00:00+07:00' });
  const first = (orders.data as { orders?: { statuses?: string[] }[] } | undefined)?.orders?.[0];
  expect('/orders/get', orders.code === '0', `${(await loaded())}: ${first?.statuses?.join(',') ?? '(không có đơn)'}`);

  for (const [name, pass, detail] of results) console.log(`${pass ? 'ĐẠT ' : 'LỖI '} ${name}${detail ? `  (${detail})` : ''}`);
  if (results.some(([, pass]) => !pass)) process.exitCode = 1;
}

const [command, arg] = process.argv.slice(2);
const commands: Record<string, () => Promise<unknown>> = {
  list: async () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      console.log(`${name.padEnd(16)} ${s.title}\n${' '.repeat(17)}đơn: ${s.order.join(' → ')}${s.reverse ? `\n${' '.repeat(17)}trả (${s.reverse.type}): ${s.reverse.states.join(' → ')}` : ''}`);
    }
  },
  load: () => load(arg ?? ''),
  next,
  run: async () => {
    await load(arg ?? '');
    while (await next());
  },
  state: async () => console.log(await loaded(), await states()),
  push: async () => push('order', arg ?? (await states()).don ?? 'pending'),
  check,
};

const run = commands[command ?? ''];
if (!run) {
  console.log('Lệnh: list | load <kịch bản> | next | run <kịch bản> | state | push [order_status] | check');
  process.exitCode = 1;
} else {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
