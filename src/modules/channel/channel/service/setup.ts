// Thiết lập lần đầu (#104, #198; Documents/21 §18.2, §18.6.2): ghép listing có sẵn trên sàn, gian hàng
// `connecting → active`. Mốc kéo đơn do BE đặt bằng lúc thiết lập (không nhận từ người dùng, §18.7.6). Gian hàng đầu tiên
// của công ty buộc kiểm kê đầu kỳ (`stocktake`): lập phiếu qua cổng inventory, gian hàng ở chế độ chờ kiểm kê tới khi
// phiếu ghi sổ. Gọi sàn ngoài giao dịch.
import { Decimal } from 'decimal.js';
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { moduleOfPermission } from '../../../../shared/auth/company-access.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { returnWindowError, shopMachine } from '../domain/shop.ts';
import { listListingRows, nameSimilarities } from '../repository/listings.ts';
import { upsertRemoteSkus } from '../repository/remote-skus.ts';
import { lockCompanySetup, setupStateOfCompany, updateShop } from '../repository/shops.ts';
import { insertListing } from './listing-writes.ts';
import { saveFullSnapshot } from './remote-skus.ts';
import { stocktakePort } from './stocktake-port.ts';
import { syncListings } from './listing-sync.ts';
import { capabilitiesOf } from './marketplaces/index.ts';
import type { RemoteState } from './marketplaces/common.ts';
import { sendOpenOrderPull, startShopJobs } from './shop-jobs.ts';
import { recordShopTransition } from './shop-transition.ts';
import { sendSpecFromMatch } from './spec-from-match.ts';
import { PLATFORM_SKU_MAX, type PlatformProductInput } from '../../../product/index.ts';
import { targetForPrice } from '../domain/price-filter.ts';
import { shopPriceConfig } from './price-inputs.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { type Actor, onMarketplace, ownShop, type Shop, shopSession, shopView } from './shops.ts';

export interface SetupSuggestion {
  externalSkuId: string;
  title: string;
  /** `sku`: SKU người bán trùng SKU Commerio; `name`: tên giống từ `NAME_MATCH_MIN`; `none`: không tìm được (§18.7.5). */
  match: 'sku' | 'name' | 'none';
  /** Độ giống tên 0..1, chỉ có khi `match = 'name'`. */
  score: number | null;
  variantId: string | null;
  sku: string | null;
  available: number | null;
  platformStock: number;
  /** URL ảnh đầu tiên của sản phẩm trên sàn; null khi sàn không trả hay adapter không đọc được (§18.7.5, #282). */
  imageUrl: string | null;
  /** Trạng thái sản phẩm trên sàn đã chuẩn hoá (`RemoteSku.state`); SKU đã xoá không có trong gợi ý (§18.7.5, #282). */
  status: Exclude<RemoteState, 'deleted'>;
  /** Tạo được SKU kho từ SKU sàn này (#500, §18.7.5): có SKU người bán hợp lệ chưa là SKU kho, người xem có quyền tạo sản phẩm. */
  canCreate: boolean;
  /** Lý do không tạo được, có khi và chỉ khi `canCreate = false`. */
  cannotCreateReason: CannotCreateReason | null;
}

export type CannotCreateReason = 'no_seller_sku' | 'sku_too_long' | 'sku_taken' | 'no_permission';

type Suggestion = SetupSuggestion & {
  externalProductId: string;
  sellerSku: string;
  /** Tên sản phẩm trên sàn (bỏ phần nhãn biến thể của `title`), nhãn, giá: dùng khi tạo SKU kho (#500). */
  productName: string;
  variantLabel: string | null;
  price: string | null;
};

/** Quyền tạo sản phẩm của catalog (#500): tạo SKU kho từ SKU sàn không vòng qua quyền này. */
const PRODUCT_MANAGE = 'catalog.product.manage';
const canManageProducts = (actor: Actor) =>
  actor.permissions.includes(PRODUCT_MANAGE) && actor.enabledModules.includes(moduleOfPermission(PRODUCT_MANAGE));

