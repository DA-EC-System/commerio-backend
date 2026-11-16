// Một dòng của PATCH sửa hàng loạt (#242). Service kiểm từng dòng bằng schema này để lỗi một dòng không chặn dòng khác;
// api/schemas.ts dùng lại cho tài liệu OpenAPI.
import { z } from 'zod';

const POSITIVE_INT = 'Nhập số nguyên lớn hơn 0';
const version = z.number('Thiếu version').int().positive();
/** Giá (đồng); bỏ trường là giữ, `null` là xoá. */
const price = z.int(POSITIVE_INT).positive(POSITIVE_INT).nullable().optional();

const bulkMeasure = (max: number, what: string) =>
  z.int(POSITIVE_INT).positive(POSITIVE_INT).max(max, `${what} tối đa ${max}`).nullable().optional();

/** Một dòng lưu. Kiểm từng dòng ở service (lỗi một dòng không chặn dòng khác), schema này để tài liệu và để service kiểm. */
export const BulkRowInput = z
  .strictObject(
    {
      variantId: z.string('Thiếu variantId'),
      version,
      reorderVersion: z
        .int('reorderVersion là số nguyên')
        .min(0, 'reorderVersion từ 0')
        .nullable()
        .optional()
        .meta({ description: '`reorderVersion` của dòng (null hoặc 0: SKU chưa có dòng tồn). Bắt buộc khi gửi `minQty`' }),
      standardPrice: price.meta({ description: 'Giá chuẩn (đồng)' }),
      targetNetPrice: price.meta({ description: 'Giá muốn bán (đồng); đổi thì phát `catalog.variant_price_changed`' }),
      minQty: z
        .int('Ngưỡng tồn là số nguyên')
        .min(0, 'Ngưỡng tồn từ 0')
        .max(1_000_000, 'Ngưỡng tồn tối đa 1.000.000')
        .nullable()
        .optional()
        .meta({ description: 'Ngưỡng tồn; cần quyền `inventory.reorder.manage`; null là bỏ ngưỡng' }),
      weightG: bulkMeasure(50_000, 'Cân nặng (g)').meta({ description: 'Cân nặng gói (gam), tối đa 50.000' }),
      lengthMm: bulkMeasure(2_000, 'Chiều dài (mm)').meta({ description: 'Chiều dài gói (mm), tối đa 2.000' }),
      widthMm: bulkMeasure(2_000, 'Chiều rộng (mm)').meta({ description: 'Chiều rộng gói (mm), tối đa 2.000' }),
      heightMm: bulkMeasure(2_000, 'Chiều cao (mm)').meta({ description: 'Chiều cao gói (mm), tối đa 2.000' }),
    },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `Không sửa được trường ${iss.keys.join(', ')} ở đây` : undefined) },
  )
  .meta({ id: 'BulkEditRowInput' });
