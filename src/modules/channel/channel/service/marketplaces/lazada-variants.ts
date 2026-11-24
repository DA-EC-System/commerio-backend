// Lazada: sản phẩm nhiều SKU (#295). Hàm thuần dựng phần `variation`, `Sku` của `/product/create` và ghép `sku_list` theo
// SellerSku; `lazada.ts` gọi sàn. Trường theo CreateProduct, "Custom sales attributes" (open.lazada.com docId 120259, đọc
// 24/11/2026) và lần gọi thật (shop thử): `Product.variation.variationN { name, hasImage, customize, options.option[] }`,
// `Sku.saleProp { <tên thuộc tính biến thể>: <nhãn> }`, `Sku.Images.Image[]`. Chi tiết đo:
// `Documents/tich-hop-san/goi-thu-bien-the-thong-so.md` mục 2c.2, `Documents/21` §18.8.3 (#572).
//
// BẪY (#572, đo 24/11/2026): khoá khai báo phải viết thường `variation`/`variationN`. Viết hoa `Variation`/`Variation1` thì sàn
// coi như không khai báo: sale prop chuẩn vẫn qua, tên tự đặt bị từ chối `BIZ_CHECK_SALEPROP_ATTRIBUTE_INVALID` (request_id
// 0bb4a6bf17955171474545020); viết thường thì nhận ("Phần", 21412a8b17955171484212824).
import { type CreatedSku, MarketplaceError, type ProductSku, type SalesAttribute, skuAxes } from './common.ts';

/** Tên thuộc tính biến thể gửi sàn: mã sale prop của leaf; tên tự đặt (`code` null) thì chính tên. */
const axisName = (a: SalesAttribute) => a.code ?? a.name;

/**
 * Lazada không nhận ảnh trên sale prop chuẩn `size` (`VARIATION_CATEGORY_SIZE_IMAGE`, open.lazada.com "Custom sales
 * attributes", đọc 24/11/2026): trục đó không gửi ảnh, kể cả khi là thuộc tính biến thể ghép có trục màu mang ảnh (#568).
 */
const takesImage = (a: SalesAttribute) => a.code !== 'size';

const hasImage = (a: SalesAttribute) => takesImage(a) && a.values.some((v) => v.imageUri);

/**
 * `Product.variation`: mỗi thuộc tính biến thể một `variationN`. Thuộc tính gắn ảnh đưa lên `variation1`: Lazada chỉ nhận
 * `hasImage` ở thuộc tính thứ nhất (`VARIATION_IMAGE_MUST_SET_VARIATION1`, request_id 2140fd6c17955176904316832); `saleProp` của
 * SKU khoá theo tên nên đổi thứ tự không ảnh hưởng. `customize` chỉ true với tên tự đặt: gửi true cho sale prop chuẩn thì sàn
 * biến nó thành thuộc tính tự đặt tên "color_family" (d742e42a17955176689262638); giá trị ngoài lựa chọn vẫn nhận với false.
 */
export function lazadaVariation(
  attrs: readonly SalesAttribute[],
  keep: (attrIndex: number, label: string) => boolean = () => true,
): Record<string, unknown> {
  const indexed = attrs.map((a, i) => ({ a, i }));
  const ordered = [...indexed.filter((x) => hasImage(x.a)), ...indexed.filter((x) => !hasImage(x.a))];
  return Object.fromEntries(
    ordered.map(({ a, i }, n) => [
      `variation${n + 1}`,
      {
        name: axisName(a),
        hasImage: hasImage(a),
        customize: a.code === null,
        options: { option: a.values.map((v) => v.label).filter((label) => keep(i, label)) },
      },
    ]),
  );
}

/**
 * Khai báo cho thêm phân loại (`AssociatedSku`): thứ tự, `hasImage` như lúc tạo (theo mọi giá trị của sản phẩm), lựa chọn chỉ
 * gồm giá trị các SKU mới dùng. Không khai báo thì sản phẩm có thuộc tính tên tự đặt bị từ chối "Phần is not found in the
 * variation label" (d742e42a17955177348851472); khai báo giá trị mới thì nhận (21012a9617955177478925660).
 */
export function lazadaAddVariation(attrs: readonly SalesAttribute[], skus: readonly ProductSku[]): Record<string, unknown> {
  return lazadaVariation(attrs, (i, label) => skus.some((s) => s.values[i] === label));
}

/**
 * Phần riêng của từng phân loại: `SellerSku`, `saleProp`, `Images` (ảnh của giá trị trên trục ảnh). Trường chung (giá, tồn,
 * kích thước) do bên gọi trải thêm. Sản phẩm một SKU (không trục) chỉ có `SellerSku`.
 */
export function lazadaSkuIdentity(sku: ProductSku, attrs: readonly SalesAttribute[] | undefined) {
  const axes = skuAxes(attrs, sku);
  if (!axes.length) return { SellerSku: sku.sellerSku };
  const images = axes.flatMap((x) => (takesImage(x.attr) && x.value?.imageUri ? [x.value.imageUri] : []));
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
