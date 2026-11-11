import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from '../../../../shared/http/openapi.ts';
import {
  AttachBody,
  DismissBody,
  PlatformHistoryList,
  ReasonsQuery,
  ReceiveResult,
  ReceiveReturnBody,
  ReturnActionBody,
  ReturnActionParams,
  ReturnListQuery,
  ReturnListResponse,
  ReturnParams,
  ReturnReasonList,
  ReturnRequest,
  UnmatchedList,
  UnmatchedParcel,
  UnmatchedQuery,
} from './return-schemas.ts';

const bearer = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const auth = {
  401: problemResponse('Thiếu, sai hoặc hết hạn token'),
  403: problemResponse('`forbidden`, `company_not_selected`, `module_disabled`'),
};
const notFound = { 404: problemResponse('`not_found`: không có hoặc của công ty khác') };
const marketplace = {
  409: problemResponse('`marketplace_rejected` kèm `platformCode`, `platformMessage`'),
  422: problemResponse('`not_marketplace` (yêu cầu tạo tay), `marketplace_unsupported`'),
  503: problemResponse('`marketplace_unavailable`: sàn lỗi tạm, thử lại'),
};
const LINES =
  '`lines` lỗi theo §15.3: không phải mảng `errors.lines`; âm, không nguyên `errors["lines.<i>.quantity"]`; trùng hoặc không phải SKU của công ty `errors["lines.<i>.variantId"]`';

