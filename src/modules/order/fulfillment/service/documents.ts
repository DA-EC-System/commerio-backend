import { PDFDocument } from 'pdf-lib';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findPackagesByIds } from '../repository/package-list.ts';
import { marketplacePackagesOf, type FulfillmentContext } from './packages.ts';

export const MAX_DOCUMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const SHOP_BATCH = 3;
const invalidPdf = () => new AppError(503, 'marketplace_unavailable', 'Sàn trả tệp vận đơn hỏng, thử lại sau');

export async function mergePdfs(files: readonly Uint8Array[]): Promise<Uint8Array> {
  try {
    const output = await PDFDocument.create();
    for (const file of files) {
      if (Buffer.from(file.subarray(0, 5)).toString('latin1') !== '%PDF-') throw invalidPdf();
      const source = await PDFDocument.load(file, { throwOnInvalidObject: true });
      for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page);
    }
    if (!output.getPageCount()) throw invalidPdf();
    return await output.save();
  } catch {
    // Lỗi parser có thể chứa nội dung vận đơn, chỉ giữ lỗi chung.
    throw invalidPdf();
  }
}

const vnTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function filenameOf(now: Date): string {
  const time = Object.fromEntries(vnTime.formatToParts(now).map(({ type, value }) => [type, value]));
  return `van-don-${time.year}${time.month}${time.day}-${time.hour}${time.minute}.pdf`;
}

export async function packageDocuments(ctx: FulfillmentContext, companyId: string, ids: readonly string[]) {
  const rows = await withCompany(companyId, () => findPackagesByIds(ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id));
  if (ordered.some((row) => !row)) throw new AppError(404, 'not_found', 'Không tìm thấy kiện');

  const shops = new Map<string, Set<string>>();
  const missing: string[] = [];
  for (const row of ordered) {
    const { code, shopId, platformPackageCode } = row!;
    if (!shopId || !platformPackageCode) {
      missing.push(code);
      continue;
    }
    if (!shops.has(shopId)) shops.set(shopId, new Set());
    shops.get(shopId)!.add(platformPackageCode);
  }
  if (missing.length) {
    throw new AppError(409, 'document_not_ready', `Kiện ${missing.join(', ')} chưa có mã kiện sàn`);
  }

  const targets = [...shops];
  const files: Uint8Array[] = [];
  const marketplace = marketplacePackagesOf(ctx);
  let bytes = 0;
  try {
    for (let offset = 0; offset < targets.length; offset += SHOP_BATCH) {
      const batch = await Promise.all(targets.slice(offset, offset + SHOP_BATCH).map(([shopId, codes]) =>
        marketplace.shippingDocuments(companyId, shopId, [...codes]),
      ));
      for (const file of batch.flat()) {
        bytes += file.byteLength;
        if (bytes > MAX_DOCUMENT_TOTAL_BYTES) {
          throw new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors: { ids: 'Chọn ít kiện hơn' } });
        }
        files.push(file);
      }
    }
    return { pdf: await mergePdfs(files), filename: filenameOf(new Date()) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'marketplace_unavailable') {
      logger.error({ packageIds: ids, platformCode: err.extensions?.platformCode }, 'không tải hoặc gộp được vận đơn');
    }
    throw err;
  }
}
