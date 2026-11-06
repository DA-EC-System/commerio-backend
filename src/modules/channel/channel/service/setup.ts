// Thiết lập lần đầu (#104, #198; Documents/21 §18.2, §18.6.2): ghép listing có sẵn trên sàn, gian hàng
// `connecting → active`. Mốc kéo đơn do BE đặt bằng lúc thiết lập (không nhận từ người dùng, §18.7.6). Gian hàng đầu tiên
// của công ty buộc kiểm kê đầu kỳ (`stocktake`): lập phiếu qua cổng inventory, gian hàng ở chế độ chờ kiểm kê tới khi
// phiếu ghi sổ. Gọi sàn ngoài giao dịch.
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { returnWindowError, shopMachine } from '../domain/shop.ts';
import { insertListing, listListingRows, nameSimilarities } from '../repository/listings.ts';
import { lockCompanySetup, setupStateOfCompany, updateShop } from '../repository/shops.ts';
import { stocktakePort } from './stocktake-port.ts';
import { syncListings } from './listing-sync.ts';
import { capabilitiesOf } from './marketplaces/index.ts';
import { sendOpenOrderPull, startShopJobs } from './shop-jobs.ts';
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
}

type Suggestion = SetupSuggestion & { externalProductId: string; sellerSku: string };

/** Ngưỡng `similarity()` của pg_trgm để nhận gợi ý theo tên (Documents/21 §18.7.5). */
const NAME_MATCH_MIN = 0.4;
// Ghép tên so mọi cặp (SKU sàn × biến thể), không dùng được index. Trần số cặp và thời gian để một gian hàng lớn không
// giữ CPU của DB: đo 06/11/2026 trên PG 17 cục bộ, 1e6 cặp ≈ 3,2 giây, 9e6 cặp ≈ 30 giây (#198 worklog).
const NAME_PAIRS_MAX = 1_000_000;
const NAME_MATCH_TIMEOUT_MS = 10_000;

const variantName = (v: ListingVariant) => [v.productName, v.attributesLabel].filter(Boolean).join(' ');

/**
 * Gợi ý ghép (#198, Documents/21 §18.7.5): mọi SKU người bán trên sàn (bỏ sản phẩm đã xoá), mỗi SKU một dòng. Ghép theo
 * SKU trước, phần còn lại theo tên sản phẩm kèm nhãn biến thể bằng `similarity()` của pg_trgm, nhận từ 0.4, tham lam theo
 * điểm giảm dần; mỗi biến thể gợi ý một lần. Số cặp vượt `NAME_PAIRS_MAX` hay câu quá giờ thì bỏ ghép theo tên
 * (`nameMatchSkipped`). Biến thể lưu trữ hay đã có listing ở gian hàng này không được gợi ý. Sàn
 * chưa có `listSkus` thì chỉ đọc được SKU trùng SKU Commerio (`getSkus`).
 */
async function suggestions(port: ProductPort, actor: Actor, shopId: string) {
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
  const fetched = adapter.listSkus
    ? await onMarketplace(() => adapter.listSkus!(accessToken))
    : open.length
      ? await onMarketplace(() => adapter.getSkus(accessToken, open.map((v) => v.sku)))
      : [];
  const remote = fetched.filter((r) => r.state !== 'deleted');

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
  // không tra được biến thể, không gợi ý.
  const titleCount = new Map<string, number>();
  for (const r of remote) titleCount.set(r.title.trim().toLowerCase(), (titleCount.get(r.title.trim().toLowerCase()) ?? 0) + 1);
  const restRemote = remote.flatMap((r, i) =>
    chosen.has(i) || !r.sellerSku || titleCount.get(r.title.trim().toLowerCase())! > 1 ? [] : [i],
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
          ),
        )
      : [];
  if (pairs === null) nameMatchSkipped = true;
  else {
    // Ngược chiều: sản phẩm của biến thể giống nhất có từ hai biến thể qua ngưỡng thì tên sàn không chỉ ra được màu, cỡ
    // nào; không gợi ý, để người dùng chọn (#198 diff-review vòng 2). `pairs` xếp điểm giảm dần nên cặp đầu của mỗi SKU là
    // cặp giống nhất.
    const bestProduct = new Map<number, string>();
    const perProduct = new Map<string, number>();
    for (const p of pairs) {
      const product = restVariants[p.right]!.productId;
      if (!bestProduct.has(p.left)) bestProduct.set(p.left, product);
      perProduct.set(`${p.left} ${product}`, (perProduct.get(`${p.left} ${product}`) ?? 0) + 1);
    }
    const ambiguous = (left: number) => perProduct.get(`${left} ${bestProduct.get(left)}`)! > 1;
    for (const p of pairs) {
      const i = restRemote[p.left]!;
      const v = restVariants[p.right]!;
      if (chosen.has(i) || taken.has(v.id) || ambiguous(p.left)) continue;
      chosen.set(i, { variant: v, score: p.score });
      taken.add(v.id);
    }
  }
  const available = taken.size ? await inCompany(() => port.availableOf([...taken])) : new Map<string, number>();
  const offered: Suggestion[] = remote.map((r, i) => {
    const c = chosen.get(i);
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
    };
  });
  return { offered, variants, listed, nameMatchSkipped };
}

interface Picked {
  externalSkuId: string;
  externalProductId: string;
  sellerSku: string;
  variantId: string;
  platformStock: number;
}

interface SetupChoice {
  externalSkuIds?: string[] | undefined;
  decisions?: { externalSkuId: string; variantId: string | null }[] | undefined;
}