/** `title` của SKU thuộc sản phẩm nhiều SKU là "tên - nhãn" (TikTok, #282): bỏ đuôi để có tên sản phẩm. */
function productNameOf(r: { title: string; variantLabel?: string | null | undefined; sellerSku: string; externalSkuId: string }) {
  for (const tail of [r.variantLabel, r.sellerSku, r.externalSkuId]) {
    if (tail && r.title.endsWith(` - ${tail}`)) return r.title.slice(0, -(tail.length + 3));
  }
  return r.title;
}

/** Ngưỡng `similarity()` của pg_trgm để nhận gợi ý theo tên (Documents/21 §18.7.5). */
const NAME_MATCH_MIN = 0.4;
// Ghép tên so mọi cặp (SKU sàn × biến thể), không dùng được index. Trần số cặp và thời gian để một gian hàng lớn không
// giữ CPU của DB: đo 06/11/2026 trên PG 17 cục bộ, 1e6 cặp ≈ 3,2 giây, 9e6 cặp ≈ 30 giây (#198 worklog).
const NAME_PAIRS_MAX = 1_000_000;
const NAME_MATCH_TIMEOUT_MS = 10_000;
// Trần số cặp qua ngưỡng trả về Node: tên gần giống hàng loạt thì 1e6 cặp đều qua, giữ hết sẽ tốn hàng trăm MB (review).
const NAME_ROWS_MAX = 50_000;

const variantName = (v: ListingVariant) => [v.productName, v.attributesLabel].filter(Boolean).join(' ');

/** Các giá trị của một nhãn biến thể: thường hoá, bỏ dấu câu, tách theo chữ và số ("Trắng, M" và "trắng / m" như nhau). */
const labelTokens = (label: string | null | undefined) =>
  [...new Set((label ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))].sort().join(' ');

/**
 * Gợi ý ghép (#198, Documents/21 §18.7.5): mọi SKU người bán trên sàn (bỏ sản phẩm đã xoá), mỗi SKU một dòng. Ghép theo
 * SKU trước, phần còn lại theo tên sản phẩm kèm nhãn biến thể bằng `similarity()` của pg_trgm, nhận từ 0.4, tham lam theo
 * điểm giảm dần; mỗi biến thể gợi ý một lần. Số cặp vượt `NAME_PAIRS_MAX`, cặp qua ngưỡng vượt `NAME_ROWS_MAX` hay câu quá giờ thì bỏ ghép theo tên
 * (`nameMatchSkipped`). Biến thể lưu trữ hay đã có listing ở gian hàng này không được gợi ý. Sàn
 * chưa có `listSkus` thì chỉ đọc được SKU trùng SKU Commerio (`getSkus`).
 */
