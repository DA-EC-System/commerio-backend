import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter, lazadaError } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

// #359: lỗi tạm theo danh sách cho phép; mã nghiệp vụ mang type ISP (mã số hay mã chữ) là sàn từ chối.
describe('lazadaError: danh sách lỗi tạm (#359)', () => {
  it('AC-1: mã chữ nghiệp vụ mang type ISP là sàn từ chối, giữ mã và câu của sàn', () => {
    // Payload thật trên staging (issue #359): gỡ sản phẩm đã tắt trên Lazada.
    const err = lazadaError({ code: 'E0004', type: 'ISP', message: 'Product Status not online' });
    expect(err).toMatchObject({ kind: 'rejected', platformCode: 'E0004', platformMessage: 'Product Status not online' });
    expect(lazadaError({ code: 'SellerNotActive', type: 'ISP', message: 'x' }).kind).toBe('rejected');
    expect(lazadaError({ code: 'EDIT_ITEM_NOT_BELONG_SELLER', type: 'ISP', message: 'x' }).kind).toBe('rejected');
  });

  it.each(['ServiceUnavailable', 'ServiceTimeout', 'ApiCallLimit', 'SellerCallLimit', 'E0006', '6', '901', '1000', '4154'])(
    'AC-2: %s là lỗi tạm',
    (code) => {
      expect(lazadaError({ code, type: 'ISP', message: 'x' })).toMatchObject({ kind: 'unavailable', platformCode: code });
    },
  );

  it('AC-2: type SYSTEM là lỗi tạm dù mã lạ; mã token là unauthorized kể cả type ISP; mã số nghiệp vụ là rejected', () => {
    expect(lazadaError({ code: 'SomethingNew', type: 'SYSTEM', message: 'x' }).kind).toBe('unavailable');
    expect(lazadaError({ code: 'IllegalAccessToken', type: 'ISP', message: 'x' }).kind).toBe('unauthorized');
    expect(lazadaError({ code: '501', type: 'ISP', message: 'E501: Update product failed' }).kind).toBe('rejected');
  });
});

const config = {
  appKey: '143465',
  appSecret: 'secret',
  redirectUrl: undefined,
  apiUrl: 'https://api.test/rest',
  authUrl: 'https://auth.test',
};

function fakeFetch(...bodies: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const b of bodies) fn.mockResolvedValueOnce(new Response(JSON.stringify(b), { status: 200 }));
  return fn;
}

const path = (fn: ReturnType<typeof fakeFetch>, i: number) => new URL(String(fn.mock.calls[i]?.[0])).pathname;

// DeactivateProduct (open.lazada.com, tra 17/11/2026): E0004 "Product Status not online", hướng xử lý "The current item is
// already in the Inactive state"; câu lỗi lại là "not online" nên đọc lại `/product/item/get` trước khi coi là xong.
const e0004 = { code: 'E0004', type: 'ISP', message: 'Product Status not online' };
const item = (status: string, skus: { SkuId: unknown; Status: string }[] = [{ SkuId: 2069, Status: 'active' }]) => ({
  code: '0',
  data: { item_id: 234, status, skus },
});