/**
 * SKU sàn sẽ thành listing. `decisions` (§18.7.5): biến thể người dùng chọn, `null` bỏ qua; lỗi theo dòng ghi vào
 * `errors["decisions.<i>"]`. `externalSkuIds` (cũ, giữ tới hết đợt 2): nhận biến thể gợi ý. Gửi cả hai là lỗi.
 */
function pickListings(
  { offered, variants, listed }: Awaited<ReturnType<typeof suggestions>>,
  input: SetupChoice,
  errors: Record<string, string>,
): Picked[] {
  if (input.decisions && input.externalSkuIds) {
    errors.decisions = 'Chỉ gửi một trong `decisions` hoặc `externalSkuIds`';
    return [];
  }
  if (!input.decisions) {
    const ids = new Set(input.externalSkuIds ?? []);
    const picked = offered.flatMap((s) => (s.variantId && ids.has(s.externalSkuId) ? [{ ...s, variantId: s.variantId }] : []));
    if (picked.length !== ids.size) errors.externalSkuIds = 'Có SKU sàn không còn để ghép';
    return picked;
  }
  const byExternal = new Map(offered.map((s) => [s.externalSkuId, s]));
  const byId = new Map(variants.map((v) => [v.id, v]));
  const seenSkus = new Set<string>();
  const seenVariants = new Set<string>();
  const picked: Picked[] = [];
  input.decisions.forEach((d, i) => {
    const s = byExternal.get(d.externalSkuId);
    const v = d.variantId === null ? undefined : byId.get(d.variantId);
    const error = !s
      ? 'SKU sàn không có trong gợi ý'
      : d.variantId !== null && !s.sellerSku
        ? 'SKU sàn chưa có SKU người bán, đặt trên sàn trước rồi ghép'
        : seenSkus.has(d.externalSkuId)
        ? 'SKU sàn bị chọn hai lần'
        : d.variantId === null
          ? null
          : !v
            ? 'Biến thể không thuộc công ty'
            : v.archived
              ? 'Biến thể đã lưu trữ'
              : listed.has(v.id)
                ? 'Biến thể đã ghép listing khác của gian hàng này'
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
  return picked;
}

/** Công ty chưa có gian hàng nào xong thiết lập (có mốc, không chờ kiểm kê) thì gian hàng này là đầu tiên (#198 A1). */
async function companySetupState(actor: Actor, shopId: string) {
  const state = await withCompany(actor.companyId, () => setupStateOfCompany(shopId));
  return { firstShopOfCompany: !state.hasSetUpShop, awaitingStocktake: state.awaitingStocktake };
}

const awaitingError = (number: string) => `Công ty đang chờ phiếu kiểm kê đầu kỳ ${number} ghi sổ`;

export async function setupPreview(port: ProductPort, actor: Actor, shopId: string) {
  const { offered, nameMatchSkipped } = await suggestions(port, actor, shopId);
  const items = offered.map(({ externalProductId: _p, sellerSku: _s, ...s }) => s);
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
): Promise<{ shop: Shop; matched: number; stocktakeNumber: string | null }> {
  const candidates = await suggestions(port, actor, shopId);
  const offered = candidates.offered;
  const { returnWindow } = capabilitiesOf((await withCompany(actor.companyId, () => ownShop(shopId))).platform);
  const { firstShopOfCompany, awaitingStocktake } = await companySetupState(actor, shopId);
  const errors: Record<string, string> = {};
  if (awaitingStocktake) errors.openingStock = awaitingError(awaitingStocktake);
  else if (firstShopOfCompany && input.openingStock === 'push') errors.openingStock = 'Gian hàng đầu tiên của công ty phải kiểm kê đầu kỳ';
  const picked = pickListings(candidates, input, errors);
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
      });
      await recordTransition({ entityType: 'listings', entityId: row.id, from: null, to: 'live', action: 'match', actorId: actor.accountId });
    }
    // Sàn `platform_status` luôn null; sàn `days` chỉ ghi khi có gửi số, không gửi thì giữ giá trị đang có (A3).
    const returnWindowDays =
      returnWindow !== 'days' ? { returnWindowDays: null } : typeof input.returnWindowDays === 'number' ? { returnWindowDays: input.returnWindowDays } : {};
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
        unmatchedSkuCount: offered.length - picked.length,
        openOrdersPulledAt: null,
        stockPushedAt: null,
        ...returnWindowDays,
      },
    );
    if (!updated) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
    await recordTransition({ entityType: 'shops', entityId: shop.id, from: shop.status, to, action: 'finish_setup', actorId: actor.accountId });
    // Lượt kéo đơn còn mở đi chung giao dịch: thiết lập rollback thì không có việc (#198 AC-12).
    await sendOpenOrderPull(actor.companyId, shop.id);
    return doc;
  }).catch((err: unknown) => {
    // Hai gian hàng cùng lập phiếu đầu kỳ một lúc: index một phần chặn phiếu thứ hai (#198 A12).
    if (pgError(err).constraint === 'shops_one_opening_stocktake_uq') {
      throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
        errors: { openingStock: 'Công ty đang chờ một phiếu kiểm kê đầu kỳ khác ghi sổ' },
      });
    }
    throw err;
  });
  // Gian hàng đã `active`: đặt lịch việc nền trước khi gọi sàn, đồng bộ lỗi thì lịch vẫn chạy lại (#102).
  await startShopJobs(actor.companyId, shopId);
  // Listing vừa ghép chờ đồng bộ: đẩy giá chuẩn ngay; tồn chỉ đẩy sau lượt kéo đơn còn mở và khi không chờ kiểm kê (A10).
  await syncListings(port, actor.companyId, shopId);
  const shop = await withCompany(actor.companyId, async () => shopView((await shopSession(shopId)).shop));
  return { shop, matched: picked.length, stocktakeNumber: stocktake?.number ?? null };
}
