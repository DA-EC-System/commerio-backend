// Stub WireMock của sàn giả lập Lazada (#115): dữ liệu demo "Công ty Thời trang ABC bán áo thun" và các kịch bản có
// trạng thái. Tên trường theo Documents/tich-hop-san/lazada.md §7–§9 và adapter của #103, #104. Response của API ghi
// (pack, RTS, huỷ, trả hàng) và tài chính dựng theo API Reference, chưa đối chiếu response thật: xem README.

export interface Mapping {
  name: string;
  priority: number;
  scenarioName?: string;
  requiredScenarioState?: string;
  newScenarioState?: string;
  request: Record<string, unknown>;
  response: { status: number; headers: Record<string, string>; jsonBody: unknown };
}

export interface Scenario {
  title: string;
  /** Trạng thái đơn theo thứ tự; `next` đi tới trạng thái sau. Pack, RTS do app gọi cũng chuyển trạng thái. */
  order: readonly string[];
  /** Yêu cầu trả của khách cho món đầu tiên, sau khi đơn đã giao. */
  reverse?: { type: 'RETURN' | 'ONLY_REFUND'; states: readonly string[] };
  /** Quyết toán lệch: phí cố định 8% thay vì 4% của cấu hình, thêm phí quảng cáo. */
  mismatch?: boolean;
  /** Token đã hết hạn từ đầu; kết nối lại (đổi `code` lấy token) thì hết lỗi. */
  tokenExpired?: boolean;
}

const SHIP = ['pending', 'packed', 'ready_to_ship', 'shipped'] as const;

export const SCENARIOS: Record<string, Scenario> = {
  'giao-thanh-cong': { title: 'Giao thành công', order: [...SHIP, 'delivered'] },
  'giao-that-bai': { title: 'Giao thất bại rồi hoàn về kho', order: [...SHIP, 'failed_delivery', 'shipped_back', 'shipped_back_success'] },
  'that-lac': { title: 'Thất lạc khi đang giao', order: [...SHIP, 'lost_by_3pl'] },
  'tra-mot-phan': {
    title: 'Khách trả một trong hai món',
    order: ['delivered'],
    reverse: { type: 'RETURN', states: ['REQUEST_INITIATE', 'AGREE_RETURN', 'BUYER_RETURN_ITEM', 'REFUND_SUCCESS'] },
  },
  'chi-hoan-tien': {
    title: 'Chỉ hoàn tiền, khách giữ hàng',
    order: ['delivered'],
    reverse: { type: 'ONLY_REFUND', states: ['REQUEST_INITIATE', 'REFUND_SUCCESS'] },
  },
  'quyet-toan-lech': { title: 'Quyết toán lệch so với phí cấu hình', order: ['delivered'], mismatch: true },
  'token-het-han': { title: 'Token hết hạn, cần kết nối lại', order: ['pending'], tokenExpired: true },
};

// ── Dữ liệu demo ─────────────────────────────────────────────────────────────────────────────────────────────────
export const SELLER = { seller_id: 200000000001, name: 'Thời trang ABC', short_code: 'VNABC001', email: 'shop-abc@example.com' };
export const ORDER_ID = 600000000000001;
const CREATED = '2026-10-28 09:15:00 +0700';
const PACKAGE_ID = 'FP600000000000001';
const TRACKING = 'LZVN0000000001';
const PROVIDER = 'LEX VN';
const PRICE = 129000;
const SHIPPING_FEE = 30000;

export const ITEMS = [
  { order_item_id: 600000000000101, sku: 'ATH-TRANG-M', sku_id: 13000000001, item_id: 2300000001, name: 'Áo thun cotton ABC', variation: 'Màu: Trắng, Size: M' },
  { order_item_id: 600000000000102, sku: 'ATH-DEN-L', sku_id: 13000000002, item_id: 2300000002, name: 'Áo thun cotton ABC', variation: 'Màu: Đen, Size: L' },
] as const;

