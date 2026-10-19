// Cấu hình khoá cổng (UC-PF-11; Documents/21 §12.3, §12.8, T4, T11, T12; plan #23 A2–A6).
import { randomBytes } from 'node:crypto';
import { env } from '../../../shared/config/env.ts';
import { withCompany } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { bankNameOf } from '../domain/banks.ts';
import { type Credentials, GATEWAYS, type Gateway, maskCredentials } from '../domain/gateways.ts';
import {
  findGatewayConfig,
  findGatewayConfigs,
  type GatewayConfigRow,
  insertGatewayConfig,
  updateGatewayConfigIfVersion,
} from '../repository/gateway-configs.ts';
import { decryptCredentials, encryptCredentials, isCredentialsUnreadable } from './credentials-cipher.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { logger } from '../../../shared/logger.ts';
import { type UserRef, userRef } from './user-ref.ts';

const ENTITY = 'payment.gateway_configs';

export interface Caller {
  companyId: string;
  accountId: string;
}

export interface GatewayConfigView {
  gateway: Gateway;
  configured: boolean;
  version: number;
  updatedAt: string | null;
  updatedBy: UserRef | null;
  credentials: Record<string, { last4: string }> | null;
  display: { bankBin: string; bankName: string; accountName: string } | null;
  webhookUrl: string | null;
}

const aadOf = (companyId: string, gateway: Gateway) => `${companyId}:${gateway}`;

/** Khoá đã giải mã của một cổng trong công ty đang mở giao dịch; `undefined` khi chưa cấu hình. */
export async function loadGatewayCredentials(gateway: Gateway): Promise<Credentials | undefined> {
  const row = await findGatewayConfig(gateway);
  return row?.credentialsEnc ? decryptCredentials(row.credentialsEnc, aadOf(row.companyId, gateway)) : undefined;
}

/** `<PUBLIC_API_URL>/api/v1/payment/webhooks/<path>`; chưa đặt `PUBLIC_API_URL` thì `null`. */
const webhookUrl = (path: string) =>
  env.PUBLIC_API_URL ? `${env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1/payment/webhooks/${path}` : null;

const webhookUrlOf = (receiverKey: string | null) => (receiverKey ? webhookUrl(`sepay/${receiverKey}`) : null);

/** VNPay khai IPN theo merchant, không theo request (#27 A13): một URL chung, mã thanh toán toàn hệ thống tìm ra công ty. */
const vnpayIpnUrl = () => webhookUrl('vnpay');

type AccountName = (id: string) => Promise<UserRef | null>;

async function toView(
  gateway: Gateway,
  row: GatewayConfigRow | undefined,
  nameOf: AccountName = userRef,
): Promise<GatewayConfigView> {
  if (!row?.credentialsEnc) {
    return {
      gateway,
      configured: false,
      version: 0,
      updatedAt: null,
      updatedBy: null,
      credentials: null,
      display: null,
      webhookUrl: null,
    };
  }
  let credentials: Credentials | undefined;
  try {
    credentials = decryptCredentials(row.credentialsEnc, aadOf(row.companyId, gateway));
  } catch (err) {
    if (!isCredentialsUnreadable(err)) throw err;
    // Khoá chủ đổi hoặc bản mã hỏng: vẫn hiện cổng đã cấu hình để Admin lưu lại khoá theo `version` (#63 B6).
    logger.warn({ companyId: row.companyId, gateway }, 'khoá cổng đã lưu không giải mã được');
  }
  return {
    gateway,
    configured: true,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ? await nameOf(row.updatedBy) : null,
    credentials: credentials ? maskCredentials(credentials) : null,
    display:
      gateway === 'vietqr' && credentials
        ? {
            bankBin: credentials.bankBin!,
            bankName: bankNameOf(credentials.bankBin!),
            accountName: credentials.accountName!,
          }
        : null,
    webhookUrl: gateway === 'vietqr' ? webhookUrlOf(row.webhookReceiverKey) : gateway === 'vnpay' ? vnpayIpnUrl() : null,
  };
}

