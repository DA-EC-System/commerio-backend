import { z } from 'zod';

// Hợp đồng /report (Documents/21 §12.7, §12.8). Khoảng ngày mặc định, giới hạn 366 ngày kiểm ở routes.ts
// (`resolveRange`, cần "hôm nay" giờ VN), lỗi vẫn là 422 theo ô như `validate()`.

const day = (label: string) => z.iso.date(`${label} dạng YYYY-MM-DD`).optional();
const source = z.enum(['marketplace', 'inbox', 'manual'], 'Nguồn là marketplace, inbox hoặc manual');

export const RangeQuery = z.object({ from: day('Từ ngày'), to: day('Đến ngày') });
export const DailyQuery = RangeQuery.extend({
  source: source.optional(),
  shopId: z.uuid('Gian hàng không hợp lệ').optional().meta({ description: 'Chỉ đi với nguồn `marketplace` (bỏ trống nguồn cũng được)' }),
});
export const ExportQuery = DailyQuery.extend({
  report: z.enum(['overview', 'shops', 'daily'], 'Báo cáo là overview, shops hoặc daily'),
});

const money = z.number().int();
export const ReportFigures = z
  .object({
    revenue: money,
    cashCollected: money,
    platformFee: money,
    paymentFee: money,
    shippingFee: money,
    cogs: money.nullable().meta({ description: '`null` khi thiếu `inventory.cost.view`' }),
    profit: money.nullable().meta({ description: '`null` khi thiếu `inventory.cost.view`' }),
    feesPending: z.boolean().meta({ description: 'Có ngày chưa đối soát nên phí sàn đang là 0' }),
  })
  .meta({ id: 'ReportFigures', description: 'Tiền là số nguyên đồng' });

const head = {
  from: z.iso.date(),
  to: z.iso.date(),
  asOf: z.string().nullable().meta({ description: 'Lần tính lại gần nhất của số trong khoảng; `null` khi chưa có số' }),
};

export const OverviewResponse = z.object({ ...head, ...ReportFigures.shape }).meta({ id: 'ReportOverview' });
export const ShopFigures = ReportFigures.extend({
  source,
  shop: z.object({ id: z.string(), shopName: z.string().nullable(), platform: z.string().nullable() }).nullable(),
}).meta({ id: 'ShopFigures' });
export const ShopsResponse = z.object({ ...head, items: z.array(ShopFigures), total: ReportFigures }).meta({ id: 'ReportShops' });
export const DailyResponse = z
  .object({ ...head, items: z.array(ReportFigures.extend({ day: z.iso.date() })) })
  .meta({ id: 'ReportDaily' });