const PACKED_OR_LATER = new Set(['packed', 'ready_to_ship', 'shipped', 'delivered', 'failed_delivery', 'shipped_back', 'shipped_back_success', 'lost_by_3pl']);
const RTS_OR_LATER = new Set([...PACKED_OR_LATER].filter((s) => s !== 'packed'));

const ok = (body: Record<string, unknown>) => ({ code: '0', request_id: 'mock-request', ...body });
const err = (code: string, message: string, type = 'ISV') => ({ type, code, message, request_id: 'mock-request' });

function order(status: string) {
  return {
    order_id: ORDER_ID,
    order_number: ORDER_ID,
    created_at: CREATED,
    updated_at: CREATED,
    price: (PRICE * ITEMS.length).toFixed(2),
    payment_method: 'COD',
    items_count: ITEMS.length,
    statuses: [status],
    warehouse_code: 'dropshipping',
    shipping_fee: SHIPPING_FEE,
    shipping_fee_original: SHIPPING_FEE,
    voucher: 0,
    voucher_platform: 0,
    voucher_seller: 0,
    customer_first_name: 'N***',
    customer_last_name: '',
    address_shipping: { first_name: 'N***', last_name: '', phone: '******789', address1: '*** Lý Thường Kiệt', city: 'Hồ Chí Minh', country: 'Vietnam' },
    remarks: '',
    gift_option: false,
  };
}

function items(status: string) {
  const packed = PACKED_OR_LATER.has(status);
  return ITEMS.map((i) => ({
    order_item_id: i.order_item_id,
    order_id: ORDER_ID,
    sku: i.sku,
    shop_sku: `${i.item_id}_VNAMZ-${i.sku_id}`,
    sku_id: i.sku_id,
    name: i.name,
    variation: i.variation,
    status,
    item_price: PRICE,
    paid_price: PRICE,
    shipping_type: 'Dropshipping',
    shipment_provider: packed ? PROVIDER : '',
    tracking_code: packed ? TRACKING : '',
    package_id: packed ? PACKAGE_ID : '',
    is_digital: 0,
    reason: '',
    created_at: CREATED,
    updated_at: CREATED,
    warehouse_code: 'dropshipping',
  }));
}

const TRACE_STEPS: Record<string, { status_code: string; description: string }> = {
  ready_to_ship: { status_code: 'ready_to_ship', description: 'Người bán đã sẵn sàng giao' },
  shipped: { status_code: 'shipped', description: 'Đơn vị vận chuyển đã lấy hàng' },
  delivered: { status_code: 'delivered', description: 'Giao hàng thành công' },
  failed_delivery: { status_code: 'failed_delivery', description: 'Giao không thành công: khách không nghe máy' },
  shipped_back: { status_code: 'shipped_back', description: 'Đang hoàn hàng về người bán' },
  shipped_back_success: { status_code: 'shipped_back_success', description: 'Đã hoàn hàng về người bán' },
  lost_by_3pl: { status_code: 'lost_by_3pl', description: 'Kiện thất lạc trong quá trình vận chuyển' },
};

function trace(path: readonly string[], status: string) {
  const reached = path.slice(0, path.indexOf(status) + 1).filter((s) => TRACE_STEPS[s]);
  return ok({
    result: {
      success: true,
      module: [
        {
          order_id: String(ORDER_ID),
          package_detail_info_list: RTS_OR_LATER.has(status)
            ? [
                {
                  ofc_package_id: PACKAGE_ID,
                  tracking_number: TRACKING,
                  logistic_detail_info_list: reached.map((s, n) => ({ ...TRACE_STEPS[s], detail_type: s, event_time: 1761617700000 + n * 3_600_000 })),
                },
              ]
            : [],
        },
      ],
    },
  });
}

const VND = (n: number) => n.toFixed(2);