async function suggestions(port: ProductPort, actor: Actor, shopId: string, labels = true) {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(actor.companyId, fn);
  const { shop, adapter, accessToken } = await inCompany(async () => {
    const session = await shopSession(shopId);
    assertTransition(shopMachine, session.shop.status, 'finish_setup', { actor });
    return session;
  });
  const { variants, listed } = await inCompany(async () => ({
    variants: await port.variants(),
    listed: new Set((await listListingRows(shop.id)).map((l) => l.variantId)),
  }));
  const open = variants.filter((v) => !v.archived && !listed.has(v.id));
  const startedAt = new Date();
  const fetched = adapter.listSkus
    ? // Nhãn biến thể chỉ cần cho SKU ghép theo tên: sản phẩm mà mọi SKU trùng SKU Commerio còn mở thì adapter không đọc nhãn.
      await onMarketplace(() => adapter.listSkus!(accessToken, { labels, skipSellerSkus: new Set(open.map((v) => v.sku)) }))
    : open.length
      ? await onMarketplace(() => adapter.getSkus(accessToken, open.map((v) => v.sku)))
      : [];
  const remote = fetched.filter((r) => r.state !== 'deleted');
  // Bản sao SKU sàn cho trang ghép và số SKU chưa ghép (#220 đợt 2): lưu trọn danh sách vừa đọc, không gọi sàn lần hai.
  // Bước xem gợi ý (có nhãn) luôn lưu; hoàn tất bằng `decisions` (không nhãn) chỉ lưu khi chưa có bản sao, để không ghi
  // đè tiêu đề có nhãn biến thể. Sàn chưa có `listSkus` thì chỉ có phần trùng SKU Commerio, lưu phần đó.
  if (labels || !shop.remoteSkusSyncedAt) {
    await inCompany(() => (adapter.listSkus ? saveFullSnapshot(shop.id, fetched, startedAt) : upsertRemoteSkus(shop.id, fetched, startedAt)));
  }

  const chosen = new Map<number, { variant: ListingVariant; score: number | null }>();
  const taken = new Set<string>();
  const bySku = new Map(open.map((v) => [v.sku, v]));
  remote.forEach((r, i) => {
    const v = bySku.get(r.sellerSku);
    if (!v || taken.has(v.id)) return;
    chosen.set(i, { variant: v, score: null });
    taken.add(v.id);
  });
  // Tên chỉ phân biệt được biến thể khi tiêu đề là của riêng một SKU: Lazada trả tên sản phẩm cho mọi SKU của nó, nên
  // nhiều SKU cùng tiêu đề sẽ hoà điểm và ghép nhầm màu, cỡ (#198 diff-review P2). SKU không có SKU người bán thì kéo đơn
  // không tra được biến thể, không gợi ý. SKU của sản phẩm nhiều SKU mà sàn không cho nhãn biến thể (`variantLabel`) thì
  // tiêu đề chỉ khác nhau ở SKU người bán, không nói màu, cỡ nào: cũng không ghép theo tên (#282 diff-review).
  const titleCount = new Map<string, number>();
  const productSkuCount = new Map<string, number>();
  for (const r of remote) {
    titleCount.set(r.title.trim().toLowerCase(), (titleCount.get(r.title.trim().toLowerCase()) ?? 0) + 1);
    productSkuCount.set(r.externalProductId, (productSkuCount.get(r.externalProductId) ?? 0) + 1);
  }
  const unlabeledVariant = (r: (typeof remote)[number]) => productSkuCount.get(r.externalProductId)! > 1 && !r.variantLabel;
  const restRemote = remote.flatMap((r, i) =>
    chosen.has(i) || !r.sellerSku || titleCount.get(r.title.trim().toLowerCase())! > 1 || unlabeledVariant(r) ? [] : [i],
  );
  const restVariants = open.filter((v) => !taken.has(v.id));
  let nameMatchSkipped = restRemote.length * restVariants.length > NAME_PAIRS_MAX;
  const pairs =
    restRemote.length && restVariants.length && !nameMatchSkipped
      ? await inCompany(() =>
          nameSimilarities(
            restRemote.map((i) => remote[i]!.title),
            restVariants.map(variantName),
            NAME_MATCH_MIN,
            NAME_MATCH_TIMEOUT_MS,
            NAME_ROWS_MAX,
          ),
        )
      : [];
  if (pairs === null) nameMatchSkipped = true;
  else {
    // SKU sàn có nhãn biến thể thật (`variantLabel`) chỉ ghép theo tên với biến thể có cùng các giá trị thuộc tính: nhãn cỡ
    // một ký tự gần như không đổi điểm trigram, "Áo thun basic - Trắng, M" với "Áo thun basic Trắng / L" vẫn 0.83 (#282
    // review chéo I-1).
    const fitting = pairs.filter((p) => {
      const label = remote[restRemote[p.left]!]!.variantLabel;
      return !label || labelTokens(label) === labelTokens(restVariants[p.right]!.attributesLabel);
    });
    // Ngược chiều: sản phẩm của biến thể giống nhất có từ hai biến thể qua ngưỡng thì tên sàn không chỉ ra được màu, cỡ
    // nào; không gợi ý, để người dùng chọn (#198 diff-review vòng 2). `pairs` xếp điểm giảm dần nên cặp đầu của mỗi SKU là
    // cặp giống nhất.
    const bestProduct = new Map<number, string>();
    const perProduct = new Map<string, number>();
    for (const p of fitting) {
      const product = restVariants[p.right]!.productId;
      if (!bestProduct.has(p.left)) bestProduct.set(p.left, product);
      perProduct.set(`${p.left} ${product}`, (perProduct.get(`${p.left} ${product}`) ?? 0) + 1);
    }
    const ambiguous = (left: number) => perProduct.get(`${left} ${bestProduct.get(left)}`)! > 1;
    for (const p of fitting) {
      const i = restRemote[p.left]!;
      const v = restVariants[p.right]!;
      if (chosen.has(i) || taken.has(v.id) || ambiguous(p.left)) continue;
      chosen.set(i, { variant: v, score: p.score });
      taken.add(v.id);
    }
  }
  const available = taken.size ? await inCompany(() => port.availableOf([...taken])) : new Map<string, number>();
  const allSkus = new Set(variants.map((v) => v.sku));
  const mayCreate = canManageProducts(actor);
  const cannotCreate = (r: (typeof remote)[number]): CannotCreateReason | null =>
    !r.sellerSku
      ? 'no_seller_sku'
      : r.sellerSku.length > PLATFORM_SKU_MAX
        ? 'sku_too_long'
        : allSkus.has(r.sellerSku)
          ? 'sku_taken'
          : mayCreate
            ? null
            : 'no_permission';
  const offered: Suggestion[] = remote.map((r, i) => {
    const c = chosen.get(i);
    // Gợi ý theo tên chỉ là đoán: người dùng bỏ gợi ý thì vẫn tạo được (gợi ý theo SKU thì SKU đã có, `sku_taken`).
    const reason = cannotCreate(r);
    return {
      externalProductId: r.externalProductId,
      externalSkuId: r.externalSkuId,
      sellerSku: r.sellerSku,
      title: r.title,
      match: !c ? 'none' : c.score === null ? 'sku' : 'name',
      score: c?.score ?? null,
      variantId: c?.variant.id ?? null,
      sku: c?.variant.sku ?? null,
      available: c ? (available.get(c.variant.id) ?? 0) : null,
      platformStock: r.quantity,
      imageUrl: r.imageUrl ?? null,
      status: r.state as Exclude<RemoteState, 'deleted'>,
      canCreate: reason === null,
      cannotCreateReason: reason,
      productName: productNameOf(r),
      variantLabel: r.variantLabel ?? null,
      price: r.price ?? null,
    };
  });
  return { offered, variants, listed, nameMatchSkipped };
}

