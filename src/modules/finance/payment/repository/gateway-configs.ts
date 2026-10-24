import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { Gateway } from '../domain/gateways.ts';
import { gatewayConfigs } from './schema.ts';

export type GatewayConfigRow = typeof gatewayConfigs.$inferSelect;

/** Cấu hình cổng của công ty đang mở giao dịch (RLS lọc theo `app.company_id`). */
export async function findGatewayConfigs(): Promise<GatewayConfigRow[]> {
  return getDb().select().from(gatewayConfigs);
}

export async function findGatewayConfig(gateway: Gateway): Promise<GatewayConfigRow | undefined> {
  const [row] = await getDb().select().from(gatewayConfigs).where(eq(gatewayConfigs.gateway, gateway));
  return row;
}

export async function insertGatewayConfig(values: {
  companyId: string;
  gateway: Gateway;
  credentialsEnc: Buffer;
  webhookReceiverKey: string | null;
  updatedBy: string;
}): Promise<GatewayConfigRow> {
  const [row] = await getDb()
    .insert(gatewayConfigs)
    .values({ ...values, isConfigured: true })
    .returning();
  return row!;
}

/** Thay khoá và tăng version nếu version khớp; `undefined` khi version đã đổi. */
export async function updateGatewayConfigIfVersion(
  gateway: Gateway,
  version: number,
  values: { credentialsEnc: Buffer; updatedBy: string },
): Promise<GatewayConfigRow | undefined> {
  const [row] = await getDb()
    .update(gatewayConfigs)
    .set({ ...values, isConfigured: true, version: sql`${gatewayConfigs.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(gatewayConfigs.gateway, gateway), eq(gatewayConfigs.version, version)))
    .returning();
  return row;
}

/** Công ty sở hữu URL webhook SePay, tra **mọi công ty** bằng role chủ bảng (ngoài `withCompany`, D16, T12). */
export async function findCompanyByReceiverKey(receiverKey: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ companyId: gatewayConfigs.companyId })
    .from(gatewayConfigs)
    .where(and(eq(gatewayConfigs.webhookReceiverKey, receiverKey), eq(gatewayConfigs.gateway, 'vietqr')));
  return row?.companyId;
}
