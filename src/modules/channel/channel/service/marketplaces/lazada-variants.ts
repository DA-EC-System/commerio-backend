// Lazada: sản phẩm nhiều SKU (#295). Hàm thuần dựng phần `Variation`, `Sku` của `/product/create` và ghép `sku_list` theo
// SellerSku; `lazada.ts` gọi sàn. Trường theo CreateProduct (open.lazada.com) và lần gọi thật 21/11/2026 (shop thử, leaf 7930,
// request_id 2141336017952085765394071 tạo, 214ee32317952086585805747 thêm theo AssociatedSku):
// `Product.Variation.VariationN { name, hasImage, customize, options.option[] }`, `Sku.saleProp { <trục>: <nhãn> }`,
// `Sku.Images.Image[]`. Chi tiết đo: `Documents/tich-hop-san/goi-thu-bien-the-thong-so.md` mục 2c.2.
import { type CreatedSku, MarketplaceError, type ProductSku, type SalesAttribute, skuAxes } from './common.ts';

/** Tên trục gửi cho sàn: mã sale prop của leaf; trục tự đặt tên (`code` null) thì chính tên. */
const axisName = (a: SalesAttribute) => a.code ?? a.name;

/** `Product.Variation`: mỗi trục một `VariationN`, `hasImage` khi có giá trị mang ảnh. */
export function lazadaVariation(attrs: readonly SalesAttribute[]): Record<string, unknown> {
  return Object.fromEntries(
    attrs.map((a, i) => [
      `Variation${i + 1}`,
      {
        name: axisName(a),
        hasImage: a.values.some((v) => v.imageUri),
        customize: a.code === null,
        options: { option: a.values.map((v) => v.label) },
      },
    ]),
  );
}

/**
 * Phần riêng của từng phân loại: `SellerSku`, `saleProp`, `Images` (ảnh của giá trị trên trục ảnh). Trường chung (giá, tồn,
 * kích thước) do bên gọi trải thêm. Sản phẩm một SKU (không trục) chỉ có `SellerSku`.
 */
export function lazadaSkuIdentity(sku: ProductSku, attrs: readonly SalesAttribute[] | undefined) {
  const axes = skuAxes(attrs, sku);
  if (!axes.length) return { SellerSku: sku.sellerSku };
  const images = axes.flatMap((x) => (x.value?.imageUri ? [x.value.imageUri] : []));
  return {
    SellerSku: sku.sellerSku,
    saleProp: Object.fromEntries(axes.map((x) => [axisName(x.attr), x.label])),
    ...(images.length && { Images: { Image: images } }),
  };
}

/** SKU Lazada trả về trong `data.sku_list` của CreateProduct. */
export interface LazadaCreatedSku {
  seller_sku?: unknown;
  sku_id?: unknown;
}

/**
 * Ghép `sku_list` với các SellerSku đã gửi theo `seller_sku` (Lazada không giữ thứ tự gửi), bỏ SKU cũ của sản phẩm (khi
 * thêm phân loại sàn trả cả SKU cũ). Một SKU và sàn không ghi `seller_sku` thì lấy phần tử đầu như trước.
 */
export function matchCreatedSkus(sellerSkus: readonly string[], list: readonly LazadaCreatedSku[] | undefined): CreatedSku[] {
  const rows = list ?? [];
  if (sellerSkus.length === 1 && rows.length >= 1 && rows.every((r) => r.seller_sku === undefined)) {
    const id = rows[0]!.sku_id;
    return id === undefined ? [] : [{ sellerSku: sellerSkus[0]!, externalSkuId: String(id) }];
  }
  return sellerSkus.flatMap((sellerSku) => {
    const row = rows.find((r) => String(r.seller_sku ?? '') === sellerSku && r.sku_id !== undefined);
    return row ? [{ sellerSku, externalSkuId: String(row.sku_id) }] : [];
  });
}

/** `SkuId` số của một SKU sẵn có trong sản phẩm (`/product/item/get` `data.skus[]`), cho `AssociatedSku`. Không có thì lỗi. */
export function associatedSkuId(data: unknown): string {
  const skus = (data as { skus?: { SkuId?: unknown }[] } | undefined)?.skus;
  const id = Array.isArray(skus) ? skus.find((s) => s?.SkuId !== undefined && s.SkuId !== null && String(s.SkuId) !== '')?.SkuId : undefined;
  if (id === undefined) throw new MarketplaceError('rejected', 'sku_not_found', 'Sản phẩm trên sàn không còn SKU nào để thêm phân loại vào');
  return String(id);
}