/** Từng khoản theo món (`/finance/transaction/details/get`). `lech`: phí cố định 8% và thêm phí quảng cáo. */
function financeRows(opts: { mismatch?: boolean; refunded?: boolean }) {
  let n = 0;
  const row = (item: (typeof ITEMS)[number], fee_name: string, transaction_type: string, amount: number) => ({
    order_no: String(ORDER_ID),
    orderItem_no: String(item.order_item_id),
    orderItem_status: opts.refunded && item === ITEMS[0] ? 'Returned' : 'Delivered',
    seller_sku: item.sku,
    lazada_sku: `${item.item_id}_VNAMZ-${item.sku_id}`,
    transaction_date: '2026-10-30',
    transaction_type,
    fee_name,
    fee_type: fee_name,
    amount: VND(amount),
    VAT_in_amount: '0.00',
    WHT_amount: '0.00',
    WHT_included_in_amount: 'No',
    paid_status: 'Not paid',
    statement: '2026-10-27 - 2026-11-02',
    transaction_number: `LZTX${String(++n).padStart(8, '0')}`,
    reference: '',
    details: '',
  });
  const fixedPct = opts.mismatch ? 0.08 : 0.04;
  const rows = ITEMS.flatMap((i) => [
    row(i, 'Item Price Credit', 'Orders-Sales', PRICE),
    row(i, 'Commission', 'Orders-Lazada Fees', -PRICE * fixedPct),
    row(i, 'Payment Fee', 'Orders-Lazada Fees', -PRICE * 0.02),
  ]);
  rows.push(row(ITEMS[0], 'Shipping Fee (Paid By Customer)', 'Orders-Logistics', SHIPPING_FEE));
  rows.push(row(ITEMS[0], 'Shipping Fee Charged by Lazada', 'Orders-Logistics', -SHIPPING_FEE));
  if (opts.mismatch) rows.push(row(ITEMS[0], 'Sponsored Discovery - Top up', 'Marketing Fees', -5000));
  if (opts.refunded) {
    rows.push(row(ITEMS[0], 'Reversal Item Price', 'Refunds-Claims', -PRICE));
    rows.push(row(ITEMS[0], 'Reversal Commission', 'Refunds-Claims', PRICE * fixedPct));
  }
  return rows;
}

function payout(rows: ReturnType<typeof financeRows>) {
  const sum = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).reduce((s, r) => s + Number(r.amount), 0);
  const revenue = sum((r) => r.fee_name === 'Item Price Credit');
  const refunds = sum((r) => r.transaction_type === 'Refunds-Claims');
  const fees = sum((r) => r.transaction_type !== 'Orders-Sales' && r.transaction_type !== 'Refunds-Claims');
  const total = revenue + refunds + fees;
  return ok({
    data: [
      {
        statement_number: 'VN2026W44',
        created_at: '2026-11-02',
        opening_balance: '0.00',
        item_revenue: VND(revenue),
        fees_total: VND(fees),
        refunds: VND(refunds),
        subtotal1: VND(revenue + fees),
        subtotal2: VND(total),
        payout: VND(total),
        closing_balance: VND(total),
        paid: '0',
      },
    ],
  });
}

function reverseOrder(type: 'RETURN' | 'ONLY_REFUND', status: string) {
  const line = ITEMS[0];
  return {
    reverse_order_id: 700000000000001,
    trade_order_id: ORDER_ID,
    request_type: type,
    is_rtm: false,
    shipping_type: 'DROPSHIPPING',
    reverse_order_lines: [
      {
        reverse_order_line_id: 700000000000101,
        trade_order_line_id: line.order_item_id,
        reverse_status: status,
        seller_sku_id: line.sku,
        product: { product_id: line.item_id, product_sku: String(line.sku_id), name: `${line.name} (${line.variation})` },
        is_need_refund: true,
        refund_amount: PRICE,
        reason_code: type === 'RETURN' ? 'SIZE_NOT_FIT' : 'ITEM_DEFECT',
        reason_text: type === 'RETURN' ? 'Không vừa size' : 'Áo bị lỗi đường may, khách giữ hàng',
        return_order_line_gmt_create: 1761804000000,
        return_order_line_gmt_modified: 1761804000000,
      },
    ],
  };
}

// ── Dựng mapping ─────────────────────────────────────────────────────────────────────────────────────────────────
const JSON_HEADERS = { 'Content-Type': 'application/json' };
let counter = 0;

