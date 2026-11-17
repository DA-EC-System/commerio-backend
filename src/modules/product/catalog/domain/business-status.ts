// Trạng thái kinh doanh của SKU (sơ đồ B1, Documents/21 §17.3, 25 §5.1). Chép đúng bảng FE
// `src/lib/machines/product.ts`: đổi một bên thì đổi bên kia.
import { defineMachine } from '../../../core/index.ts';

export const BUSINESS_STATUSES = ['selling', 'paused', 'discontinued', 'archived'] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const BUSINESS_ACTIONS = ['pause', 'unpause', 'discontinue', 'reactivate', 'archive', 'restore'] as const;
export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

/** Dữ liệu guard cần: câu lý do chưa lưu trữ được (tồn, chứng từ mở); rỗng là lưu trữ được. */
export interface BusinessRecord {
  archiveBlockers: readonly string[];
}

const MANAGE = 'catalog.product.manage';

export const businessStatusMachine = defineMachine<BusinessStatus, BusinessAction, BusinessRecord>([
  { from: ['selling', 'discontinued'], to: 'paused', action: 'pause', label: 'Tạm ngừng', permission: MANAGE },
  { from: 'paused', to: 'selling', action: 'unpause', label: 'Bỏ tạm ngừng', permission: MANAGE },
  { from: ['selling', 'paused'], to: 'discontinued', action: 'discontinue', label: 'Ngừng nhập', permission: MANAGE },
  { from: 'discontinued', to: 'selling', action: 'reactivate', label: 'Nhập lại', permission: MANAGE },
  {
    from: 'discontinued',
    to: 'archived',
    action: 'archive',
    label: 'Lưu trữ',
    permission: MANAGE,
    guard: (r) => (r.archiveBlockers.length ? 'archive_blocked' : null),
  },
  { from: 'archived', to: 'discontinued', action: 'restore', label: 'Khôi phục', permission: MANAGE },
]);