interface Picked {
  externalSkuId: string;
  externalProductId: string;
  sellerSku: string;
  title: string;
  variantId: string;
  platformStock: number;
}

interface SetupChoice {
  externalSkuIds?: string[] | undefined;
  decisions?: { externalSkuId: string; variantId: string | null; create?: boolean | undefined }[] | undefined;
  /** Nhóm hàng cho sản phẩm tạo từ SKU sàn; bắt buộc khi có dòng `create` (#500). */
  createGroupId?: string | undefined;
}

const CANNOT_CREATE: Record<CannotCreateReason, string> = {
  no_seller_sku: 'Sàn chưa có SKU người bán. Đặt SKU trên sàn rồi Tải lại',
  sku_too_long: `SKU người bán dài quá ${PLATFORM_SKU_MAX} ký tự`,
  sku_taken: 'SKU người bán đã là SKU kho, chọn liên kết thay vì tạo',
  no_permission: 'Bạn không có quyền tạo sản phẩm',
};

/**
 * SKU sàn sẽ thành listing. `decisions` (§18.7.5): biến thể người dùng chọn, `null` bỏ qua; lỗi theo dòng ghi vào
 * `errors["decisions.<i>"]`. `externalSkuIds` (cũ, giữ tới hết đợt 2): nhận biến thể gợi ý. Gửi cả hai là lỗi.
 */
