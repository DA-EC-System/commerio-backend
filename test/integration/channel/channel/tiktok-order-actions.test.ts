// Cổng tách kiện, giao kiện trên sàn cho fulfillment (#221; tách kiện #205, RTS #239 gọi) chạy với adapter TikTok thật trên
// sàn giả theo đường dẫn API TikTok. Dạng phản hồi theo OAS get-order-split-attributes-202309, confirm-order-split-202309,
// ship-package-202309 (skill `tts-openapi-guide`) và kết quả gọi thật 07/11/2026 ở channel CLAUDE.md.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import {
  marketplaceShipPackage,
  marketplaceSplitAttributes,
  marketplaceSplitOrder,
  splitGroupViolation,
} from '#src/modules/channel/channel/service/order-actions.ts';
import { AppError } from '#src/shared/errors/app-error.ts';
import { createCompany } from '../../helpers/company.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });
const fail = (code: number, message: string) => json({ code, message, request_id: 'r' });

let shopExternalId = '';
/** Thuộc tính tách sàn trả theo mã đơn; không có thì sàn báo 21001008 (đơn `ON_HOLD`, gọi thật 03/11/2026). */
let attributes: Record<string, Record<string, unknown>> = {};
let shipResponse: () => Response = () => ok({});
const calls: { path: string; body: unknown }[] = [];

const fakeTiktok = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(url));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ path: u.pathname, body });
  if (u.pathname === '/authorization/202309/shops') {
    return ok({ shops: [{ id: shopExternalId, name: 'Shop thử TikTok', region: 'VN', cipher: 'ROW_c' }] });
  }
  if (u.pathname === '/fulfillment/202309/orders/split_attributes') {
    const id = u.searchParams.get('order_ids') ?? '';
    const a = attributes[id];
    return a ? ok({ split_attributes: [{ order_id: id, ...a }] }) : fail(21001008, 'cannot find fulfill_order');
  }
  const split = /^\/fulfillment\/202309\/orders\/([^/]+)\/split$/.exec(u.pathname);
  if (split) {
    const groups = (body as { splittable_groups: { id: string }[] }).splittable_groups;
    return ok({ packages: groups.map((g) => ({ id: `PK-${split[1]}-${g.id}`, splittable_group_id: g.id })) });
  }
  if (/^\/fulfillment\/202309\/packages\/[^/]+\/ship$/.test(u.pathname)) return shipResponse();
  return json({ code: 36009009, message: 'Invalid path' });
};

