// Danh sách 6 module lớn (19 module con). Thêm module con mới thì thêm vào mảng của module lớn chứa nó.
import type { ModuleDefinition } from '../shared/module.ts';
import { channelModules } from './channel/index.ts';
import { coreModules } from './core/index.ts';
import { financeModules } from './finance/index.ts';
import { insightModules } from './insight/index.ts';
import { orderModules } from './order/index.ts';
import { productModules } from './product/index.ts';

export const modules: readonly ModuleDefinition[] = [
  ...coreModules,
  ...productModules,
  ...orderModules,
  ...financeModules,
  ...channelModules,
  ...insightModules,
];
