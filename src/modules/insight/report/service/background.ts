// Việc nền của report trong worker (plan #29 A5): consumer nghe chứng từ tài chính, vòng quét 15 phút cho 60 ngày gần
// nhất. Sự kiện chỉ là tín hiệu "ngày D đã đổi"; số luôn tính lại từ module nguồn (Documents/21 D7, D18).
import { registerConsumer } from '../../../core/index.ts';
import { logger } from '../../../../shared/logger.ts';
import { addDays, dayOfSourceEvent, type SourceEvent, vnDay } from '../domain/days.ts';
import { findCompaniesWithSummary } from '../repository/summary.ts';
import { recompute } from './recompute.ts';

const REPORT_CONSUMER = 'report-daily-summary';
const SWEEP_INTERVAL_MS = 15 * 60_000;
const SWEEP_DAYS = 60;

/**
 * Tính lại ngày của chứng từ trong sự kiện. Chạy trong `withCompany` của sự kiện (consumer `shared`), `recompute` dùng
 * lại giao dịch đó. Giao lặp, sai thứ tự đều cho cùng kết quả.
 */
export async function onSourceEvent(event: SourceEvent & { companyId: string | null }): Promise<void> {
  const day = dayOfSourceEvent(event);
  await recompute(event.companyId!, day, day);
}

/** Tính lại [today − 60, today] cho từng công ty; lỗi của một công ty chỉ ghi log. */
export async function sweep(companyIds: readonly string[], today: string): Promise<void> {
  for (const companyId of companyIds) {
    try {
      await recompute(companyId, addDays(today, -SWEEP_DAYS), today);
    } catch (err) {
      logger.error({ err, companyId }, 'quét lại báo cáo lỗi, thử lại lượt sau');
    }
  }
}

/** Đăng ký consumer (một khối đồng bộ) và vòng quét không chồng lượt; trả hàm dừng chờ lượt đang chạy. */
export async function startReportBackground(): Promise<() => Promise<void>> {
  const options = { consumer: REPORT_CONSUMER };
  registerConsumer('finance.invoice_posted', onSourceEvent, options);
  registerConsumer('finance.receipt_posted', onSourceEvent, options);
  registerConsumer('finance.voucher_posted', onSourceEvent, options);

  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= findCompaniesWithSummary()
      .then((companies) => sweep(companies, vnDay(new Date())))
      .catch((err: unknown) => logger.error({ err }, 'quét lại báo cáo lỗi'))
      .finally(() => {
        running = undefined;
      });
  }, SWEEP_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