type StubOptions = Partial<Mapping> & { query?: Record<string, unknown>; bodyPatterns?: unknown[] };

function stub(path: string, body: unknown, extra: StubOptions = {}): Mapping {
  const { query, bodyPatterns, ...rest } = extra;
  return {
    name: `${path} #${++counter}`,
    priority: 5,
    ...rest,
    request: {
      method: 'ANY',
      // Đường dẫn đầy đủ `/rest/…` là regex (bắt mọi API); còn lại là apiPath của một API.
      ...(path.startsWith('/rest/') ? { urlPathPattern: path } : { urlPath: `/rest${path}` }),
      ...(query && { queryParameters: query }),
      ...(bodyPatterns && { bodyPatterns }),
    },
    response: { status: 200, headers: JSON_HEADERS, jsonBody: body },
  };
}

/** API của gian hàng, sản phẩm, token: luôn trả như shop thử bình thường (C1, C2). */
function baseMappings(): Mapping[] {
  const token = ok({
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    expires_in: 864000,
    refresh_expires_in: 4320000,
    account: SELLER.email,
    country: 'vn',
    account_platform: 'seller_center',
    country_user_info: [{ country: 'vn', user_id: '100000000001', seller_id: String(SELLER.seller_id), short_code: SELLER.short_code }],
  });
  const product = (i: (typeof ITEMS)[number]) => ({
    item_id: i.item_id,
    status: 'Active',
    primary_category: 14275,
    attributes: { name: `${i.name} - ${i.variation}`, brand: 'No Brand', description: 'Áo thun cotton 100%' },
    skus: [{ SkuId: i.sku_id, SellerSku: i.sku, ShopSku: `${i.item_id}_VNAMZ-${i.sku_id}`, quantity: 50, price: PRICE, Status: 'active' }],
  });
  return [
    stub('/auth/token/create', token),
    stub('/auth/token/refresh', token),
    stub('/seller/get', ok({ data: SELLER })),
    stub(
      '/category/tree/get',
      ok({ data: [{ category_id: 1, name: 'Thời trang nam', leaf: false, children: [{ category_id: 14275, name: 'Áo thun có cổ nam', leaf: true }] }] }),
    ),
    stub(
      '/category/attributes/get',
      ok({
        data: [
          { name: 'brand', label: 'Thương hiệu', is_mandatory: 1, attribute_type: 'normal', options: [{ name: 'No Brand' }] },
          { name: 'clothing_material', label: 'Chất liệu', is_mandatory: 1, attribute_type: 'normal', options: [{ name: 'Cotton' }] },
          { name: 'name', label: 'Tên', is_mandatory: 1, attribute_type: 'normal', options: [] },
          { name: 'price', label: 'Giá', is_mandatory: 1, attribute_type: 'sku' },
        ],
      }),
    ),
    stub('/image/migrate', ok({ data: { image: { url: 'https://example.com/lazada-mock/ao-thun.jpg', hash_code: 'mock' } } })),
    stub('/product/create', ok({ data: { item_id: 2300000099, item_status: 'Active', sku_list: [{ seller_sku: 'MOI', shop_sku: 'mock', sku_id: 13000000099 }] } })),
    stub('/products/get', ok({ data: { total_products: ITEMS.length, products: ITEMS.map(product) } })),
    stub('/product/price_quantity/update', ok({})),
    stub('/product/deactivate', ok({})),
    stub('/order/shipment/providers/get', ok({ result: { success: true, data: { shipping_allocate_type: 'TFS', shipment_providers: [], platform_default: PROVIDER } } })),
    stub(
      '/order/reverse/reason/list',
      ok({ result: { success: true, data: [{ reason_id: 1, reason_name: 'Khách đổi ý' }, { reason_id: 2, reason_name: 'Sản phẩm không như mô tả' }] } }),
    ),
    { ...stub('/rest/.*', err('InvalidApiPath', 'The specified API path is invalid')), priority: 10 },
  ];
}