/** Đường dẫn Swagger của yêu cầu trả, viết tương đối với /api/v1/returns (Documents/21 §20, §20.1). */
export function registerReturnsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/',
    summary: 'Danh sách yêu cầu trả (§20)',
    description:
      'Cần `sales.return.view`. Mới trước. `search` theo mã yêu cầu, mã đơn, tên khách. `counts` theo trạng thái (không theo `status` của bộ lọc) và số kiện không khớp còn mở.',
    security: bearer,
    request: { query: ReturnListQuery },
    responses: { 200: { description: 'Một trang', ...json(ReturnListResponse) }, ...auth, 422: problemResponse('`validation_failed`') },
  });
  registry.registerPath({
    method: 'get',
    path: '/:id',
    summary: 'Chi tiết yêu cầu trả (§20, §20.1)',
    description: 'Cần `sales.return.view`. `money.resellCost` null khi thiếu `inventory.cost.view`.',
    security: bearer,
    request: { params: ReturnParams },
    responses: { 200: { description: 'Yêu cầu trả', ...json(ReturnRequest) }, ...auth, ...notFound },
  });
  registry.registerPath({
    method: 'post',
    path: '/:id/:action',
    summary: 'Thao tác yêu cầu trả (§20)',
    description:
      'Cần `sales.return.process`. `accept`; `reject` (bắt buộc lý do; yêu cầu từ sàn bắt buộc `reasonId` trong danh sách của sàn); `refund-only` (hoàn tiền, khách giữ hàng, phát `sales.return_refunded`); `platform-reopen`, `platform-refund` (ghi nhận sàn xử cho khách, chỉ yêu cầu từ sàn); `no-show` (khách không gửi hàng, bắt buộc lý do). Yêu cầu từ sàn: `accept`, `reject`, `refund-only` báo sàn trước rồi mới ghi.',
    security: bearer,
    request: { params: ReturnActionParams, body: json(ReturnActionBody) },
    responses: {
      200: { description: 'Yêu cầu trả sau thao tác', ...json(ReturnRequest) },
      ...auth,
      ...notFound,
      409: problemResponse('`invalid_transition` kèm `current`, `version_conflict` kèm `current`, `not_marketplace`, `marketplace_rejected`'),
      422: problemResponse('`validation_failed` (`errors.reasonId`, `errors.attachmentIds`), `reason_required`, `marketplace_unsupported`'),
      503: problemResponse('`marketplace_unavailable`'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/receive',
    summary: 'Quét nhận hàng trả (§20, §15.3)',
    description:
      'Cần `fulfillment.order.process`. `code`: mã yêu cầu, mã vận đơn chiều về, mã đơn hoặc mã đơn sàn. Khớp yêu cầu `awaiting_return`: gộp `lines` với dòng yêu cầu (vắng: quét 0; ngoài yêu cầu: dự kiến 0; không gửi `lines`: quét đủ) rồi gọi `receiveBack`, yêu cầu sang `received`; yêu cầu từ sàn thì báo sàn đã nhận (sàn lỗi: yêu cầu bật Cần xử lý). Không khớp: lưu kiện và dòng, có `lines` thì gọi `receiveBack` nguồn `unmatched_parcel`. 501 `not_implemented` (`commerio-backend#208`) cho phần kho chưa có của chữ ký 11/11/2026.',
    security: bearer,
    request: { body: json(ReceiveReturnBody) },
    responses: {
      200: { description: 'Khớp hoặc không khớp', ...json(ReceiveResult) },
      ...auth,
      409: problemResponse('`return_not_awaiting` kèm `current`'),
      422: problemResponse(`\`validation_failed\`. ${LINES}`),
      501: problemResponse('`not_implemented` kèm `issue`, `owner`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/unmatched',
    summary: 'Kiện trả không khớp (§20)',
    description: 'Cần `sales.return.view`. Mới trước, tối đa 500 kiện.',
    security: bearer,
    request: { query: UnmatchedQuery },
    responses: { 200: { description: 'Kiện', ...json(UnmatchedList) }, ...auth, 422: problemResponse('`validation_failed`') },
  });
  const parcelErrors = {
    ...auth,
    404: problemResponse('`not_found`'),
    409: problemResponse('`parcel_resolved`, `version_conflict` kèm `current`, `return_not_awaiting`'),
    422: problemResponse('`validation_failed`'),
  };
  registry.registerPath({
    method: 'post',
    path: '/unmatched/:id/attach',
    summary: 'Gắn kiện đã nhận vào yêu cầu trả (§20, E88)',
    description: 'Cần `fulfillment.order.process`. Yêu cầu sang `received` không quét lại; phiếu của kiện chuyển sang nguồn yêu cầu, không cộng chờ xử lý lần hai.',
    security: bearer,
    request: { params: ReturnParams, body: json(AttachBody) },
    responses: { 200: { description: 'Kiện', ...json(UnmatchedParcel) }, ...parcelErrors, 501: problemResponse('`not_implemented` kèm `issue`, `owner`') },
  });
  registry.registerPath({
    method: 'post',
    path: '/unmatched/:id/dismiss',
    summary: 'Bỏ qua kiện trả không khớp (§20)',
    description: 'Cần `fulfillment.order.process`. Hàng đã cộng vẫn ở chờ xử lý; phiếu kiểm hàng hoàn của kiện vẫn mở.',
    security: bearer,
    request: { params: ReturnParams, body: json(DismissBody) },
    responses: { 200: { description: 'Kiện', ...json(UnmatchedParcel) }, ...parcelErrors },
  });
  registry.registerPath({
    method: 'get',
    path: '/:id/reasons',
    summary: 'Lý do từ chối của sàn (§20.1)',
    description: 'Cần `sales.return.process`. Hỏi sàn mỗi lần gọi.',
    security: bearer,
    request: { params: ReturnParams, query: ReasonsQuery },
    responses: { 200: { description: 'Lý do', ...json(ReturnReasonList) }, ...auth, ...notFound, ...marketplace },
  });
  registry.registerPath({
    method: 'get',
    path: '/:id/platform-history',
    summary: 'Lịch sử đơn ngược phía sàn (§20.1)',
    description: 'Cần `sales.return.view`. Mới nhất trước.',
    security: bearer,
    request: { params: ReturnParams },
    responses: { 200: { description: 'Lịch sử', ...json(PlatformHistoryList) }, ...auth, ...notFound, ...marketplace },
  });
}
