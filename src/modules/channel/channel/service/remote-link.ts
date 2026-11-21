// Liên kết SKU sàn ngoài thiết lập gian hàng (Documents/21 §18.9 R2): liên kết hàng loạt, tạo SKU kho từ một SKU sàn.
// Cả hai đi qua `matchListing` (cùng luật ghép tay #220: CEO duyệt, áp lên đơn đã về, spec từ sàn).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findRemoteSkuRow, linkedVariantsOfRemoteProduct, remoteSkusOfProduct } from '../repository/remote-skus.ts';
import type { ListingVariant } from './product-port.ts';
import type { ChannelListing } from './listings.ts';
import { matchListing } from './mapping.ts';
import type { ProductPort } from './product-port.ts';
import { CANNOT_CREATE, createBlocker, productNameOf, remotePrices } from './setup.ts';
import { type Actor, ownShop } from './shops.ts';

export interface BulkPairResult {
  externalSkuId: string;
  variantId: string;
  outcome: 'matched' | 'pending' | 'failed';
  code: string | null;
  message: string | null;
}

const invalid = (errors: Record<string, string>) => new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

/**
 * Mỗi cặp một giao dịch riêng (`matchListing`), thành công được một phần; kết quả theo thứ tự body. Hai cặp trùng
 * `externalSkuId`: 422, không ghi cặp nào. Lỗi không phải `AppError` (lỗi lập trình, DB) cũng thành `failed` để cặp đã
 * ghi vẫn được báo, kèm log.
 */
export async function matchBulk(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  pairs: readonly { externalSkuId: string; variantId: string }[],
): Promise<BulkPairResult[]> {
  const first = new Map<string, number>();
  const errors: Record<string, string> = {};
  pairs.forEach((p, i) => {
    if (first.has(p.externalSkuId)) errors[`pairs.${i}.externalSkuId`] = `Trùng SKU sàn với cặp ${first.get(p.externalSkuId)! + 1}`;
    else first.set(p.externalSkuId, i);
  });
  if (Object.keys(errors).length) throw invalid(errors);
  await withCompany(actor.companyId, () => ownShop(shopId));
  const results: BulkPairResult[] = [];
  for (const p of pairs) {
    try {
      const { pending } = await matchListing(port, actor, shopId, p);
      results.push({ ...p, outcome: pending ? 'pending' : 'matched', code: null, message: null });
    } catch (err) {
      if (!(err instanceof AppError)) logger.error({ err, shopId, externalSkuId: p.externalSkuId }, 'match-bulk: lỗi không dự kiến');
      results.push({
        ...p,
        outcome: 'failed',
        code: err instanceof AppError ? err.code : 'internal_error',
        message: err instanceof AppError ? err.message : 'Lỗi hệ thống, thử lại sau',
      });
    }
  }
  return results;
}

/**
 * Nhãn biến thể của SKU sàn tách từ tên: bản sao chỉ giữ `title` (adapter ghép "<tên sản phẩm> - <nhãn>" cho sản phẩm nhiều
 * SKU). Phần đầu là tên chung của mọi SKU anh em, thử từ dấu " - " cuối về đầu. Không tách được thì null. Hàm thuần.
 */
export function labelFromTitle(title: string, siblingTitles: readonly string[]): string | null {
  const others = siblingTitles.filter((t) => t !== title);
  if (!others.length) return null;
  for (let i = title.lastIndexOf(' - '); i > 0; i = title.lastIndexOf(' - ', i - 1)) {
    const head = `${title.slice(0, i)} - `;
    if (others.every((t) => t.startsWith(head))) return title.slice(i + 3).trim() || null;
  }
  return null;
}

/**
 * Sản phẩm app đã nhận các SKU anh em (cùng sản phẩm sàn) đã liên kết (KB3): chỉ khi mọi SKU anh em đã liên kết nằm ở đúng
 * một sản phẩm app và sản phẩm đó có đúng một thuộc tính biến thể (thêm biến thể giữ bộ trục). Không thì null: tạo sản phẩm
 * riêng như trước.
 */
