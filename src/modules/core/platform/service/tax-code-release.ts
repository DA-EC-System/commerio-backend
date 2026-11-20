// Quản trị nền tảng gỡ mã số thuế của một công ty (#459, Documents/21 mục 2.1): công ty giữ mã không phải của mình thì
// doanh nghiệp đúng đăng ký được. Chạy ngoài `withCompany` (role chủ bảng) như `setCompanyLock`.
import { z } from 'zod';
import { env } from '../../../../shared/config/env.ts';
import { inTransaction } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { escapeHtml, MailError, sendMail } from '../../../../shared/mail/index.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { recordAudit } from '../../audit/index.ts';
import { clearTaxCode, findCompanyAdmin } from '../repository/admin.ts';
import { toCompany } from './admin.ts';
import { defineQueue, sendJob } from './jobs/queues.ts';

export const taxCodeReleasedMailQueue = defineQueue(
  'platform.tax_code_released_mail',
  z.object({ companyId: z.uuid(), taxCode: z.string(), reason: z.string() }),
  { attempts: 5, retryDelaySeconds: 60 },
);

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy công ty');

/** 404 → 409 `invalid_transition` (đã không có mã) → 409 `version_conflict` kèm `current`; trả công ty với `taxCode: null`. */
export function releaseTaxCode(actorId: string, companyId: string, input: { reason: string; version: number }) {
  if (!isUuid(companyId)) throw notFound();
  return inTransaction(async () => {
    const current = await findCompanyAdmin(companyId);
    if (!current) throw notFound();
    const taxCode = current.tax_code;
    if (taxCode === null) {
      throw new AppError(409, 'invalid_transition', `${current.name} hiện không có mã số thuế để gỡ`, {
        current: toCompany(current),
      });
    }
    if (!(await clearTaxCode(companyId, input.version))) {
      throw new AppError(409, 'version_conflict', `${current.name} vừa được đổi ở một phiên khác`, {
        current: toCompany(current),
      });
    }
    await recordAudit({
      companyId: null,
      actorId,
      action: 'update',
      operation: 'release_tax_code',
      entityType: 'core.companies',
      entityId: companyId,
      label: current.name,
      before: { taxCode },
      after: { taxCode: null, reason: input.reason },
    });
    await sendJob(taxCodeReleasedMailQueue, { companyId, taxCode, reason: input.reason });
    return toCompany((await findCompanyAdmin(companyId))!);
  });
}

/** Tên, lý do do người gõ: gộp về một dòng để không chèn được dòng giả vào thư. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function renderTaxCodeReleasedMail(input: {
  companyName: string;
  taxCode: string;
  reason: string;
  profileUrl: string | null;
}): { subject: string; text: string; html: string } {
  const company = oneLine(input.companyName);
  const reason = oneLine(input.reason);
  const where = input.profileUrl ? `Nhập lại tại: ${input.profileUrl}` : 'Nhập lại ở trang Hồ sơ công ty trên Commerio.';
  return {
    subject: `Mã số thuế của ${company} trên Commerio đã bị gỡ`,
    text: [
      'Chào bạn,',
      '',
      `Quản trị Commerio đã gỡ mã số thuế ${input.taxCode} khỏi công ty ${company}.`,
      `Lý do: ${reason}`,
      '',
      `Nếu công ty có mã số thuế đúng, CEO nhập lại ở hồ sơ công ty. ${where}`,
      '',
      'Commerio',
    ].join('\n'),
    html:
      `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px">`
      + `<h2 style="font-size:18px">Mã số thuế của ${escapeHtml(company)} đã bị gỡ</h2>`
      + `<p>Quản trị Commerio đã gỡ mã số thuế <strong>${escapeHtml(input.taxCode)}</strong> khỏi công ty `
      + `<strong>${escapeHtml(company)}</strong>.</p><p>Lý do: ${escapeHtml(reason)}</p>`
      + `<p>Nếu công ty có mã số thuế đúng, CEO nhập lại ở `
      + (input.profileUrl ? `<a href="${escapeHtml(input.profileUrl)}">hồ sơ công ty</a>` : 'trang Hồ sơ công ty')
      + `.</p><p style="color:#666">Commerio</p></body></html>`,
  };
}

/** Việc nền gửi thư báo CEO (người đăng ký công ty). SMTP lỗi tạm thì ném để thử lại; vĩnh viễn thì ghi log. */
export async function handleTaxCodeReleasedMail(data: { companyId: string; taxCode: string; reason: string }) {
  const company = await findCompanyAdmin(data.companyId);
  if (!company?.ceo_email) {
    logger.warn({ companyId: data.companyId }, 'bỏ thư gỡ mã số thuế: không thấy CEO');
    return;
  }
  const profileUrl = env.PUBLIC_WEB_URL ? new URL(`/c/${data.companyId}/admin/company`, env.PUBLIC_WEB_URL).toString() : null;
  try {
    await sendMail(
      { to: company.ceo_email, ...renderTaxCodeReleasedMail({ companyName: company.name, taxCode: data.taxCode, reason: data.reason, profileUrl }) },
      'tax_code_released',
    );
    logger.info({ companyId: data.companyId }, 'đã gửi thư gỡ mã số thuế');
  } catch (err) {
    if (err instanceof MailError && err.kind === 'permanent') {
      logger.error({ companyId: data.companyId, smtpCode: err.smtpCode }, 'gửi thư gỡ mã số thuế lỗi vĩnh viễn');
      return;
    }
    throw err;
  }
}
