// Cổng `receiveBack` của inventory theo chữ ký chốt 11/11/2026 (Documents/21 §11.1, có từ commerio-backend#208): dòng
// `{ variantId, expected, scanned }`, `meta`, nguồn `return_request` hoặc `unmatched_parcel`. Sales gọi qua cổng này để
// test thay được bằng bản giả.
import { type DocumentRef, receiveBack } from '../../../product/index.ts';
import type { ReceiveLine } from '../../fulfillment/index.ts';

export interface ReceiveBackMeta {
  actorId: string | null;
  number?: string;
  orderId?: string;
  shopId?: string | null;
  unitCosts?: Readonly<Record<string, string | null>>;
  note?: string;
  fromUnmatchedParcelId?: string;
}

export interface ReturnStockPort {
  receiveBack(
    source: { type: 'return_request' | 'unmatched_parcel'; id: string },
    lines: readonly ReceiveLine[],
    meta: ReceiveBackMeta,
  ): Promise<DocumentRef>;
}

const real: ReturnStockPort = { receiveBack: (source, lines, meta) => receiveBack(source, lines, meta) };

let port: ReturnStockPort = real;

export const returnStockPort = (): ReturnStockPort => port;

/** Test thay cổng; gọi không tham số để trả lại bản nối với inventory. */
export function setReturnStockPort(next?: ReturnStockPort): void {
  port = next ?? real;
}
