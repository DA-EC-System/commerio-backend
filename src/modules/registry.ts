// Danh sách 19 module (docs/17 mục 2). Thêm module mới thì thêm vào đây.
import type { ModuleDefinition } from '../shared/module.ts';
import { accessModule } from './access/index.ts';
import { assistantModule } from './assistant/index.ts';
import { auditModule } from './audit/index.ts';
import { catalogModule } from './catalog/index.ts';
import { channelModule } from './channel/index.ts';
import { filesModule } from './files/index.ts';
import { financeModule } from './finance/index.ts';
import { fulfillmentModule } from './fulfillment/index.ts';
import { identityModule } from './identity/index.ts';
import { inboxModule } from './inbox/index.ts';
import { inventoryModule } from './inventory/index.ts';
import { notificationModule } from './notification/index.ts';
import { paymentModule } from './payment/index.ts';
import { platformModule } from './platform/index.ts';
import { pricingModule } from './pricing/index.ts';
import { purchasingModule } from './purchasing/index.ts';
import { reportModule } from './report/index.ts';
import { salesModule } from './sales/index.ts';
import { staffModule } from './staff/index.ts';

export const modules: readonly ModuleDefinition[] = [
  platformModule,
  identityModule,
  staffModule,
  accessModule,
  auditModule,
  filesModule,
  catalogModule,
  pricingModule,
  inventoryModule,
  purchasingModule,
  salesModule,
  fulfillmentModule,
  financeModule,
  paymentModule,
  channelModule,
  inboxModule,
  notificationModule,
  assistantModule,
  reportModule,
];
