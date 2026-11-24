// Liên kết SKU sàn hàng loạt (#565, Documents/21 §18.12 `POST sku-links`). Gian hàng `active` áp ngay: `link`, `unmanaged`
// mỗi dòng một giao dịch qua `matchListing` (luật ghép tay #220: CEO duyệt, áp lên đơn đã về, spec từ sàn); dòng `create`
// gom theo sản phẩm sàn, mỗi sản phẩm sàn một giao dịch (tạo SKU kho rồi liên kết; một dòng lỗi thì cả nhóm không tạo).
// Gian hàng `connecting` ghi nháp (`writeSetupDraft`, be#569).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findRemoteSkuRow, linkedVariantsOfRemoteProduct, type RemoteSkuRow } from '../repository/remote-skus.ts';
import { matchListing } from './mapping.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { labelFromTitle, parentOfSiblings } from './remote-link.ts';
import { CANNOT_CREATE, canManageProducts, createBlocker, productNameOf, remotePrices } from './setup.ts';
import { type SkuLinksInput, writeSetupDraft } from './setup-draft.ts';
import { type Actor, ownShop } from './shops.ts';

export interface SkuLinkResult {
  externalSkuId: string;
  result: 'linked' | 'pending' | 'created' | 'error';
  variantId: string | null;
  productId: string | null;
  code: string | null;
  message: string | null;
}

type Item = NonNullable<SkuLinksInput['items']>[number];

const invalid = (errors: Record<string, string>, extra: Record<string, unknown> = {}) =>
  new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
    errors,
    ...extra,
  });

const failed = (externalSkuId: string, code: string, message: string): SkuLinkResult => ({
  externalSkuId,
  result: 'error',
  variantId: null,
  productId: null,
  code,
  message,
});

const errorOf = (externalSkuId: string, err: unknown): SkuLinkResult => {
  if (err instanceof AppError) {
    // Lỗi theo ô của `matchListing` (vd SKU sàn vắng bản sao): lấy câu của ô, không câu chung "Dữ liệu không hợp lệ".
    const fields = (err.extensions?.errors ?? {}) as Record<string, string>;
    return failed(externalSkuId, err.code, Object.values(fields)[0] ?? err.message);
  }
  logger.error({ err, externalSkuId }, 'sku-links: lỗi không dự kiến');
  return failed(externalSkuId, 'internal_error', 'Lỗi hệ thống, thử lại sau');
};

/** Kiểm hình dạng cả body (không phụ thuộc trạng thái gian hàng): sai thì 422, không ghi dòng nào. */
function checkShape(input: SkuLinksInput): void {
  const errors: Record<string, string> = {};
  const firstSku = new Map<string, number>();
  (input.items ?? []).forEach((it, i) => {
    const prev = firstSku.get(it.externalSkuId);
    if (prev !== undefined) errors[`items.${i}.externalSkuId`] = `Trùng SKU sàn với dòng ${prev + 1}`;
    else firstSku.set(it.externalSkuId, i);
    if (it.action === 'link' && !it.variantId) errors[`items.${i}.variantId`] = 'Chọn SKU kho để liên kết';
  });
  const firstProduct = new Map<string, number>();
  (input.groups ?? []).forEach((g, i) => {
    const prev = firstProduct.get(g.externalProductId);
    if (prev !== undefined) errors[`groups.${i}.externalProductId`] = `Trùng sản phẩm sàn với dòng ${prev + 1}`;
    else firstProduct.set(g.externalProductId, i);
  });
  if (Object.keys(errors).length) throw invalid(errors);
}

/**
 * Nhóm hàng hợp lệ (danh mục chuẩn hoặc của công ty, đọc qua RLS): hỏi catalog bằng `createFromPlatform` không sản phẩm
 * nào, catalog kiểm nhóm trước và không ghi gì khi danh sách rỗng. Gọi trong `withCompany`.
 */
async function groupValid(port: ProductPort, actor: Actor, groupId: string, shop: { id: string; shopName: string }): Promise<boolean> {
  const r = await port.createFromPlatform!({ companyId: actor.companyId, accountId: actor.accountId }, groupId, [], {
    shopId: shop.id,
    shopName: shop.shopName,
  });
  return r.ok || r.groupError === null;
}

/**
 * `POST /channel/shops/:id/sku-links`. Thứ tự lỗi: 422 hình dạng (trùng dòng, `link` thiếu biến thể) → 404 gian hàng →
 * 409 `shop_not_connected` (`needs_reauth`, `disconnected`) → `connecting` ghi nháp (#569) → 403 thiếu quyền tạo sản phẩm
 * khi có dòng `create` → 422 `skip` ở gian hàng `active`, thiếu `groups` cho sản phẩm sàn có dòng `create`, nhóm sai. Qua
 * hết thì áp từng dòng, HTTP 200 kể cả khi có dòng lỗi.
 */