function parentOfSiblings(variants: readonly ListingVariant[], linked: readonly string[]): string | null {
  const products = new Set(variants.filter((v) => linked.includes(v.id)).map((v) => v.productId));
  if (products.size !== 1) return null;
  const [productId] = [...products];
  const siblings = variants.filter((v) => v.productId === productId && !v.archived);
  return siblings.length && siblings.every((v) => v.attributes.length === 1) ? productId! : null;
}

/**
 * Tạo SKU kho từ SKU sàn rồi liên kết (cùng luật dòng `create: true` của `POST /setup`, #500), một giao dịch: SKU người bán
 * làm mã; trùng SKU kho chưa lưu trữ thì liên kết vào SKU đó (`created: false`, 25 §6.1). Liên kết lỗi thì không tạo gì.
 */
export async function createVariantFromRemote(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  externalSkuId: string,
  groupId: string,
): Promise<{ variantId: string; created: boolean; pending: boolean; listing: ChannelListing }> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    if (shop.status !== 'active') {
      throw new AppError(409, 'shop_not_active', 'Hoàn tất thiết lập gian hàng trước khi liên kết SKU', { current: shop.status });
    }
    const remote = await findRemoteSkuRow(shop.id, externalSkuId);
    if (!remote) throw invalid({ externalSkuId: 'SKU sàn chưa có trong lần đồng bộ gần nhất, bấm Tải lại' });
    const variants = await port.variants();
    const same = variants.find((v) => v.sku === remote.sellerSku && !v.archived);
    let variantId = same?.id;
    if (!variantId) {
      const reason = createBlocker(variants, actor)(remote.sellerSku);
      if (reason === 'no_permission') throw new AppError(403, 'forbidden', CANNOT_CREATE.no_permission);
      // `sku_taken` ở đây là SKU của biến thể đã lưu trữ: không tạo trùng, không tự liên kết vào hàng ngừng bán.
      if (reason) throw invalid({ externalSkuId: reason === 'sku_taken' ? 'SKU người bán trùng SKU kho đã lưu trữ' : CANNOT_CREATE[reason] });
      if (!port.createFromPlatform) throw invalid({ externalSkuId: 'Chưa tạo được SKU kho từ SKU sàn' });
      const prices = (await remotePrices(shop.id))(remote.price);
      // SKU anh em của sản phẩm sàn này đã liên kết vào một sản phẩm app: thêm làm biến thể của sản phẩm đó (KB3), không
      // tạo sản phẩm app thứ hai cho cùng một sản phẩm sàn.
      const parentId = parentOfSiblings(variants, await linkedVariantsOfRemoteProduct(shop.id, remote.externalProductId));
      const label = parentId ? labelFromTitle(remote.title, (await remoteSkusOfProduct(shop.id, remote.externalProductId)).map((r) => r.title)) : null;
      const result = await port.createFromPlatform(
        { companyId: actor.companyId, accountId: actor.accountId },
        groupId,
        [
          {
            name: productNameOf(remote),
            variants: [{ key: remote.externalSkuId, sku: remote.sellerSku, label, ...prices }],
            ...(parentId && { parentId }),
          },
        ],
        { shopId: shop.id, shopName: shop.shopName },
      );
      if (!result.ok) {
        throw invalid({
          ...(result.groupError && { groupId: result.groupError }),
          ...(result.errors.get(remote.externalSkuId) && { externalSkuId: result.errors.get(remote.externalSkuId)! }),
        });
      }
      variantId = result.variantIds.get(remote.externalSkuId)!;
    }
    // `matchListing` mở `withCompany` cùng công ty: đi chung giao dịch này, lỗi thì rollback cả SKU vừa tạo.
    const { listing, pending } = await matchListing(port, actor, shopId, { externalSkuId, variantId });
    return { variantId, created: !same, pending, listing };
  });
}