function pickListings(
  { offered, variants, listed }: Awaited<ReturnType<typeof suggestions>>,
  input: SetupChoice,
  errors: Record<string, string>,
  toCreate: { index: number; suggestion: Suggestion }[] = [],
): Picked[] {
  if (input.decisions && input.externalSkuIds) {
    errors.decisions = 'Chỉ gửi một trong `decisions` hoặc `externalSkuIds`';
    return [];
  }
  if (!input.decisions) {
    const ids = new Set(input.externalSkuIds ?? []);
    const picked = offered.flatMap((s) => (s.variantId && ids.has(s.externalSkuId) ? [{ ...s, variantId: s.variantId }] : []));
    if (picked.length !== ids.size) errors.externalSkuIds = 'Có SKU sàn không còn để liên kết';
    return picked;
  }
  const byExternal = new Map(offered.map((s) => [s.externalSkuId, s]));
  const byId = new Map(variants.map((v) => [v.id, v]));
  const seenSkus = new Set<string>();
  const seenVariants = new Set<string>();
  const seenCreateSkus = new Set<string>();
  const picked: Picked[] = [];
  input.decisions.forEach((d, i) => {
    const s = byExternal.get(d.externalSkuId);
    if (d.create) {
      const error = !s
        ? 'SKU sàn không có trong gợi ý'
        : d.variantId !== null
          ? 'Tạo SKU kho thì không chọn biến thể'
          : seenSkus.has(d.externalSkuId)
            ? 'SKU sàn bị chọn hai lần'
            : !s.canCreate
              ? CANNOT_CREATE[s.cannotCreateReason!]
              : seenCreateSkus.has(s.sellerSku)
                ? 'Hai SKU sàn cùng SKU người bán'
                : null;
      seenSkus.add(d.externalSkuId);
      if (error) errors[`decisions.${i}`] = error;
      else {
        seenCreateSkus.add(s!.sellerSku);
        toCreate.push({ index: i, suggestion: s! });
      }
      return;
    }
    const v = d.variantId === null ? undefined : byId.get(d.variantId);
    const error = !s
      ? 'SKU sàn không có trong gợi ý'
      : d.variantId !== null && !s.sellerSku
        ? 'SKU sàn chưa có SKU người bán, đặt trên sàn trước rồi liên kết'
        : seenSkus.has(d.externalSkuId)
        ? 'SKU sàn bị chọn hai lần'
        : d.variantId === null
          ? null
          : !v
            ? 'Biến thể không thuộc công ty'
            : v.archived
              ? 'Biến thể đã lưu trữ'
              : listed.has(v.id)
                ? 'Variant đã liên kết listing khác của gian hàng này'
                : seenVariants.has(v.id)
                  ? 'Biến thể đã chọn cho SKU sàn khác'
                  : null;
    seenSkus.add(d.externalSkuId);
    if (error) errors[`decisions.${i}`] = error;
    else if (s && v) {
      seenVariants.add(v.id);
      picked.push({ ...s, variantId: v.id });
    }
  });
  if (toCreate.length && !input.createGroupId) errors.createGroupId = 'Chọn nhóm hàng cho sản phẩm tạo từ sàn';
  return picked;
}

/** Công ty chưa có gian hàng nào xong thiết lập (có mốc, không chờ kiểm kê) thì gian hàng này là đầu tiên (#198 A1). */
async function companySetupState(actor: Actor, shopId: string) {
  const state = await withCompany(actor.companyId, () => setupStateOfCompany(shopId));
  return { firstShopOfCompany: !state.hasSetUpShop, awaitingStocktake: state.awaitingStocktake };
}

const awaitingError = (number: string) => `Công ty đang chờ phiếu kiểm kho đầu kỳ ${number} hoàn thành`;

export async function setupPreview(port: ProductPort, actor: Actor, shopId: string) {
  const { offered, nameMatchSkipped } = await suggestions(port, actor, shopId);
  const items = offered.map(({ externalProductId: _p, sellerSku: _s, productName: _n, variantLabel: _l, price: _c, ...s }) => s);
  const { firstShopOfCompany } = await companySetupState(actor, shopId);
  const unmatchedRemote = items.filter((s) => s.match === 'none').length;
  return { suggestions: items, unmatchedRemote, nameMatchSkipped, proposedCutoffAt: new Date(), firstShopOfCompany };
}

