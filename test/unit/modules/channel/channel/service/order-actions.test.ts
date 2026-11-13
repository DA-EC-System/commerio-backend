import { describe, expect, it, vi } from 'vitest';
import { MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import {
  marketplaceCancelRejectReasons, marketplaceCarriers, marketplaceDecideCancel, marketplacePack, marketplaceReadyToShip, marketplaceRepack, onPackageAction,
} from '#src/modules/channel/channel/service/order-actions.ts';
import { shopSession } from '#src/modules/channel/channel/service/shops.ts';

vi.mock('#src/shared/db/client.ts', () => ({ withCompany: (_id: string, fn: () => unknown) => fn() }));
vi.mock(import('#src/modules/channel/channel/service/shops.ts'), async (original) => ({
  ...(await original()), shopSession: vi.fn(),
}));

const ref = { externalOrderId: 'O1', externalLineIds: ['I1'] };
function session(adapter: object) {
  vi.mocked(shopSession).mockResolvedValue({ accessToken: 'token', adapter } as Awaited<ReturnType<typeof shopSession>>);
}

describe('cổng thao tác kiện trên sàn', () => {
  it.each([
    ['700000', 'package_status_not_allowed'], ['700026', 'item_not_packable'],
    ['30012', 'rts_package_not_found'], ['21042104', 'document_not_ready'],
    ['21023035', 'document_not_ready'], ['11034037', 'document_not_ready'],
    ['21023059', 'package_status_not_allowed'], ['21042102', 'package_status_not_allowed'],
  ])('đổi mã sàn %s sang %s, giữ thông tin gốc', async (platformCode, code) => {
    await expect(onPackageAction(async () => { throw new MarketplaceError('rejected', platformCode, 'Lỗi gốc'); }))
      .rejects.toMatchObject({ status: 409, code, extensions: { platformCode, platformMessage: 'Lỗi gốc' } });
  });

  it('trả lỗi tại trường carrierCode khi sàn bắt chọn nhà vận chuyển', async () => {
    await expect(onPackageAction(async () => { throw new MarketplaceError('rejected', 'carrier_required', 'Chọn nhà vận chuyển'); }))
      .rejects.toMatchObject({ status: 422, code: 'validation_failed', extensions: { errors: { carrierCode: 'Chọn nhà vận chuyển' } } });
  });

  it('đổi lỗi tạm của sàn sang 503 và ném nguyên lỗi khác', async () => {
    await expect(onPackageAction(async () => { throw new MarketplaceError('unavailable'); })).rejects.toMatchObject({ status: 503, code: 'marketplace_unavailable' });
    const err = new Error('Lỗi khác');
    await expect(onPackageAction(async () => { throw err; })).rejects.toBe(err);
  });

  it('cổng trả giá trị theo năng lực của adapter', async () => {
    session({});
    await expect(marketplaceCarriers('c', 's', ref)).resolves.toEqual([]);
    await expect(marketplacePack('c', 's', ref)).resolves.toBeNull();
    await expect(marketplaceRepack('c', 's', 'FP1')).resolves.toBe('not_supported');
    await expect(marketplaceReadyToShip('c', 's', 'FP1')).rejects.toMatchObject({ status: 422, code: 'marketplace_unsupported' });
    const repackPackage = vi.fn();
    session({ repackPackage, shipmentProviders: async () => ({ platformChooses: true, items: [{ code: 'X' }] }) });
    await expect(marketplaceCarriers('c', 's', ref)).resolves.toEqual([]);
    await expect(marketplaceRepack('c', 's', 'FP1')).resolves.toBe('repacked');
    expect(repackPackage).toHaveBeenCalledWith('token', 'FP1');
  });
});

describe('cổng trả lời khách xin huỷ (#227, Documents/21 §19.3)', () => {
  it('truyền lý do từ chối xuống adapter; đồng ý thì không gửi lý do', async () => {
    const decideCancelRequest = vi.fn(async () => {});
    session({ decideCancelRequest });
    await marketplaceDecideCancel('c', 's', 'O1', false, 'seller_reject_apply_product_has_been_packed');
    expect(decideCancelRequest).toHaveBeenLastCalledWith('token', 'O1', false, 'seller_reject_apply_product_has_been_packed');
    await marketplaceDecideCancel('c', 's', 'O1', true, 'bo-qua');
    expect(decideCancelRequest).toHaveBeenLastCalledWith('token', 'O1', true, undefined);
  });

  it('sàn bắt buộc lý do mà thiếu: 422 validation_failed tại rejectReasonId', async () => {
    session({ decideCancelRequest: async () => { throw new MarketplaceError('rejected', 'reject_reason_required', 'TikTok bắt buộc chọn lý do'); } });
    await expect(marketplaceDecideCancel('c', 's', 'O1', false)).rejects.toMatchObject({
      status: 422, code: 'validation_failed', extensions: { errors: { rejectReasonId: 'TikTok bắt buộc chọn lý do' } },
    });
  });

  it('lý do từ chối: sàn không có danh sách thì rỗng; có thì trả của sàn; sàn từ chối thì 409', async () => {
    session({});
    await expect(marketplaceCancelRejectReasons('c', 's', 'O1')).resolves.toEqual([]);
    const cancelRequestRejectReasons = vi.fn(async () => [{ id: 'r1', label: 'Đã đóng gói' }]);
    session({ cancelRequestRejectReasons });
    await expect(marketplaceCancelRejectReasons('c', 's', 'O1')).resolves.toEqual([{ id: 'r1', label: 'Đã đóng gói' }]);
    expect(cancelRequestRejectReasons).toHaveBeenCalledWith('token', 'O1');
    session({ cancelRequestRejectReasons: async () => { throw new MarketplaceError('rejected', 'not_rejectable', 'Không từ chối được'); } });
    await expect(marketplaceCancelRejectReasons('c', 's', 'O1')).rejects.toMatchObject({ status: 409, code: 'marketplace_rejected' });
  });
});
