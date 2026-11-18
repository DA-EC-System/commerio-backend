// Ảnh phân loại theo giá trị của thuộc tính gắn ảnh (#340, Documents/21 §17.2): đặt, thay, gỡ ảnh của một giá trị.
// Không nhận `version`, không tăng `version` sản phẩm (như P7): khoá dòng sản phẩm thay thế, cùng chiều với PUT sản phẩm
// khi đổi thuộc tính gắn ảnh.
import { withCompany } from '../../../../shared/db/client.ts';
import { confirmUploads, fileProblem, recordAudit } from '../../../core/index.ts';
import { lockProduct, type ProductRow, touchProduct } from '../repository/products.ts';
import { deleteVariantImage, upsertVariantImage, variantImageRows } from '../repository/variant-images.ts';
import { findVariants } from '../repository/variants.ts';
import { auditOf, type Caller, invalid, isUuid } from './errors.ts';
import { findOwnProduct, type ProductDetail, productDetail } from './products.ts';
import type { CatalogContext } from './standard-price.ts';

const ENTITY = 'product.products';

/** Câu lỗi ô `attributeValueId`, `null` khi giá trị thuộc thuộc tính gắn ảnh và có SKU (kể cả đã lưu trữ) mang. */
async function valueProblem(product: ProductRow, attributeValueId: string): Promise<string | null> {
  if (!product.imageAttributeId) return 'Sản phẩm chưa chọn thuộc tính gắn ảnh';
  const carried =
    isUuid(attributeValueId) &&
    (await findVariants({ productId: product.id })).some((v) =>
      v.attributes.some((a) => a.valueId === attributeValueId && a.attributeId === product.imageAttributeId),
    );
  return carried ? null : 'Giá trị không thuộc thuộc tính gắn ảnh của sản phẩm';
}

/** Sản phẩm của công ty (404 nếu không), khoá dòng rồi đọc lại để thấy thuộc tính gắn ảnh mới nhất. */
async function lockOwnProduct(id: string): Promise<ProductRow> {
  await findOwnProduct(id);
  await lockProduct(id);
  return findOwnProduct(id);
}

const currentFile = async (productId: string, attributeValueId: string) =>
  (await variantImageRows([productId])).find((r) => r.attributeValueId === attributeValueId)?.fileId ?? null;

async function audit(caller: Caller, productId: string, attributeValueId: string, before: string | null, after: string | null) {
  await recordAudit({
    ...auditOf(caller, 'update', ENTITY, productId),
    before: { attributeValueImage: { attributeValueId, fileId: before } },
    after: { attributeValueImage: { attributeValueId, fileId: after } },
  });
}

/**
 * `PUT …/attribute-value-images/:attributeValueId`. Tệp như ảnh sản phẩm: `confirmUploads` trước giao dịch,
 * `fileProblem` trong giao dịch, lỗi ở `errors.image`. Gửi lại đúng tệp đang có thì không ghi, trả bản hiện tại.
 */
export async function setVariantImage(
  ctx: CatalogContext,
  caller: Caller,
  productId: string,
  attributeValueId: string,
  fileId: string,
): Promise<ProductDetail> {
  await confirmUploads(caller.companyId, [fileId]);
  return withCompany(caller.companyId, async () => {
    const product = await lockOwnProduct(productId);
    const errors: Record<string, string> = {};
    const valueError = await valueProblem(product, attributeValueId);
    if (valueError) errors.attributeValueId = valueError;
    const fileError = await fileProblem([fileId], 'product_image', 1);
    if (fileError) errors.image = fileError;
    if (Object.keys(errors).length) throw invalid(errors);
    const before = await currentFile(productId, attributeValueId);
    if (before !== fileId) {
      await upsertVariantImage({ companyId: caller.companyId, productId, attributeId: product.imageAttributeId!, attributeValueId, fileId });
      await touchProduct(productId);
      await audit(caller, productId, attributeValueId, before, fileId);
    }
    return productDetail(ctx, await findOwnProduct(productId));
  });
}

/** `DELETE …/attribute-value-images/:attributeValueId`: gỡ ảnh, không xoá tệp. Giá trị chưa có ảnh: 200 bản hiện tại. */
export async function removeVariantImage(
  ctx: CatalogContext,
  caller: Caller,
  productId: string,
  attributeValueId: string,
): Promise<ProductDetail> {
  return withCompany(caller.companyId, async () => {
    const product = await lockOwnProduct(productId);
    const before = isUuid(attributeValueId) ? await currentFile(productId, attributeValueId) : null;
    if (before) {
      await deleteVariantImage(productId, attributeValueId);
      await touchProduct(productId);
      await audit(caller, productId, attributeValueId, before, null);
    }
    return productDetail(ctx, before ? await findOwnProduct(productId) : product);
  });
}