export async function linkSkus(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: SkuLinksInput,
): Promise<{ results: SkuLinkResult[] }> {
  checkShape(input);
  const items = input.items ?? [];
  const groups = input.groups ?? [];
  const shop = await withCompany(actor.companyId, () => ownShop(shopId));
  if (shop.status === 'needs_reauth' || shop.status === 'disconnected') {
    throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối, kết nối lại rồi liên kết SKU', { current: shop.status });
  }
  if (shop.status === 'connecting') return writeSetupDraft(actor, shopId, input);

  const creates = items.filter((it) => it.action === 'create');
  if (creates.length && !canManageProducts(actor)) throw new AppError(403, 'forbidden', CANNOT_CREATE.no_permission);
  const errors: Record<string, string> = {};
  items.forEach((it, i) => {
    if (it.action === 'skip') errors[`items.${i}.action`] = 'Gian hàng đang bán không có "Bỏ qua"; để trống dòng đó';
  });
  if (Object.keys(errors).length) throw invalid(errors);

  // Sản phẩm sàn của các dòng `create`, đọc từ bản sao; SKU vắng bản sao thì dòng đó lỗi lúc áp, không chặn cả request.
  const pre = await withCompany(actor.companyId, async () => {
    const remote = new Map<string, RemoteSkuRow>();
    for (const it of creates) {
      const row = await findRemoteSkuRow(shop.id, it.externalSkuId);
      if (row) remote.set(it.externalSkuId, row);
    }
    const groupOf = new Map(groups.map((g) => [g.externalProductId, g.groupId]));
    const missing = [...new Set([...remote.values()].map((r) => r.externalProductId))].filter((p) => !groupOf.has(p));
    if (missing.length) {
      throw invalid({ groups: 'Chọn danh mục sản phẩm cho mọi sản phẩm sàn sắp tạo' }, { externalProductIds: missing });
    }
    if (creates.length && !port.createFromPlatform) throw invalid({ items: 'Chưa tạo được SKU kho từ SKU sàn' });
    const groupErrors: Record<string, string> = {};
    const checked = new Map<string, boolean>();
    for (const [i, g] of groups.entries()) {
      if (!checked.has(g.groupId)) checked.set(g.groupId, await groupValid(port, actor, g.groupId, shop));
      if (!checked.get(g.groupId)) groupErrors[`groups.${i}.groupId`] = 'Danh mục sản phẩm không thuộc công ty';
    }
    if (Object.keys(groupErrors).length) throw invalid(groupErrors);
    return { remote, groupOf };
  });

  const results = new Map<string, SkuLinkResult>();
  const productOf = async (variantId: string) =>
    withCompany(actor.companyId, async () => (await port.variants([variantId]))[0]?.productId ?? null);

  for (const it of items.filter((i) => i.action === 'link' || i.action === 'unmanaged')) {
    const variantId = it.action === 'link' ? it.variantId! : null;
    try {
      const { pending } = await matchListing(port, actor, shopId, {
        externalSkuId: it.externalSkuId,
        variantId,
      });
      results.set(it.externalSkuId, {
        externalSkuId: it.externalSkuId,
        result: pending ? 'pending' : 'linked',
        variantId,
        productId: variantId ? await productOf(variantId) : null,
        code: null,
        message: null,
      });
    } catch (err) {
      results.set(it.externalSkuId, errorOf(it.externalSkuId, err));
    }
  }

  const byProduct = new Map<string, Item[]>();
  for (const it of creates) {
    const row = pre.remote.get(it.externalSkuId);
    if (!row) {
      results.set(
        it.externalSkuId,
        failed(it.externalSkuId, 'validation_failed', 'SKU sàn chưa có trong lần đồng bộ gần nhất, bấm Tải lại'),
      );
      continue;
    }
    byProduct.set(row.externalProductId, [...(byProduct.get(row.externalProductId) ?? []), it]);
  }
  for (const [externalProductId, group] of byProduct) {
    const rows = group.map((it) => pre.remote.get(it.externalSkuId)!);
    for (const r of await createGroup(port, actor, shop, externalProductId, pre.groupOf.get(externalProductId)!, rows)) {
      results.set(r.externalSkuId, r);
    }
  }
  return { results: items.map((it) => results.get(it.externalSkuId)!) };
}

/** Cả nhóm `create` của một sản phẩm sàn hỏng: dòng gây lỗi giữ mã của nó, dòng còn lại báo vì sao không tạo. */
class GroupFailure extends Error {
  readonly results: SkuLinkResult[];
  constructor(results: SkuLinkResult[]) {
    super('sku-links: nhóm create lỗi');
    this.results = results;
  }
}

const groupAborted = (rows: readonly RemoteSkuRow[], own: ReadonlyMap<string, SkuLinkResult>) =>
  rows.map(
    (r) =>
      own.get(r.externalSkuId) ??
      failed(r.externalSkuId, 'group_failed', 'SKU khác cùng sản phẩm sàn bị lỗi nên chưa tạo; sửa dòng lỗi rồi gửi lại'),
  );

