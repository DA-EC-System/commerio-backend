// Tạm khoá của SKU (Documents/21 mục 15.1): phần giảm của phiếu kho đang chờ duyệt. File riêng để `port.ts`, lõi ghi sổ
// và ngưỡng cùng import mà không thành vòng (spec #206 mục 5.2).

// shortcut: tạm khoá luôn 0 vì chưa có phiếu kho chờ duyệt; tính từ phiếu giảm `pending` khi làm B3 (spec #111 Q4).
export const lockedOf = (_variantId: string) => 0;
