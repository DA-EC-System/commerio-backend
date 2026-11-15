import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import type { Gateway } from '../domain/gateways.ts';
import { gatewayConfigs } from './schema.ts';

export type GatewayConfigRow = typeof gatewayConfigs.$inferSelect;

export async function findGatewayConfig(gateway: Gateway): Promise<GatewayConfigRow | undefined> {
  const [row] = await getDb().select().from(gatewayConfigs).where(eq(gatewayConfigs.gateway, gateway));
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
