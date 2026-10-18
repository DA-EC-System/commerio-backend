// Trạng thái tiền khi đơn được xác nhận; đơn chưa có dòng `order_payments` cũng suy ra như vậy (A8 PR chuẩn bị).
export const initialPaymentStatus = (method: 'prepaid' | 'cod') => (method === 'cod' ? 'cod_pending' : 'unpaid');
