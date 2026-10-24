// Factory chọn Strategy theo cổng (docs/16 #9: `PaymentGateway`, 4 lớp cổng, `GatewayFactory`; plan #23 A11).
// Thêm cổng = thêm một file và một dòng ở đây, không sửa service tạo mã.
import type { Gateway } from '../../domain/gateways.ts';
import type { PaymentGateway } from './common.ts';
import { MomoGateway } from './momo.ts';
import { VietqrGateway } from './vietqr.ts';
import { VnpayGateway } from './vnpay.ts';
import { ZalopayGateway } from './zalopay.ts';

export type {
  CallbackInput,
  CallbackOutcome,
  CreatedPayment,
  GatewayResult,
  PaymentGateway,
  PaymentInput,
  QueryTarget,
} from './common.ts';

const gateways: Record<Gateway, PaymentGateway> = {
  vnpay: VnpayGateway,
  momo: MomoGateway,
  zalopay: ZalopayGateway,
  vietqr: VietqrGateway,
};

export const GatewayFactory = {
  of: (gateway: Gateway): PaymentGateway => gateways[gateway],
};
