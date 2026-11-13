import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const ref = { externalOrderId: 'O1', externalLineIds: ['I1', 'I2'] };
const provider = (type: 'TFS' | 'NTFS') => ({
  shipping_allocate_type: type,
  // GetShipmentProvider: shipment_providers[].name và provider_code.
  platform_default: 'FM50',
  shipment_providers: type === 'NTFS' ? [{ name: 'Flash Express', provider_code: 'FM50' }] : [],
});
const items = ref.externalLineIds.map((id) => ({ order_item_id: id, item_err_code: '0', package_id: 'FP1', tracking_number: 'LZ1' }));
const pack = (rows: (typeof items[number] & { msg?: string })[] = items) => ({ pack_order_list: [{ order_id: 'O1', order_item_list: rows }] });
const ok = (data: unknown) => ({ code: '0', result: { success: true, data } });
const pdf = Buffer.from('%PDF-1.4');
function fake(...bodies: unknown[]) {
  const calls: { path: string; method: string; params: URLSearchParams }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, method: init?.method ?? 'GET', params: new URLSearchParams(init?.body?.toString() ?? u.search) });
    return Response.json(bodies.shift());
  });
  const download = vi.fn(async (_url: string) => pdf);
  return { adapter: createLazadaAdapter(config, fetchFn, { download }), calls, download };
}

describe('đóng gói Lazada', () => {
  it('TFS để sàn tự chọn nhà vận chuyển và gửi đúng các món của kiện', async () => {
    const { adapter, calls } = fake(ok(provider('TFS')));
    expect(await adapter.shipmentProviders!('token', ref)).toEqual({ platformChooses: true, items: [] });
    expect(JSON.parse(calls[0]!.params.get('getShipmentProvidersReq')!)).toEqual({ orders: [{ order_id: 'O1', order_item_ids: ['I1', 'I2'] }] });
  });

  it('NTFS trả danh sách nhà vận chuyển và đánh dấu mục mặc định', async () => {
    const { adapter } = fake(ok(provider('NTFS')));
    expect(await adapter.shipmentProviders!('token', ref)).toEqual({
      platformChooses: false, items: [{ code: 'FM50', name: 'Flash Express', isDefault: true }],
    });
  });

  it.each(['TFS', 'NTFS'] as const)('đóng gói %s gửi đúng tham số và trả mã kiện, vận đơn', async (type) => {
    const { adapter, calls } = fake(ok(provider(type)), ok(pack()));
    const carrier = { code: 'FM50', name: 'Flash Express' };
    await expect(adapter.packItems!('token', { ...ref, carrierCode: carrier.code })).resolves.toEqual({
      packageCode: 'FP1', trackingCode: 'LZ1', carrier: type === 'TFS' ? null : carrier,
    });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/rest/order/fulfill/pack' });
    expect(JSON.parse(calls[1]!.params.get('packReq')!)).toEqual({
      pack_order_list: [{ order_id: 'O1', order_item_list: ['I1', 'I2'] }],
      delivery_type: 'dropship', shipping_allocate_type: type,
      ...(type === 'NTFS' && { shipment_provider_code: 'FM50' }),
    });
  });

  it.each([undefined, 'sai'])('NTFS thiếu hoặc sai mã %s thì dừng trước khi gọi pack', async (carrierCode) => {
    const { adapter, calls } = fake(ok(provider('NTFS')));
    await expect(adapter.packItems!('token', { ...ref, ...(carrierCode && { carrierCode }) }))
      .rejects.toMatchObject({ kind: 'rejected', platformCode: 'carrier_required' });
    expect(calls).toHaveLength(1);
  });

  it('giữ mã và câu lỗi của món sàn từ chối', async () => {
    const { adapter } = fake(ok(provider('TFS')), ok(pack([{ ...items[0]!, item_err_code: '700026', msg: 'Không đóng được' }])));
    await expect(adapter.packItems!('token', ref)).rejects.toMatchObject({ kind: 'rejected', platformCode: '700026', platformMessage: 'Không đóng được' });
  });

  it.each([items.slice(0, 1), [items[0]!, { ...items[1]!, package_id: 'FP2' }]])('từ chối phản hồi thiếu món hoặc ra nhiều kiện', async (...rows) => {
    const { adapter } = fake(ok(provider('TFS')), ok(pack(rows)));
    await expect(adapter.packItems!('token', ref)).rejects.toMatchObject({ platformCode: 'unexpected_response' });
  });

  it('giữ mã và câu lỗi khi result.success là false', async () => {
    const { adapter } = fake({ code: '0', result: { success: false, error_code: '700000', error_msg: 'Không được' } });
    await expect(adapter.shipmentProviders!('token', ref)).rejects.toMatchObject({ kind: 'rejected', platformCode: '700000', platformMessage: 'Không được' });
  });
});

const codes = Array.from({ length: 21 }, (_, i) => `FP${i + 1}`);
const packages = (ids: readonly string[], item_err_code = '0') => ids.map((package_id) => ({ package_id, item_err_code }));
describe('RTS, repack và vận đơn Lazada', () => {
  it('RTS chia lô 20 kiện', async () => {
    const { adapter, calls } = fake(ok({ packages: packages(codes.slice(0, 20)) }), ok({ packages: packages(codes.slice(20)) }));
    await adapter.readyToShip!('token', codes);
    expect(calls.map((c) => c.path)).toEqual(['/rest/order/package/rts', '/rest/order/package/rts']);
    expect(calls.map((c) => JSON.parse(c.params.get('readyToShipReq')!).packages.length)).toEqual([20, 1]);
  });

  it('RTS giữ mã lỗi của kiện', async () => {
    const { adapter } = fake(ok({ packages: packages(['FP1'], '30012') }));
    await expect(adapter.readyToShip!('token', ['FP1'])).rejects.toMatchObject({ kind: 'rejected', platformCode: '30012' });
  });

  it('repack dùng rePackReq và kiểm kết quả từng kiện', async () => {
    const { adapter, calls } = fake(ok({ packages: packages(['FP1']) }), ok({ packages: packages(['FP1'], '700000') }));
    await adapter.repackPackage!('token', 'FP1');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/rest/order/package/repack' });
    expect(JSON.parse(calls[0]!.params.get('rePackReq')!)).toEqual({ packages: [{ package_id: 'FP1' }] });
    await expect(adapter.repackPackage!('token', 'FP1')).rejects.toMatchObject({ platformCode: '700000' });
  });

  it('vận đơn yêu cầu PDF theo lô 20 và tải pdf_url của mỗi lô', async () => {
    const url = 'https://files.test/test.pdf';
    const { adapter, calls, download } = fake(ok({ pdf_url: url }), ok({ pdf_url: url }));
    await expect(adapter.shippingDocuments!('token', codes)).resolves.toEqual([pdf, pdf]);
    expect(calls.map((c) => c.path)).toEqual(['/rest/order/package/document/get', '/rest/order/package/document/get']);
    expect(JSON.parse(calls[0]!.params.get('getDocumentReq')!)).toEqual({
      doc_type: 'PDF', packages: codes.slice(0, 20).map((package_id) => ({ package_id })),
    });
    expect(download.mock.calls).toEqual([[url], [url]]);
  });

  it('vận đơn giữ mã lỗi khi result.success là false', async () => {
    const { adapter, download } = fake({ code: '0', result: { success: false, error_code: '30012' } });
    await expect(adapter.shippingDocuments!('token', ['FP1'])).rejects.toMatchObject({ platformCode: '30012' });
    expect(download).not.toHaveBeenCalled();
  });
});
