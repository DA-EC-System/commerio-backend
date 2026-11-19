// Ngữ cảnh của một lời gọi sàn để chia hạn mức theo công ty (#215, Documents/21 §18.6.8): lời gọi của công ty nào, do việc
// nền hay thao tác bấm tay. Adapter là singleton theo sàn nên `reserveCall` không nhận tham số; ngữ cảnh đi theo
// `AsyncLocalStorage` từ lớp gọi adapter:
// - Công ty: `withTokenRefresh` (mọi phiên `shopSession`), nối gian hàng và làm mới token bọc lời gọi bằng `forCompany`.
// - Việc nền: handler pg-boss và consumer của channel, cổng quyết toán (chỉ việc nền của finance gọi) bọc bằng
//   `inBackground`. Không bọc là thao tác bấm tay (request HTTP, kể cả cổng `order` gọi từ route): mặc định chặt hơn,
//   lời gọi sót đánh dấu chỉ dừng sớm ở 90% chứ không ăn vào phần để dành cho việc nền.
// - Chỉ tính trần chung: làm mới token bọc bằng `appOnly`, vì công ty tiêu hết phần không được để mất token.
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCompanyId } from '../../../../../shared/db/client.ts';

interface CallScope {
  readonly companyId: string | null;
  readonly background: boolean;
  /** Không tính vào phần của công ty nào, kể cả công ty của `withCompany` đang mở. */
  readonly appOnly?: boolean;
}

const store = new AsyncLocalStorage<CallScope>();

/** Chạy `fn` như việc nền: lời gọi sàn trong đó được dùng tới hết phần của công ty. */
export function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ companyId: store.getStore()?.companyId ?? null, background: true }, fn);
}

/**
 * Chạy `fn` như thao tác bấm tay dù đang trong việc nền: lời gọi sàn dừng ở 90% phần của công ty. Lượt Tải lại SKU chạy nền
 * (#361) do người bấm, không được ăn vào phần để dành cho kéo đơn, đẩy tồn (Documents/21 §18.6.8).
 */
export function asManual<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ companyId: store.getStore()?.companyId ?? null, background: false }, fn);
}

/**
 * Chạy `fn` với lời gọi sàn tính vào phần của `companyId`; giữ cờ việc nền và cờ `appOnly` của ngữ cảnh ngoài (lượt đồng
 * bộ cây category mượn phiên `shopSession` của một gian hàng, lớp bọc token gắn `forCompany` bên trong: vẫn chỉ tính trần
 * chung, #400 A4).
 */
export function forCompany<T>(companyId: string, fn: () => T): T {
  const outer = store.getStore();
  return store.run({ companyId, background: outer?.background ?? false, ...(outer?.appOnly && { appOnly: true }) }, fn);
}

/**
 * Chạy `fn` với lời gọi sàn chỉ tính vào trần chung của app, không vào phần của công ty (làm mới token, #215: công ty dùng
 * hết phần vẫn giữ được token, không rơi sang `needs_reauth`).
 */
export function appOnly<T>(fn: () => T): T {
  return store.run({ companyId: null, background: store.getStore()?.background ?? false, appOnly: true }, fn);
}

/** Ngữ cảnh hiện tại. Chưa gắn công ty thì lấy công ty của `withCompany` đang mở (nếu có). */
export function callScope(): CallScope {
  const scope = store.getStore();
  const companyId = scope?.appOnly ? null : (scope?.companyId ?? currentCompanyId());
  return { companyId, background: scope?.background ?? false };
}