/** Đủ 4 cổng theo thứ tự `GATEWAYS`, khoá đã che (người có `payment.gateway.manage`). */
export async function listGatewayConfigs(companyId: string): Promise<GatewayConfigView[]> {
  return withCompany(companyId, async () => {
    const byGateway = new Map((await findGatewayConfigs()).map((r) => [r.gateway, r]));
    // Bốn cổng thường do cùng một người lưu: tra tên mỗi người một lần.
    const names = new Map<string, ReturnType<AccountName>>();
    const nameOf: AccountName = (id) => names.get(id) ?? names.set(id, userRef(id)).get(id)!;
    const views: GatewayConfigView[] = [];
    for (const gateway of GATEWAYS) views.push(await toView(gateway, byGateway.get(gateway), nameOf));
    return views;
  });
}

/** Đủ 4 cổng, chỉ tên cổng và cờ đã cấu hình (người chỉ có `payment.link.create`, để chọn cổng khi tạo mã). */
export async function listGatewaySummaries(companyId: string): Promise<{ gateway: Gateway; configured: boolean }[]> {
  // Cùng luật "đã cấu hình" với `toView`: có bản mã khoá.
  const rows = await withCompany(companyId, findGatewayConfigs);
  const configured = new Set(rows.filter((r) => r.credentialsEnc).map((r) => r.gateway));
  return GATEWAYS.map((gateway) => ({ gateway, configured: configured.has(gateway) }));
}

const snapshot = (gateway: Gateway, version: number) => ({ gateway, configured: true, version });


/** 409 kèm bản hiện tại đã che. Trong `withCompany` cùng công ty thì đọc chung giao dịch đang mở. */
async function conflict(companyId: string, gateway: Gateway): Promise<AppError> {
  const current = await withCompany(companyId, async () => toView(gateway, await findGatewayConfig(gateway)));
  return new AppError(409, 'version_conflict', 'Khoá cổng vừa được người khác lưu', { current });
}

/** Lưu đủ các ô của cổng (T11). `version` 0 = cổng chưa cấu hình. Không gọi thử cổng. */
export async function saveGatewayConfig(
  caller: Caller,
  gateway: Gateway,
  credentials: Credentials,
  version: number,
): Promise<GatewayConfigView> {
  const credentialsEnc = encryptCredentials(credentials, aadOf(caller.companyId, gateway));
  try {
    return await withCompany(caller.companyId, async () => {
      const existing = await findGatewayConfig(gateway);
      let saved: GatewayConfigRow | undefined;
      if (!existing && version === 0) {
        saved = await insertGatewayConfig({
          companyId: caller.companyId,
          gateway,
          credentialsEnc,
          // URL webhook SePay riêng của công ty, sinh một lần (T12, D16).
          webhookReceiverKey: gateway === 'vietqr' ? randomBytes(24).toString('base64url') : null,
          updatedBy: caller.accountId,
        });
      } else if (existing && existing.version === version) {
        saved = await updateGatewayConfigIfVersion(gateway, version, { credentialsEnc, updatedBy: caller.accountId });
      }
      if (!saved) throw await conflict(caller.companyId, gateway);
      await recordAudit({
        companyId: caller.companyId,
        actorId: caller.accountId,
        action: existing ? 'update' : 'create',
        entityType: ENTITY,
        entityId: saved.id,
        before: existing ? snapshot(gateway, existing.version) : undefined,
        after: snapshot(gateway, saved.version),
      });
      return toView(gateway, saved);
    });
  } catch (err) {
    // Hai lần tạo cùng lúc: unique (company_id, gateway) chặn lần sau; giao dịch đã hỏng nên đọc bản hiện tại ở giao dịch mới.
    if (pgError(err).code === '23505') throw await conflict(caller.companyId, gateway);
    throw err;
  }
}
