// Cấu hình khoá cổng (UC-PF-11; Documents/21 §12.3, §12.8, T4, T11, T12; plan #23 A2–A6).
import { randomBytes } from 'node:crypto';
import { env } from '../../../shared/config/env.ts';
import { withCompany } from '../../../shared/db/client.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { recordAudit } from '../../audit/index.ts';
import { findAccountById } from '../../staff/index.ts';
import { bankNameOf } from '../domain/banks.ts';
import { type Credentials, GATEWAYS, type Gateway, maskCredentials } from '../domain/gateways.ts';
import {
  findGatewayConfig,
  findGatewayConfigs,
  type GatewayConfigRow,
  insertGatewayConfig,
  updateGatewayConfigIfVersion,
} from '../repository/gateway-configs.ts';
import { decryptCredentials, encryptCredentials } from './credentials-cipher.ts';

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
  updatedBy: { id: string; name: string } | null;
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

function webhookUrlOf(receiverKey: string | null): string | null {
  if (!receiverKey || !env.PUBLIC_API_URL) return null;
  return `${env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1/payment/webhooks/sepay/${receiverKey}`;
}

type AccountName = (id: string) => Promise<{ id: string; name: string } | null>;

async function accountName(id: string) {
  const account = await findAccountById(id);
  return account ? { id: account.id, name: account.fullName } : null;
}

async function toView(
  gateway: Gateway,
  row: GatewayConfigRow | undefined,
  nameOf: AccountName = accountName,
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
  const credentials = decryptCredentials(row.credentialsEnc, aadOf(row.companyId, gateway));
  return {
    gateway,
    configured: true,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ? await nameOf(row.updatedBy) : null,
    credentials: maskCredentials(credentials),
    display:
      gateway === 'vietqr'
        ? {
            bankBin: credentials.bankBin!,
            bankName: bankNameOf(credentials.bankBin!),
            accountName: credentials.accountName!,
          }
        : null,
    webhookUrl: gateway === 'vietqr' ? webhookUrlOf(row.webhookReceiverKey) : null,
  };
}

/** Đủ 4 cổng theo thứ tự `GATEWAYS`, khoá đã che (người có `payment.gateway.manage`). */
export async function listGatewayConfigs(companyId: string): Promise<GatewayConfigView[]> {
  return withCompany(companyId, async () => {
    const byGateway = new Map((await findGatewayConfigs()).map((r) => [r.gateway, r]));
    // Bốn cổng thường do cùng một người lưu: tra tên mỗi người một lần.
    const names = new Map<string, ReturnType<AccountName>>();
    const nameOf: AccountName = (id) => names.get(id) ?? names.set(id, accountName(id)).get(id)!;
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

/** Mã lỗi PostgreSQL (Drizzle bọc lỗi gốc trong `cause`). */
const pgCode = (err: unknown) => (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;

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
    if (pgCode(err) === '23505') throw await conflict(caller.companyId, gateway);
    throw err;
  }
}