export async function finishSetup(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: SetupChoice & {
    openingStock: 'push' | 'stocktake';
    returnWindowDays?: number | null | undefined;
  },
): Promise<{ shop: Shop; matched: number; created: number; stocktakeNumber: string | null }> {
  const wantsCreate = !!input.decisions?.some((d) => d.create);
  // Tạo sản phẩm là việc của catalog (#500): thiếu quyền thì 403, không vòng qua quyền catalog.
  if (wantsCreate && !canManageProducts(actor)) throw new AppError(403, 'forbidden', 'Bạn không có quyền tạo sản phẩm');
  // `decisions` không dùng tiêu đề hay gợi ý theo tên: không đọc nhãn biến thể (đỡ tới 50 lời gọi sàn, #282 review chéo I-2),
  // trừ khi có dòng tạo SKU kho: nhãn là giá trị trục của biến thể mới (#500).
  const candidates = await suggestions(port, actor, shopId, !input.decisions || wantsCreate);
  const { returnWindow } = capabilitiesOf((await withCompany(actor.companyId, () => ownShop(shopId))).platform);
  const { firstShopOfCompany, awaitingStocktake } = await companySetupState(actor, shopId);
  const errors: Record<string, string> = {};
  if (awaitingStocktake) errors.openingStock = awaitingError(awaitingStocktake);
  else if (firstShopOfCompany && input.openingStock === 'push') errors.openingStock = 'Gian hàng đầu tiên của công ty phải kiểm kê đầu kỳ';
  const toCreate: { index: number; suggestion: Suggestion }[] = [];
  const picked = pickListings(candidates, input, errors, toCreate);
  if (toCreate.length && !port.createFromPlatform) errors.decisions = 'Chưa tạo được SKU kho từ SKU sàn';
  const returnWindowInvalid = returnWindowError(returnWindow, input.returnWindowDays);
  if (returnWindowInvalid) errors.returnWindowDays = returnWindowInvalid;
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });

  const stocktake = await withCompany(actor.companyId, async () => {
    // Kiểm lại dưới khoá của công ty: thiết lập của gian hàng khác (vd vừa vào chế độ chờ kiểm kê) chạy song song thì
    // lần sau thấy kết quả của lần trước (A12, #198 diff-review N2). Index một phần vẫn chặn hai phiếu.
    await lockCompanySetup(actor.companyId);
    const now = await setupStateOfCompany(shopId);
    const raced = now.awaitingStocktake
      ? awaitingError(now.awaitingStocktake)
      : !now.hasSetUpShop && input.openingStock === 'push'
        ? 'Gian hàng đầu tiên của công ty phải kiểm kê đầu kỳ'
        : null;
    if (raced) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { openingStock: raced } });
    const { shop } = await shopSession(shopId);
    const { to } = assertTransition(shopMachine, shop.status, 'finish_setup', { actor });
    if (toCreate.length) picked.push(...(await createFromRemote(port, actor, shop, input.createGroupId!, toCreate)));
    const matched: string[] = [];
    for (const p of picked) {
      const row = await insertListing({
        companyId: actor.companyId,
        shopId: shop.id,
        variantId: p.variantId,
        externalSkuId: p.externalSkuId,
        externalProductId: p.externalProductId,
        sellerSku: p.sellerSku,
        status: 'live',
        platformStock: p.platformStock,
        contentSource: 'platform',
        // Mốc tên trên sàn (#396): tên vừa đọc, cùng lượt đã lưu vào bản sao; tên tiếng Anh lấy ở lần ghi bản sao sau.
        remoteTitleAtMatch: p.title,
      });
      await recordTransition({ entityType: 'listings', entityId: row.id, from: null, to: 'live', action: 'match', actorId: actor.accountId });
      matched.push(row.id);
    }
    // Bản tạm của cổng (chưa có #245) ném 501: cả giao dịch rollback, gian hàng vẫn `connecting` (Documents/21 §18.7.9).
    const doc =
      input.openingStock === 'stocktake' ? await stocktakePort().createOpeningStocktake(shop.id, { actorId: actor.accountId }) : null;
    const updated = await updateShop(
      shop.id,
      { version: shop.version, status: shop.status },
      {
        status: to,
        orderCutoffAt: new Date(),
        openingStocktakeId: doc?.documentId ?? null,
        openingStocktakeNumber: doc?.number ?? null,
        openingStockMode: input.openingStock,
        openOrdersPulledAt: null,
        stockPushedAt: null,
        // Mốc lấy đơn mới: lượt lấy đơn đầu tiên đặt lại (#223).
        ordersPulledOkAt: null,
        // Sàn `platform_status` luôn null; sàn `days` đã kiểm có số ở trên (#362).
        returnWindowDays: returnWindow === 'days' ? (input.returnWindowDays ?? null) : null,
      },
    );
    if (!updated) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
    await recordShopTransition({ shopId: shop.id, from: shop.status, to, action: 'finish_setup', actorId: actor.accountId });
    // Lượt kéo đơn còn mở đi chung giao dịch: thiết lập rollback thì không có việc (#198 AC-12).
    await sendOpenOrderPull(actor.companyId, shop.id);
    // Spec theo category trên sàn của SKU vừa ghép (#400 lát 12), cùng giao dịch.
    await sendSpecFromMatch(actor.companyId, shop.id, matched);
    return doc;
  }).catch((err: unknown) => {
    // Hai gian hàng cùng lập phiếu đầu kỳ một lúc: index một phần chặn phiếu thứ hai (#198 A12).
    if (pgError(err).constraint === 'shops_one_opening_stocktake_uq') {
      throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
        errors: { openingStock: 'Công ty đang chờ một phiếu kiểm kho đầu kỳ khác hoàn thành' },
      });
    }
    throw err;
  });
  // Gian hàng đã `active`: đặt lịch việc nền trước khi gọi sàn, đồng bộ lỗi thì lịch vẫn chạy lại (#102).
  await startShopJobs(actor.companyId, shopId);
  // Listing vừa ghép chờ đồng bộ: đẩy giá chuẩn ngay; tồn chỉ đẩy sau lượt kéo đơn còn mở và khi không chờ kiểm kê (A10).
  await syncListings(port, actor.companyId, shopId);
  const shop = await withCompany(actor.companyId, async () => shopView((await shopSession(shopId)).shop));
  return { shop, matched: picked.length, created: toCreate.length, stocktakeNumber: stocktake?.number ?? null };
}

