// Mở kiện đơn sàn áp lại ghép SKU hiện hành (spec 237 §5.6 "Mở kiện áp lại ghép", D20, D21). `openPackage`
// (`service/packing.ts`) gọi hai lần: bước kiểm (dòng lệch không giữ lại theo ghép cũ) và bước ghi (áp, sau các việc mở
// hiện có). Luật trên kiện, tồn dùng chung với đường ghép (`applyRemapToPackage`).
import { logger } from '../../../../shared/logger.ts';
import { lineSkuOf, type MappedSku, sameSku } from '../domain/remap.ts';
import { replacementPairs } from '../domain/resplit.ts';
import { lockPackage, type PackageLineRow, readOrderPackages } from '../repository/packages.ts';
import { lineSellerSkusOf } from '../repository/packing.ts';
import { type FulfillmentContext, orderLineWritersOf } from './packages.ts';
import { applyRemapStock, applyRemapToPackage } from './remap.ts';

/**
 * Dòng chờ thay của kiện (spec #238 D9; spec 237 D26: giữ ghép cũ tới khi hết chờ): dòng mà cùng dòng đơn còn dòng chờ
 * bỏ ở kiện khác đang đóng. Đọc các kiện của đơn không khoá; chỉ dùng để bỏ dòng đó khỏi việc áp ghép.
 */
export async function awaitingLinesOf(pkg: { id: string; orderId: string }): Promise<Set<string>> {
  return new Set(replacementPairs(await readOrderPackages(pkg.orderId), pkg.id).map((p) => p.newLineId));
}

/**
 * Dòng sống của kiện lệch ghép hiện hành: dòng đơn → ghép mới. Bỏ dòng chờ bỏ (rời kiện khi mở), dòng mà ghép hiện hành
 * vắng hay `unmapped` (listing đã gỡ, chỉ chờ duyệt: không gỡ ghép, Review Focus 2), dòng đã đúng ghép, dòng chờ thay
 * (`awaiting`, D26). Kiện không gian hàng (đơn tay) hay chưa nối `ctx.skuMappingOf` thì rỗng. Đọc `external_sku` một
 * câu, ghép một lời gọi.
 */
export async function openRemapChanges(
  ctx: FulfillmentContext,
  pkg: { id: string; shopId: string | null; lines: readonly PackageLineRow[] },
  awaiting: ReadonlySet<string>,
): Promise<Map<string, MappedSku>> {
  const changes = new Map<string, MappedSku>();
  const live = pkg.lines.filter((l) => l.pendingDropQty === 0 && !awaiting.has(l.id));
  if (!pkg.shopId || !ctx.skuMappingOf || !live.length) return changes;
  const skus = await lineSellerSkusOf(pkg.id);
  const sellerSkus = [...new Set(live.flatMap((l) => skus.get(l.id) ?? []))];
  if (!sellerSkus.length) return changes;
  const current = await ctx.skuMappingOf(pkg.shopId, sellerSkus);
  for (const l of live) {
    const sellerSku = skus.get(l.id);
    const to = sellerSku ? current.get(sellerSku) : undefined;
    if (!to || to.kind === 'unmapped' || sameSku(lineSkuOf(l), to)) continue;
    changes.set(l.orderLineId, to);
  }
  return changes;
}

/**
 * Áp ghép lên kiện vừa mở (đã ở `reserved`, bên gọi giữ khoá dòng đơn, khoá phân hàng, khoá kiện): luật đổi ghép trên
 * kiện (bảng 1, 2 dòng `reserved`, bảng 3), ghi dòng đơn `applied` qua sales; rồi dòng sống có biến thể còn chưa giữ đủ
 * (dòng bước kiểm đã bỏ qua vì lệch) thì giữ như "giữ dòng mới", không được thì kiện về `backordered` (D5), mở vẫn thành
 * công. Trả số dòng đổi ghép.
 */
export async function applyOpenRemap(
  ctx: FulfillmentContext,
  packageId: string,
  changes: ReadonlyMap<string, MappedSku>,
  opts: { actorId: string; holdStock: boolean; awaitingLineIds: ReadonlySet<string> },
): Promise<{ changed: number }> {
  const pkg = await lockPackage(packageId);
  if (!pkg) throw new Error(`Không thấy kiện ${packageId} vừa mở`);
  const remapOpts = { actorId: opts.actorId, holdStock: opts.holdStock, orderCutoffAt: null };
  let changed = 0;
  if (changes.size) {
    const skus = await lineSellerSkusOf(packageId);
    const touched = pkg.lines.filter((l) => changes.has(l.orderLineId));
    const sellerSkus = [...new Set(touched.flatMap((l) => skus.get(l.id) ?? []))].sort();
    const outcomes = await applyRemapToPackage(pkg, changes, {
      ...remapOpts,
      reason: `Mở kiện: áp ghép SKU ${sellerSkus.join(', ')}`,
      awaitingLineIds: opts.awaitingLineIds,
    });
    const rows = touched.flatMap((l) => (outcomes.get(l.id) === 'applied' ? [{ orderLineId: l.orderLineId, to: changes.get(l.orderLineId)! }] : []));
    await orderLineWritersOf(ctx).applyLineSkus(rows);
    changed = rows.length;
  }
  if (pkg.status === 'reserved') {
    const missing = pkg.lines.filter((l) => l.variantId !== null && l.pendingDropQty === 0 && l.reservedQty < l.quantity).map((l) => l.id);
    if (missing.length) {
      await applyRemapStock(pkg, opts.holdStock ? { kind: 'reserve_new', lineIds: missing, sealed: false } : { kind: 'reclaim' }, remapOpts);
    }
  }
  if (changed) logger.info({ packageId, changed }, 'mở kiện áp lại ghép SKU');
  return { changed };
}