/** Đơn, kiện, vận chuyển, huỷ: mỗi trạng thái của kịch bản `don` một bộ response. */
function orderMappings(s: Scenario): Mapping[] {
  const sc = 'don';
  const at = (state: string, more: Partial<Mapping> = {}) => ({ priority: 3, scenarioName: sc, requiredScenarioState: state, ...more });
  const out: Mapping[] = [];
  for (const state of s.order) {
    out.push(stub('/orders/get', ok({ data: { count: 1, countTotal: 1, orders: [order(state)] } }), at(state)));
    out.push(stub('/order/get', ok({ data: order(state) }), at(state)));
    out.push(stub('/order/items/get', ok({ data: items(state) }), at(state)));
    out.push(stub('/logistic/order/trace', trace(s.order, state), at(state)));
    out.push(
      stub(
        '/order/document/get',
        RTS_OR_LATER.has(state)
          ? ok({ data: { document: { document_type: 'shippingLabel', mime_type: 'text/html', file: Buffer.from(`<html>Vận đơn ${TRACKING}</html>`).toString('base64') } } })
          : err('30012', 'rts package not found', 'ISP'),
        at(state),
      ),
    );
    const rows = financeRows({ mismatch: s.mismatch });
    const settled = state === 'delivered' && !s.reverse;
    out.push(stub('/finance/transaction/details/get', ok({ data: settled ? rows : [] }), at(state)));
    out.push(stub('/finance/payout/status/get', settled ? payout(rows) : ok({ data: [] }), at(state)));
  }
  if (s.order.includes('pending')) {
    const packResult = ok({
      result: {
        success: true,
        data: {
          pack_order_list: [
            {
              order_id: ORDER_ID,
              order_item_list: ITEMS.map((i) => ({
                order_item_id: i.order_item_id,
                package_id: PACKAGE_ID,
                tracking_number: TRACKING,
                shipment_provider: PROVIDER,
                item_err_code: '0',
                msg: 'success',
                retry: false,
              })),
            },
          ],
        },
      },
    });
    out.push(stub('/order/fulfill/pack', packResult, at('pending', { newScenarioState: 'packed' })));
    out.push(stub('/order/package/repack', ok({ result: { success: true } }), at('packed', { newScenarioState: 'pending' })));
    out.push(
      stub(
        '/order/package/rts',
        ok({ result: { success: true, data: { packages: [{ package_id: PACKAGE_ID, item_err_code: '0', msg: 'success', retry: false }] } } }),
        at('packed', { newScenarioState: 'ready_to_ship' }),
      ),
    );
    for (const state of ['pending', 'packed']) {
      out.push(
        stub(
          '/order/reverse/cancel/validate',
          ok({ result: { success: true, data: { reason_options: [{ reason_id: 11, reason_name: 'Hết hàng' }, { reason_id: 12, reason_name: 'Sai giá' }] } } }),
          at(state),
        ),
      );
      out.push(stub('/order/reverse/cancel/create', ok({ result: { success: true, data: { reverse_order_id: 700000000000009 } } }), at(state, { newScenarioState: 'canceled' })));
    }
    out.push(stub('/orders/get', ok({ data: { count: 1, countTotal: 1, orders: [order('canceled')] } }), at('canceled')));
    out.push(stub('/order/items/get', ok({ data: items('canceled') }), at('canceled')));
  }
  // Thao tác sai trạng thái (pack lại đơn đã pack, RTS khi chưa pack, huỷ đơn đã giao): lỗi theo món như Lazada.
  out.push(stub('/order/fulfill/pack', err('ORDER_STATUS_INVALID', 'Order status does not allow this operation', 'ISP'), { priority: 4 }));
  out.push(stub('/order/package/rts', err('30012', 'rts package not found', 'ISP'), { priority: 4 }));
  out.push(stub('/order/reverse/cancel/validate', err('CANCEL_NOT_ALLOWED', 'Order can not be canceled in current status', 'ISP'), { priority: 4 }));
  out.push(stub('/order/reverse/cancel/create', err('CANCEL_NOT_ALLOWED', 'Order can not be canceled in current status', 'ISP'), { priority: 4 }));
  return out;
}