/**
 * Tạo SKU kho cho các dòng `create` (#500, §18.7.5) trong giao dịch hoàn tất, gom theo sản phẩm trên sàn (một sản phẩm cha).
 * Catalog kiểm lại dưới khoá SKU của công ty; lỗi (SKU vừa bị tạo nơi khác, nhóm sai) thì 422 theo dòng, rollback cả thiết lập.
 */
async function createFromRemote(
  port: ProductPort,
  actor: Actor,
  shop: { id: string; shopName: string },
  groupId: string,
  rows: readonly { index: number; suggestion: Suggestion }[],
): Promise<Picked[]> {
  const byProduct = new Map<string, { index: number; suggestion: Suggestion }[]>();
  for (const row of rows) byProduct.set(row.suggestion.externalProductId, [...(byProduct.get(row.suggestion.externalProductId) ?? []), row]);
  // Giá chuẩn = giá niêm yết trên sàn; giá muốn bán tính ngược theo phí của gian hàng để bộ lọc giá ra đúng giá đó (không
  // sinh giá chờ xác nhận). Gian hàng chưa có phí thì giá muốn bán để trống (Thành chốt 20/11/2026).
  const config = await shopPriceConfig(shop.id);
  const pricesOf = (raw: string | null) => {
    const standardPrice = raw !== null && /^\d+(\.\d+)?$/.test(raw) ? new Decimal(raw).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed() : null;
    const targetNetPrice = standardPrice && config.fee ? targetForPrice(standardPrice, config.fee, config.taxPct) : null;
    return { standardPrice, targetNetPrice };
  };
  const products: PlatformProductInput[] = [...byProduct.values()].map((group) => ({
    name: group[0]!.suggestion.productName,
    variants: group.map(({ suggestion: s }) => ({ key: s.externalSkuId, sku: s.sellerSku, label: s.variantLabel, ...pricesOf(s.price) })),
  }));
  const result = await port.createFromPlatform!({ companyId: actor.companyId, accountId: actor.accountId }, groupId, products, {
    shopId: shop.id,
    shopName: shop.shopName,
  });
  if (!result.ok) {
    const errors: Record<string, string> = {};
    if (result.groupError) errors.createGroupId = result.groupError;
    for (const row of rows) {
      const message = result.errors.get(row.suggestion.externalSkuId);
      if (message) errors[`decisions.${row.index}`] = message;
    }
    throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
  }
  return rows.map(({ suggestion: s }) => ({ ...s, variantId: result.variantIds.get(s.externalSkuId)! }));
}