describe('Lazada deactivate: sản phẩm đã tắt sẵn (#359)', () => {
  it.each([
    ['sản phẩm InActive', item('InActive')],
    ['sản phẩm Deleted', item('Deleted')],
    ['sản phẩm Suspended (sàn đình chỉ)', item('Suspended')],
    ['SKU inactive trong sản phẩm Active', item('Active', [{ SkuId: 2069, Status: 'inactive' }])],
  ])('AC-3: E0004 và sàn báo %s thì coi là đã tắt, gọi đúng hai API', async (_name, got) => {
    const fn = fakeFetch(e0004, got);
    await expect(createLazadaAdapter(config, fn).deactivate('t', '234', '2069')).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(path(fn, 0)).toBe('/rest/product/deactivate');
    expect(path(fn, 1)).toBe('/rest/product/item/get');
    expect(new URL(String(fn.mock.calls[1]?.[0])).searchParams.get('item_id')).toBe('234');
  });

  it.each([
    ['sản phẩm chờ duyệt', item('Pending QC')],
    ['sản phẩm đang bán', item('Active')],
    ['SKU khác inactive, SKU này active', item('Active', [{ SkuId: 9999, Status: 'inactive' }, { SkuId: 2069, Status: 'active' }])],
    ['SKU inactive nhưng sản phẩm chờ duyệt', item('Pending QC', [{ SkuId: 2069, Status: 'inactive' }])],
    ['phản hồi không có data', { code: '0' }],
  ])('AC-4: E0004 và %s thì ném lại lỗi E0004 gốc (rejected, kèm câu sàn)', async (_name, got) => {
    const fn = fakeFetch(e0004, got);
    await expect(createLazadaAdapter(config, fn).deactivate('t', '234', '2069')).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'E0004',
      platformMessage: 'Product Status not online',
    });
  });

  it('đọc trạng thái lỗi tạm thì ném lỗi của lần đọc, listing giữ nguyên', async () => {
    const fn = fakeFetch(e0004, { code: 'ServiceUnavailable', type: 'ISP', message: 'x' });
    await expect(createLazadaAdapter(config, fn).deactivate('t', '234', '2069')).rejects.toMatchObject({
      kind: 'unavailable',
      platformCode: 'ServiceUnavailable',
    });
  });

  it('lỗi khác E0004 thì không đọc trạng thái', async () => {
    const fn = fakeFetch({ code: 'E0002', type: 'ISP', message: 'Product not exists' });
    await expect(createLazadaAdapter(config, fn).deactivate('t', '234', '2069')).rejects.toMatchObject({
      kind: 'rejected',
      platformCode: 'E0002',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// #567: lý do có cấu trúc của `detail[]`, hai dạng thật.
describe('lazadaError: details (#567)', () => {
  it('mã đứng đầu câu (ca đêm 18/11/2026): tách mã, câu còn lại', () => {
    const err = lazadaError({
      code: '4110',
      type: 'ISP',
      message: 'E500: Create product failed',
      detail: [{ field: 'Product', message: 'BIZ_CHECK_PACKAGE_WEIGHT_BY_KG_INVALID:Khối lượng kiện hàng nên nằm trong khoảng 0.001 và 300.0' }],
    });
    expect(err.details).toEqual([
      { field: 'Product', code: 'BIZ_CHECK_PACKAGE_WEIGHT_BY_KG_INVALID', message: 'Khối lượng kiện hàng nên nằm trong khoảng 0.001 và 300.0' },
    ]);
    // Câu ghép cũ giữ nguyên cho log, việc khác đọc `platformMessage`.
    expect(err.platformMessage).toBe('E500: Create product failed (Product: BIZ_CHECK_PACKAGE_WEIGHT_BY_KG_INVALID:Khối lượng kiện hàng nên nằm trong khoảng 0.001 và 300.0)');
  });

  it('code riêng (gọi thật 17/11/2026): giữ code, C006 trong câu không thành mã', () => {
    const err = lazadaError({
      code: '4110',
      message: 'E500: Create product failed',
      detail: [{ field: 'brandProp', message: 'C006:Vui lòng điền Brand trước khi tải lên lại.', code: 'BIZ_CHECK_CAT_PROP_MANDATORY' }],
    });
    expect(err.details).toEqual([{ field: 'brandProp', code: 'BIZ_CHECK_CAT_PROP_MANDATORY', message: 'C006:Vui lòng điền Brand trước khi tải lên lại.' }]);
    expect(lazadaError({ code: '4110', detail: [{ message: 'C006:abc' }] }).details).toEqual([{ field: null, code: null, message: 'C006:abc' }]);
  });

  it('có code và mã đầu câu trùng (gọi thật 24/11/2026): bỏ mã khỏi câu', () => {
    const err = lazadaError({
      code: '4139',
      message: 'E500: Create product failed',
      request_id: '0baf8cf917955163221227541',
      detail: [{ field: 'Product', code: 'BIZ_CHECK_MAIN_IMAGE_REQUIRE', message: 'BIZ_CHECK_MAIN_IMAGE_REQUIRE:Main image is require' }],
    });
    expect(err.details).toEqual([{ field: 'Product', code: 'BIZ_CHECK_MAIN_IMAGE_REQUIRE', message: 'Main image is require' }]);
  });

  it.each([undefined, null, 'chuỗi', [], [null, 5, {}]])('detail %j: details rỗng, không ném', (detail) => {
    expect(lazadaError({ code: '4110', message: 'x', detail } as never).details).toEqual([]);
  });
});