/** Yêu cầu trả của khách (D3): kịch bản `tra`. Shop chấp nhận hoặc từ chối qua `/order/reverse/return/update`. */
function reverseMappings(s: Scenario): Mapping[] {
  const empty = ok({ result: { success: true, total: 0, page_no: 1, page_size: 10, items: [] } });
  if (!s.reverse) return [stub('/reverse/getreverseordersforseller', empty)];
  const { type, states } = s.reverse;
  const sc = 'tra';
  const at = (state: string, more: StubOptions = {}) => ({ priority: 3, scenarioName: sc, requiredScenarioState: state, ...more });
  const out: Mapping[] = [];
  for (const state of [...states, 'REQUEST_REJECT']) {
    out.push(stub('/reverse/getreverseordersforseller', ok({ result: { success: true, total: 1, page_no: 1, page_size: 10, items: [reverseOrder(type, state)] } }), at(state)));
    out.push(
      stub(
        '/order/reverse/history/list',
        ok({ result: { success: true, data: { list: states.slice(0, states.indexOf(state) + 1).map((st, n) => ({ status: st, time: 1761804000000 + n * 86_400_000 })) } } }),
        at(state),
      ),
    );
    const rows = financeRows({ refunded: state === 'REFUND_SUCCESS' });
    out.push(stub('/finance/transaction/details/get', ok({ data: rows }), { ...at(state), priority: 2 }));
    out.push(stub('/finance/payout/status/get', payout(rows), { ...at(state), priority: 2 }));
  }
  const accept = states[1]!;
  const refuse = { contains: 'refuse' };
  out.push(stub('/order/reverse/return/update', ok({ result: { success: true } }), at('REQUEST_INITIATE', { priority: 2, newScenarioState: 'REQUEST_REJECT', query: { action: refuse } })));
  out.push(stub('/order/reverse/return/update', ok({ result: { success: true } }), at('REQUEST_INITIATE', { priority: 2, newScenarioState: 'REQUEST_REJECT', bodyPatterns: [refuse] })));
  out.push(stub('/order/reverse/return/update', ok({ result: { success: true } }), at('REQUEST_INITIATE', { newScenarioState: accept })));
  out.push(stub('/order/reverse/return/update', err('REVERSE_STATUS_INVALID', 'Reverse order status does not allow this operation', 'ISP'), { priority: 4 }));
  return out;
}

/** Token hết hạn: mọi API trả `IllegalAccessToken`, làm mới trả `IllegalRefreshToken`; đổi `code` mới thì hết. */
function tokenMappings(): Mapping[] {
  const at = (more: Partial<Mapping> = {}) => ({ priority: 1, scenarioName: 'token', requiredScenarioState: 'het-han', ...more });
  return [
    stub('/rest/(?!auth/).*', err('IllegalAccessToken', 'The specified access token is invalid or expired'), at()),
    stub('/auth/token/refresh', err('IllegalRefreshToken', 'The specified refresh token is invalid or expired'), at()),
    stub(
      '/auth/token/create',
      ok({ access_token: 'mock-access-token-2', refresh_token: 'mock-refresh-token-2', expires_in: 864000, refresh_expires_in: 4320000, account: SELLER.email, country: 'vn' }),
      at({ newScenarioState: 'con-han' }),
    ),
  ];
}

/** Toàn bộ mapping của một kịch bản (nạp bằng `POST /__admin/mappings/import`, xoá mapping cũ). */
export function mappingsFor(s: Scenario): Mapping[] {
  counter = 0;
  return [...baseMappings(), ...orderMappings(s), ...reverseMappings(s), ...(s.tokenExpired ? tokenMappings() : [])];
}

/** Trạng thái khởi đầu của từng kịch bản WireMock sau khi nạp. */
export function initialStates(s: Scenario): Record<string, string> {
  return {
    don: s.order[0]!,
    ...(s.reverse && { tra: s.reverse.states[0]! }),
    ...(s.tokenExpired && { token: 'het-han' }),
  };
}
