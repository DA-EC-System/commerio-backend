// VietQR: chuỗi EMVCo chuyển khoản tới tài khoản công ty, nội dung là mã thanh toán (QT-37). Không gọi mạng; tiền về
// được SePay báo qua webhook (#27).
import { buildVietQr } from '../../domain/vietqr.ts';
import type { PaymentGateway } from './common.ts';

export const VietqrGateway: PaymentGateway = {
  async createPayment(input, credentials) {
    const qrContent = buildVietQr({
      bankBin: credentials.bankBin!,
      accountNo: credentials.accountNo!,
      amount: input.amount,
      content: input.paymentCode,
    });
    return { payUrl: null, qrContent, gatewayOrderRef: null };
  },
};
