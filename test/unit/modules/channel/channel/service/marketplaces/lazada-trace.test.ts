import { describe, expect, it, vi } from 'vitest';
import { createLazadaAdapter, lazadaPackageEvents } from '#src/modules/channel/channel/service/marketplaces/lazada.ts';

const config = { appKey: 'k', appSecret: 's', redirectUrl: 'https://app/cb', apiUrl: 'https://api.test/rest', authUrl: 'https://auth.test' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// Dạng của stub `scripts/lazada-mock/stubs.ts` và mẫu shop thử (`detail_type: "delivered"`, `status_code: "1400"`).
const sample = {
  code: '0',
  result: {
    success: true,
    module: [
      {
        package_detail_info_list: [
          {
            ofc_package_id: 'FP1',
            tracking_number: 'TN1',
            logistic_detail_info_list: [
              { detail_type: 'shipped', event_time: 1761617700000, description: 'Đã lấy hàng' },
              { detail_type: 'delivered', status_code: '1400', event_time: 1761621300000, description: 'Giao thành công' },
            ],
          },
        ],
      },
    ],
  },
};

describe('Lazada: hành trình kiện /logistic/order/trace (spec 199c §5.7)', () => {
  it('đọc hành trình theo kiện: detail_type → trạng thái, event_time mili giây → Date, mô tả', async () => {
    const fn = vi.fn().mockResolvedValueOnce(json(sample));
    const events = await createLazadaAdapter(config, fn).getPackageEvents!('t', '533732107780318');

    expect(events).toEqual([
      { packageCode: 'FP1', trackingCode: 'TN1', status: 'in_transit', at: new Date(1761617700000), description: 'Đã lấy hàng' },
      { packageCode: 'FP1', trackingCode: 'TN1', status: 'delivered', at: new Date(1761621300000), description: 'Giao thành công' },
    ]);
    const url = new URL(String(fn.mock.calls[0]![0]));
    expect(url.pathname).toBe('/rest/logistic/order/trace');
    expect(url.searchParams.get('order_id')).toBe('533732107780318');
  });

  it('bỏ dòng có detail_type lạ hoặc thiếu event_time, không lỗi', () => {
    const events = lazadaPackageEvents({
      module: [
        {
          package_detail_info_list: [
            {
              ofc_package_id: 'FP1',
              tracking_number: '',
              logistic_detail_info_list: [
                { detail_type: 'something_new', event_time: 1761617700000, description: 'Lạ' },
                { detail_type: 'shipped', description: 'Thiếu giờ' },
                { detail_type: 'shipped', event_time: 'abc' },
                { detail_type: 'shipped', event_time: -1 },
                { detail_type: 'failed_delivery', event_time: '1761621300000', description: '' },
              ],
            },
          ],
        },
      ],
    });
    expect(events).toEqual([{ packageCode: 'FP1', trackingCode: null, status: 'delivery_failed', at: new Date(1761621300000), description: null }]);
  });

  // Mẫu gọi thật 13/11/2026 trên shop thử (đơn 530326804480318, SOF; request_id 2140eb3617945288367065696; Documents
  // tich-hop-san/lazada.md §11.7): `ofc_package_id` trùng `package_id` của món ở `/order/items/get`.
  it('mẫu shop thử: ready_to (1200) bị bỏ, delivered (1400) đọc ra mốc giao, mã kiện là FP… của món', () => {
    const real = {
      not_success: false,
      success: true,
      module: [
        {
          package_detail_info_list: [
            {
              ofc_package_id: 'FP070211659297364',
              tracking_number: 'SOF_FP070211659297364',
              logistic_detail_info_list: [
                {
                  status_code: '1200',
                  proof_images: [],
                  detail_type: 'ready_to',
                  receive_time: 0,
                  description: 'Kiện hàng của bạn đã hoàn tất đóng gói và sẵn sàng bàn giao cho đơn vị vận chuyển ',
                  title: 'Hoàn tất đóng gói',
                  event_time: 1793695244316,
                },
                {
                  status_code: '1400',
                  proof_images: [],
                  detail_type: 'delivered',
                  receive_time: 0,
                  description: 'Kiện hàng của bạn đã được giao thành công',
                  title: 'Giao hàng thành công',
                  event_time: 1793695248534,
                },
              ],
            },
          ],
        },
      ],
      error_code: {},
      repeated: false,
      retry: false,
    };
    expect(lazadaPackageEvents(real)).toEqual([
      {
        packageCode: 'FP070211659297364',
        trackingCode: 'SOF_FP070211659297364',
        status: 'delivered',
        at: new Date(1793695248534),
        description: 'Kiện hàng của bạn đã được giao thành công',
      },
    ]);
  });

  it('module rỗng (đơn chưa sẵn sàng giao) trả []', async () => {
    expect(lazadaPackageEvents({ success: true, module: [{ package_detail_info_list: [] }] })).toEqual([]);
    expect(lazadaPackageEvents({ success: true, module: [] })).toEqual([]);
    expect(lazadaPackageEvents(undefined)).toEqual([]);
    const fn = vi.fn().mockResolvedValueOnce(json({ code: '0', result: { success: true, module: [] } }));
    expect(await createLazadaAdapter(config, fn).getPackageEvents!('t', '1')).toEqual([]);
  });
});