const tiktok = createTiktokAdapter({ appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' }, fakeTiktok);
registerAdapter('tiktok', tiktok);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  shopExternalId = `74951${Math.floor(Math.random() * 1e12)}`;
  const res = await request(testApp())
    .post('/api/v1/channel/shops/tiktok/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `TTP_${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  shopId = res.body.shop.id;
});

beforeEach(() => {
  calls.length = 0;
  attributes = {};
  shipResponse = () => ok({});
});

/** Lỗi ném ra của `fn` (bắt buộc phải ném). */
async function caught(fn: () => Promise<unknown>): Promise<AppError> {
  const err = await fn().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

const splitCalls = () => calls.filter((c) => c.path.endsWith('/split'));

describe('tách kiện trên sàn TikTok (#221)', () => {
  it('đọc thuộc tính tách: sàn bắt tách thì trả lý do theo dạng của app', async () => {
    attributes.O1 = {
      can_split: true,
      must_split: true,
      must_split_reasons: [{ type: 'TOTAL_COUNT_LIMITATION', max_count: '2' }, { type: 'CATEGORY_ITEM_LIMITATION', category_id: '600042', max_count: '1' }],
    };
    expect(await marketplaceSplitAttributes(company.companyId, shopId, 'O1')).toEqual({
      canSplit: true,
      mustSplit: true,
      reason: null,
      mustSplitReasons: [
        { type: 'TOTAL_COUNT_LIMITATION', externalCategoryId: null, maxCount: 2 },
        { type: 'CATEGORY_ITEM_LIMITATION', externalCategoryId: '600042', maxCount: 1 },
      ],
    });
  });

  it('sàn cho tách: gọi tách đúng nhóm, trả mã kiện sàn theo thứ tự nhóm', async () => {
    attributes.O2 = { can_split: true, must_split: false, must_split_reasons: [] };
    const codes = await marketplaceSplitOrder(company.companyId, shopId, 'O2', [['O2-1', 'O2-2'], ['O2-3']]);
    expect(codes).toEqual(['PK-O2-1', 'PK-O2-2']);
    expect(splitCalls()).toEqual([
      {
        path: '/fulfillment/202309/orders/O2/split',
        body: { splittable_groups: [{ id: '1', order_line_item_ids: ['O2-1', 'O2-2'] }, { id: '2', order_line_item_ids: ['O2-3'] }] },
      },
    ]);
  });

  it('sàn bắt tách tối đa 2 món mỗi kiện: nhóm 3 món thì 422 split_not_supported, không gọi tách', async () => {
    attributes.O3 = { can_split: true, must_split: true, must_split_reasons: [{ type: 'TOTAL_COUNT_LIMITATION', max_count: '2' }] };
    const err = await caught(() => marketplaceSplitOrder(company.companyId, shopId, 'O3', [['O3-1', 'O3-2', 'O3-3'], ['O3-4']]));
    expect(err).toMatchObject({ status: 422, code: 'split_not_supported' });
    expect(err.extensions?.mustSplitReasons).toEqual([{ type: 'TOTAL_COUNT_LIMITATION', externalCategoryId: null, maxCount: 2 }]);
    expect(splitCalls()).toEqual([]);
  });

  it('sàn bắt tách và nhóm đúng giới hạn: gọi tách', async () => {
    attributes.O4 = { can_split: true, must_split: true, must_split_reasons: [{ type: 'TOTAL_COUNT_LIMITATION', max_count: '2' }] };
    expect(await marketplaceSplitOrder(company.companyId, shopId, 'O4', [['O4-1', 'O4-2'], ['O4-3', 'O4-4']])).toEqual(['PK-O4-1', 'PK-O4-2']);
  });

  it('sàn không cho tách (can_split false): 422 kèm câu của sàn, không gọi tách', async () => {
    attributes.O5 = { can_split: false, must_split: false, reason: 'fulfill_unit action not allowed' };
    const err = await caught(() => marketplaceSplitOrder(company.companyId, shopId, 'O5', [['O5-1'], ['O5-2']]));
    expect(err).toMatchObject({ status: 422, code: 'split_not_supported', message: 'fulfill_unit action not allowed' });
    expect(splitCalls()).toEqual([]);
  });

  it('đơn chưa chờ giao (sàn báo 21001008): 422 split_not_supported kèm mã và câu của sàn', async () => {
    const err = await caught(() => marketplaceSplitOrder(company.companyId, shopId, 'O-ON-HOLD', [['a'], ['b']]));
    expect(err).toMatchObject({ status: 422, code: 'split_not_supported' });
    expect(err.extensions).toMatchObject({ platformCode: '21001008', platformMessage: 'cannot find fulfill_order' });
  });

  it('sàn không có API tách: 422 split_not_supported', async () => {
    registerAdapter('tiktok', fakeAdapter({}));
    try {
      const err = await caught(() => marketplaceSplitOrder(company.companyId, shopId, 'O6', [['a'], ['b']]));
      expect(err).toMatchObject({ status: 422, code: 'split_not_supported' });
    } finally {
      registerAdapter('tiktok', tiktok);
    }
  });

  it('gian hàng của công ty khác: 404', async () => {
    const other = await createCompany({ optionalModules: ['channel'] });
    const err = await caught(() => marketplaceSplitAttributes(other.companyId, shopId, 'O1'));
    expect(err.status).toBe(404);
  });
});

describe('giao kiện trên sàn TikTok (#221)', () => {
  it('gửi cách bàn giao theo dạng của sàn', async () => {
    await marketplaceShipPackage(company.companyId, shopId, 'PK-9', { handover: 'drop_off' });
    expect(calls.filter((c) => c.path.endsWith('/ship'))).toEqual([{ path: '/fulfillment/202309/packages/PK-9/ship', body: { handover_method: 'DROP_OFF' } }]);
  });

  it('kiện đã giao (11006021): gọi lại coi là xong', async () => {
    shipResponse = () => fail(11006021, 'package has been shipped');
    await expect(marketplaceShipPackage(company.companyId, shopId, 'PK-9')).resolves.toBeUndefined();
  });

  it('sàn từ chối lý do khác: 409 marketplace_rejected', async () => {
    shipResponse = () => fail(11006000, 'package status not allowed');
    const err = await caught(() => marketplaceShipPackage(company.companyId, shopId, 'PK-9'));
    expect(err).toMatchObject({ status: 409, code: 'marketplace_rejected' });
  });
});

describe('giới hạn sàn bắt tách (splitGroupViolation)', () => {
  const attrs = (reasons: { type: string; maxCount: number | null }[]) => ({
    canSplit: true,
    mustSplit: reasons.length > 0,
    reason: null,
    mustSplitReasons: reasons.map((r) => ({ ...r, externalCategoryId: null })),
  });

  it('không bắt tách hoặc chỉ giới hạn theo danh mục: để sàn kiểm', () => {
    expect(splitGroupViolation(attrs([]), [['a', 'b', 'c']])).toBeNull();
    expect(splitGroupViolation(attrs([{ type: 'CATEGORY_ITEM_LIMITATION', maxCount: 1 }]), [['a', 'b']])).toBeNull();
  });

  it('nhiều giới hạn tổng: lấy giới hạn nhỏ nhất', () => {
    const a = attrs([
      { type: 'TOTAL_COUNT_LIMITATION', maxCount: 3 },
      { type: 'TOTAL_COUNT_LIMITATION', maxCount: 2 },
    ]);
    expect(splitGroupViolation(a, [['a', 'b'], ['c']])).toBeNull();
    expect(splitGroupViolation(a, [['a', 'b', 'c']])).toBe('Sàn chỉ cho tối đa 2 món mỗi kiện');
  });
});