/**
 * Tạo SKU kho cho các SKU sàn cùng một sản phẩm sàn rồi liên kết, một giao dịch (§18.12, luật dòng `create` của 18.7.5):
 * SKU anh em đã liên kết vào **một** sản phẩm kho có đúng một trục thì thêm biến thể vào đó; ở nhiều sản phẩm kho thì
 * `platform_product_split`; không thì một sản phẩm mới (nhiều SKU thì trục "Phân loại", giá trị là nhãn biến thể sàn).
 */
async function createGroup(
  port: ProductPort,
  actor: Actor,
  shop: { id: string; shopName: string },
  externalProductId: string,
  groupId: string,
  rows: readonly RemoteSkuRow[],
): Promise<SkuLinkResult[]> {
  try {
    return await withCompany(actor.companyId, async () => {
      const variants: ListingVariant[] = await port.variants();
      const blocker = createBlocker(variants, actor);
      const own = new Map<string, SkuLinkResult>();
      for (const r of rows) {
        const reason = blocker(r.sellerSku);
        if (reason) own.set(r.externalSkuId, failed(r.externalSkuId, reason, CANNOT_CREATE[reason]));
      }
      if (own.size) throw new GroupFailure(groupAborted(rows, own));

      const linked = await linkedVariantsOfRemoteProduct(shop.id, externalProductId);
      const products = new Set(variants.filter((v) => linked.includes(v.id)).map((v) => v.productId));
      if (products.size > 1) {
        throw new GroupFailure(
          rows.map((r) =>
            failed(r.externalSkuId, 'platform_product_split', 'SKU cùng sản phẩm sàn đang thuộc nhiều sản phẩm kho; liên kết tay'),
          ),
        );
      }
      const parentId = linked.length ? parentOfSiblings(variants, linked) : null;
      // Anh em ở đúng một sản phẩm kho mà không thêm biến thể vào đó được (sản phẩm nhiều thuộc tính biến thể): tạo sản phẩm
      // mới sẽ tách sản phẩm sàn thành hai sản phẩm kho, nên chặn ngay, cùng mã với ca anh em đã ở nhiều sản phẩm kho.
      if (products.size === 1 && !parentId) {
        throw new GroupFailure(
          rows.map((r) =>
            failed(
              r.externalSkuId,
              'platform_product_split',
              'SKU cùng sản phẩm sàn đã liên kết vào sản phẩm kho có nhiều thuộc tính biến thể; thêm biến thể trong kho rồi liên kết tay',
            ),
          ),
        );
      }
      const pricesOf = await remotePrices(shop.id);
      // Nhãn là giá trị phân loại sàn trả (bản sao, #565). Thêm vào sản phẩm có sẵn mà sàn không trả nhãn thì tách từ tên
      // chung của SKU anh em (KB3), như `create-variant` cũ.
      const siblingTitles = parentId ? rows.map((r) => r.title) : [];
      const label = (r: RemoteSkuRow) => r.variantLabel ?? (parentId ? labelFromTitle(r.title, siblingTitles) : null);
      const result = await port.createFromPlatform!(
        { companyId: actor.companyId, accountId: actor.accountId },
        groupId,
        [
          {
            name: productNameOf(rows[0]!),
            variants: rows.map((r) => ({
              key: r.externalSkuId,
              sku: r.sellerSku,
              label: label(r),
              ...pricesOf(r.price),
            })),
            ...(parentId && { parentId }),
          },
        ],
        { shopId: shop.id, shopName: shop.shopName },
      );
      if (!result.ok) {
        const message = result.groupError;
        for (const r of rows) {
          const m = result.errors.get(r.externalSkuId) ?? message;
          if (m) own.set(r.externalSkuId, failed(r.externalSkuId, 'validation_failed', m));
        }
        throw new GroupFailure(groupAborted(rows, own));
      }
      const productId = parentId ?? result.productIds[0] ?? null;
      const out: SkuLinkResult[] = [];
      for (const r of rows) {
        const variantId = result.variantIds.get(r.externalSkuId)!;
        try {
          // `matchListing` mở `withCompany` cùng công ty nên đi chung giao dịch này: lỗi thì rollback cả SKU vừa tạo.
          const { pending } = await matchListing(port, actor, shop.id, {
            externalSkuId: r.externalSkuId,
            variantId,
          });
          out.push({
            externalSkuId: r.externalSkuId,
            result: pending ? 'pending' : 'created',
            variantId,
            productId,
            code: null,
            message: null,
          });
        } catch (err) {
          throw new GroupFailure(groupAborted(rows, new Map([[r.externalSkuId, errorOf(r.externalSkuId, err)]])));
        }
      }
      return out;
    });
  } catch (err) {
    if (err instanceof GroupFailure) return err.results;
    return rows.map((r) => errorOf(r.externalSkuId, err));
  }
}
