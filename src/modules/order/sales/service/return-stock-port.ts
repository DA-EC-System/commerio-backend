// Cổng `receiveBack` theo chữ ký chốt 11/11/2026 (Documents/21 §11.1): dòng `{ variantId, expected, scanned }`, `meta`,
// nguồn `unmatched_parcel`. Bản thật của inventory trên `main` còn chữ ký cũ (chỉ số dự kiến, không `meta`, không
// `unmatched_parcel`); phần đó là của commerio-backend#208 (Bình). Bản nối dưới đây chuyển lời gọi được sang chữ ký cũ
// và ném 501 `not_implemented` (R13) cho phần chưa có; #208 xong thì thay `real` bằng `receiveBack` của inventory.
import { type DocumentRef, receiveBack as receiveBackV1 } from '../../../product/index.ts';
import { notImplemented } from '../../../../shared/errors/app-error.ts';
import type { ReceiveLine } from '../domain/return.ts';

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

const pending = (what: string) => notImplemented(what, 'commerio-backend#208', 'Bình');

const real: ReturnStockPort = {
  async receiveBack(source, lines, meta) {
    if (source.type === 'unmatched_parcel') throw pending('phiếu kiểm hàng hoàn cho kiện trả không khớp');
    if (meta.fromUnmatchedParcelId) throw pending('chuyển phiếu của kiện không khớp sang yêu cầu trả');
    const expected = lines.filter((l) => l.expected > 0).map((l) => ({ variantId: l.variantId, quantity: l.expected }));
    if (!expected.length) throw pending('phiếu kiểm hàng hoàn không có số dự kiến');
    // Chữ ký cũ chỉ nhận số dự kiến: số quét chưa vào phiếu, chờ xử lý chưa tăng lúc nhận (phần của #208).
    return receiveBackV1({ type: 'return_request', id: source.id }, expected);
  },
};

let port: ReturnStockPort = real;

export const returnStockPort = (): ReturnStockPort => port;

/** Test thay cổng; gọi không tham số để trả lại bản nối với inventory. */
export function setReturnStockPort(next?: ReturnStockPort): void {
  port = next ?? real;
}
