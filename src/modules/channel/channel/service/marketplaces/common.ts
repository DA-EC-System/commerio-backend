// Kiểu chung của adapter sàn (Strategy, #103 B7). Chỉ adapter gọi HTTP sàn, ký request và biết mã lỗi của sàn;
// nghiệp vụ nhận kiểu đã chuẩn hoá và `MarketplaceError`. #104–#106 thêm năng lực của mình vào `MarketplaceAdapter`.
import type { LedgerKind } from '../../../../finance/index.ts';
import type { RemoteState } from '../../domain/listing.ts';
import type { ShopCapabilities } from '../../domain/shop.ts';

export type { ShopCapabilities };

/**
 * Token của một gian hàng. `accessToken`, `refreshToken` là **chuỗi mờ do adapter tự định dạng**: app chỉ mã hoá, lưu,
 * giải mã rồi trả nguyên cho adapter, không đọc. Sàn cần thêm bí mật theo gian hàng (TikTok `cipher`) thì adapter tự gói
 * vào chuỗi này, không thêm cột hay tham số (#200).
 */
export interface TokenSet {
  accessToken: string;
  /** null khi sàn hoặc người dùng không đưa (token dán từ console): hết hạn access thì phải nối lại. */
  refreshToken: string | null;
  /** null khi không biết hạn (token dán tay). */
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  /**
   * Hạn uỷ quyền seller chọn trên sàn (Documents/21 §18.4, cột `auth_expires_at`, #201): tới đó chỉ người dùng kết nối
   * lại được. Bỏ trống hoặc null khi sàn không có hạn riêng ngoài `refreshExpiresAt` (Lazada; TikTok: hạn refresh token
   * đã là hạn uỷ quyền, xem `tiktok.ts`).
   */
  authExpiresAt?: Date | null;
}

/** Hạn của token đã lưu, đủ để adapter tính lúc làm mới (`refreshDueAt`). */
export type TokenExpiry = Pick<TokenSet, 'accessExpiresAt' | 'refreshExpiresAt'>;

/** Ngưỡng mặc định: làm mới khi access còn dưới 48 giờ (ngưỡng cũ của #102), cho adapter không khai `refreshDueAt`. */
export const DEFAULT_REFRESH_LEAD_MS = 48 * 3_600_000;

/** Lúc làm mới = hạn access trừ `leadMs`; không biết hạn access thì null (không tự làm mới, chờ sàn báo `unauthorized`). */
export function refreshBefore(tokens: TokenExpiry, leadMs: number): Date | null {
  return tokens.accessExpiresAt ? new Date(tokens.accessExpiresAt.getTime() - leadMs) : null;
}

export interface SellerInfo {
  /** Mã shop của sàn (Lazada: `seller_id`). */
  externalShopId: string;
  shopName: string;
  /** Mã vùng ISO 3166-1 alpha-2 do sàn trả, chỉ để hiện; null khi sàn không cho biết. */
  region: string | null;
}

/** Một gian hàng ra từ một lần uỷ quyền hay một token, kèm token riêng của nó (một lần có thể ra nhiều gian hàng). */
export interface ShopConnection extends SellerInfo {
  tokens: TokenSet;
}

/** Danh mục lá của sàn; `name` là cả đường dẫn ("Quần áo nam > Áo > Áo thun có cổ nam"). */
export interface PlatformCategory {
  externalId: string;
  name: string;
}

/** Thuộc tính bắt buộc ở cấp sản phẩm của một danh mục; `options` rỗng khi nhập tự do. */
export interface CategoryAttribute {
  name: string;
  label: string;
  options: string[];
}

/** Một sản phẩm một SKU (#104 A1). Tiền là chuỗi thập phân; kích thước theo đơn vị của Commerio. */
export interface NewProduct {
  externalCategoryId: string;
  attributes: Record<string, string>;
  name: string;
  description: string;
  /** Ảnh đã nằm trên sàn, đúng chuỗi `uploadImage` trả (Lazada URL, TikTok `uri`). */
  imageUrls: string[];
  sellerSku: string;
  price: string;
  quantity: number;
  weightG: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  /**
   * Khoá chống tạo trùng của một lượt đẩy (#219): giữ nguyên qua mọi lần việc nền thử lại, đổi khi người dùng bấm đẩy lại.
   * TikTok gửi làm `idempotency_key`; sàn không có khoá (Lazada tra theo SellerSku) thì bỏ qua.
   */
  idempotencyKey?: string;
}

export interface CreatedProduct {
  externalProductId: string;
  externalSkuId: string;
  /** Sàn cho bán ngay (Lazada `item_status: Active`, gọi thật 28/10); false là chờ duyệt. */
  live: boolean;
}

/**
 * Trạng thái sản phẩm trên sàn, đã chuẩn hoá: `review` chờ duyệt, `live` đang bán, `rejected` bị từ chối,
 * `hold` sàn khoá, `inactive` đã tắt, `deleted` đã xoá.
 */
export type { RemoteState };

export interface RemoteSku {
  externalProductId: string;
  externalSkuId: string;
  sellerSku: string;
  title: string;
  state: RemoteState;
  rejectReason: string | null;
  quantity: number;
  /**
   * Nhãn biến thể đọc được từ sàn (giá trị thuộc tính bán hàng), đã có trong `title`. Không có (sàn không trả, nhãn dự
   * phòng là SKU người bán) thì thiếu hoặc null: SKU của sản phẩm nhiều SKU khi đó không được ghép theo tên (#282).
   */
  variantLabel?: string | null;
  /**
   * `true` khi SKU thuộc sản phẩm nhiều SKU mà lần đọc này không lấy được nhãn biến thể (vượt trần đọc chi tiết, sàn lỗi,
   * `labels: false`): `title` chỉ là "tên - SKU người bán". Bản sao SKU sàn khi đó giữ tiêu đề cũ đã có nhãn (review #309
   * vòng 2 N3). Sàn có nhãn sẵn trong danh sách (Lazada) hoặc sản phẩm một SKU thì thiếu.
   */
  labelMissing?: boolean;
  /**
   * URL ảnh đầu tiên của sản phẩm trên sàn, cho bảng ghép lúc thiết lập (#282, Documents/21 §18.7.5). Thiếu hoặc null khi
   * sàn không trả ảnh hay adapter không đọc (TikTok: `labels: false`, quá trần đọc chi tiết, Get Product lỗi).
   */
  imageUrl?: string | null;
  /**
   * Sàn đang khoá tồn, giá của SKU do khuyến mãi (25 §6.5 bước 3, E32, #223): đồng bộ không ghi đè phần bị khoá, chỉ báo
   * (`promotion_locked`). Thiếu là không khoá. Lazada, TikTok không điền: không có API đọc trước được SKU nào đang bị khoá
   * (TikTok Promotion API `activities/search` không lọc theo sản phẩm, không gồm chiến dịch của sàn; chốt 12/11/2026 không
   * đọc trước). Khoá do khuyến mãi về qua mã lỗi khi đẩy, adapter đổi thành `PROMOTION_LOCKED`.
   */
  stockLocked?: boolean;
  priceLocked?: boolean;
  /**
   * Số còn bán được trên sàn, cùng nghĩa với số app đẩy lên (số có thể bán), để đối chiếu tồn (#223, 25 §6.5). Thiếu thì
   * không đối chiếu SKU đó. TikTok: tổng `inventory[].quantity` ("quantity available in the warehouse", cũng là số app
   * đẩy). Lazada: `sellableStock` của `/products/get` `options=1` (đo trên shop thử, xem `lazada.ts`); app đẩy bằng
   * UpdateSellableQuantity nên cùng nghĩa.
   */
  sellableQuantity?: number;
}

export interface PriceQuantity {
  externalProductId: string;
  externalSkuId: string;
  price?: string;
  quantity?: number;
}

/** Một khoản tiền sàn ghi theo đơn trong kỳ quyết toán (#117; Lazada `/finance/transaction/details/get`). */
export interface SettlementTxn {
  /** Mã giao dịch của sàn, duy nhất: chống ghi trùng khi kéo lại cùng kỳ. */
  txnId: string;
  externalOrderId: string | null;
  /** `YYYY-MM-DD`. */
  date: string;
  feeName: string;
  /** Mã phí gốc của sàn (Lazada `fee_type`), ghi kèm tên khi khoản chưa ánh xạ được (US-TI-06 dòng 2). */
  feeCode: string | null;
  transactionType: string;
  /** Có dấu: sàn trả shop dương, sàn trừ âm. Chuỗi thập phân. */
  amount: string;
  /** Thuế sàn khấu trừ của khoản này (số dương), `"0"` khi không có. */
  withholding: string;
  /**
   * Loại khoản trong sổ tiền, adapter đổi từ tên phí của sàn mình (Documents/tich-hop-san/README.md mục 2, #203);
   * `null` là chưa nhận ra: finance ghi `adjustment` kèm tên phí.
   */
  kind: LedgerKind | null;
}

/** Một kỳ quyết toán (#117; Lazada `/finance/payout/status/get`). */
export interface Payout {
  statementNumber: string;
  createdAt: string;
  payout: string;
  closingBalance: string;
  paid: boolean;
}

/**
 * Trạng thái một món trên sàn, đã chuẩn hoá theo trạng thái kiện của app (#105). `pending`: chưa đóng gói (kiện giữ
 * hàng hoặc thiếu hàng); `return_failed`: hoàn hàng thất bại, kiện giữ `returning` và cần xử lý.
 */
export type RemoteLineStatus =
  | 'pending'
  | 'packed'
  | 'awaiting_pickup'
  | 'in_transit'
  | 'delivered'
  | 'delivery_failed'
  | 'returning'
  | 'returned'
  | 'return_failed'
  | 'lost'
  | 'cancelled';

export interface RemoteOrderRef {
  externalOrderId: string;
  placedAt: Date;
  updatedAt: Date;
  /** Dữ liệu đơn adapter đã đọc ở trang liệt kê, chỉ adapter đó hiểu; bên gọi chuyển nguyên cho `getOrders` (#267). */
  detail?: unknown;
}

/** Một món của đơn sàn. Tiền là chuỗi thập phân; Lazada mỗi món một đơn vị. */
export interface RemoteOrderLine {
  externalLineId: string;
  sellerSku: string;
  productName: string;
  unitPrice: string;
  sellerDiscount: string;
  platformDiscount: string;
  /** Mã kiện của sàn; null khi sàn chưa chia kiện. */
  packageCode: string | null;
  trackingCode: string | null;
  rawStatus: string;
  /** null khi sàn trả giá trị app chưa biết. */
  status: RemoteLineStatus | null;
  info: RemoteLineInfo;
  shipping: RemoteShipping;
}

/** Thông tin mô tả của món (#260); không ảnh hưởng trạng thái, kéo lại thì ghi đè. Tiền là chuỗi thập phân, trống là null. */
export interface RemoteLineInfo {
  thumbnailUrl: string | null;
  attributesLabel: string | null;
  externalSkuId: string | null;
  externalShopSku: string | null;
  externalProductId: string | null;
  paidPrice: string | null;
  taxAmount: string | null;
  shippingAmount: string | null;
  walletCredits: string | null;
  cancelReason: string | null;
  cancelReasonDetail: string | null;
  cancelInitiator: 'buyer' | 'seller' | 'platform' | null;
  cancelKind: 'cancellation' | 'return' | 'refund' | 'failed_delivery' | null;
  reverseOrderId: string | null;
  returnStatus: string | null;
}

/** Vận chuyển sàn trả theo món, app ghi lên kiện chứa món (#260). */
export interface RemoteShipping {
  shipmentProvider: string | null;
  shippingProviderType: string | null;
  shippingType: string | null;
  promisedShippingAt: Date | null;
}

/** Địa chỉ giao: `raw` là khoá gốc của sàn (đã che), bỏ khoá rỗng. */
export interface RemoteAddress {
  name: string;
  phone: string;
  address: string;
  ward: string | null;
  postCode: string | null;
  raw: Record<string, string>;
}

/** Thông tin mô tả của đơn (#260). */
export interface RemoteOrderInfo {
  /** Phương thức khách trả trên sàn, giá trị gốc (`COD`, `MIXEDCARD`…). */
  platformPaymentMethod: string | null;
  buyerNote: string | null;
  shippingFeeOriginal: string | null;
  shippingFeeDiscountSeller: string | null;
  shippingFeeDiscountPlatform: string | null;
}

/** Đơn sàn đã chuẩn hoá (#105); kéo định kỳ đưa vào service nhận đơn. */
export interface RemoteOrder {
  externalOrderId: string;
  /** Các trạng thái gốc của món, nối bằng dấu phẩy, chỉ để hiện. */
  rawStatus: string;
  /** Khách đã trả, hoặc đơn COD sàn đã nhận. */
  paid: boolean;
  isCod: boolean;
  placedAt: Date;
  updatedAt: Date;
  shipBy: Date | null;
  shippingAddress: RemoteAddress | null;
  shippingFee: string;
  /** Khách xin huỷ, chờ người bán đồng ý. */
  cancelRequested: boolean;
  /**
   * Mốc sàn ghi đơn đã giao (TikTok `delivery_time`, #221); sàn không trả thì không có. Chỉ lưu ở `raw_orders`, hạn trả
   * tính từ đây là việc của phía app.
   */
  deliveredAt?: Date | null;
  info: RemoteOrderInfo;
  lines: RemoteOrderLine[];
}

/** Lý do sàn bắt tách kiện (TikTok `must_split_reasons`, #221): vượt số món theo danh mục hay tổng số món một kiện. */
export interface MustSplitReason {
  /** Mã gốc của sàn (`CATEGORY_ITEM_LIMITATION`, `TOTAL_COUNT_LIMITATION`). */
  type: string;
  externalCategoryId: string | null;
  maxCount: number | null;
}

/** Đơn tách kiện được không (#221; app dùng ở #205). */
export interface SplitAttributes {
  canSplit: boolean;
  mustSplit: boolean;
  /** Câu của sàn khi không tách được; null khi tách được. */
  reason: string | null;
  mustSplitReasons: MustSplitReason[];
}

/** Kết quả theo từng SKU khi đẩy theo lô (§18.4): SKU lỗi không đánh lỗi cả lô. */
/**
 * Mã lỗi theo SKU khi sàn từ chối cập nhật tồn hoặc giá vì SKU đang trong khuyến mãi, chiến dịch (#223, 25 §6.5 bước 3,
 * E32). Adapter đổi mã riêng của sàn thành mã này, giữ câu của sàn trong `message`.
 */
export const PROMOTION_LOCKED = 'promotion_locked';

export type PartResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * Kết quả đẩy một SKU. `ok`/`code`/`message` gộp cả lời gọi (lỗi đầu tiên). Sàn đổi tồn và giá bằng hai lời gọi riêng
 * (Lazada, TikTok) thì trả thêm `stock`, `price` (chỉ phần có gửi), để tồn bị khoá không làm giá thành lỗi và ngược lại
 * (#223); bên gọi áp từng phần, không có thì dùng kết quả chung.
 */
export type PerSkuResult = PartResult & { externalSkuId: string; stock?: PartResult; price?: PartResult };

/** Dựng `PerSkuResult` từ lỗi theo SKU của phần tồn và phần giá (adapter gọi hai lời gọi riêng). */
export function partResults(
  items: readonly PriceQuantity[],
  stockErrors: ReadonlyMap<string, { code: string; message: string }>,
  priceErrors: ReadonlyMap<string, { code: string; message: string }>,
): PerSkuResult[] {
  const part = (e: { code: string; message: string } | undefined): PartResult => (e ? { ok: false, code: e.code, message: e.message } : { ok: true });
  return items.map((i) => {
    const stock = i.quantity === undefined ? undefined : part(stockErrors.get(i.externalSkuId));
    const price = i.price === undefined ? undefined : part(priceErrors.get(i.externalSkuId));
    const first = [stock, price].find((p) => p && !p.ok) ?? { ok: true as const };
    return { externalSkuId: i.externalSkuId, ...first, ...(stock && { stock }), ...(price && { price }) };
  });
}

/** Cách nối gian hàng (#163): `oauth` qua trang uỷ quyền của sàn, `token` dán token lấy trên console của sàn. */
export type ConnectMethod = 'oauth' | 'token';

/** Kết quả `MarketplaceAdapter.countRemote`: số sản phẩm và số SKU (phân loại) của gian hàng trên sàn, không tính đã xoá. */
export interface RemoteCounts {
  productCount: number;
  skuCount: number | null;
}

/** Tham chiếu các món thuộc một kiện trên sàn. */
export interface PackageItemsRef {
  externalOrderId: string;
  externalLineIds: readonly string[];
}

export interface CarrierOption {
  code: string;
  name: string;
  isDefault: boolean;
}

export interface PlatformPack {
  packageCode: string;
  trackingCode: string | null;
  carrier: { code: string; name: string } | null;
}

export const CARRIER_REQUIRED = 'carrier_required';

export interface MarketplaceAdapter {
  /** Tên sàn hiển thị cho người dùng. */
  readonly name: string;
  /** Cách nối dùng được với cấu hình hiện tại; rỗng là sàn chưa nối được trên môi trường này. */
  connectMethods(): readonly ConnectMethod[];
  /** Năng lực tĩnh của sàn, không phụ thuộc cấu hình (Documents/21 §18.6.3). */
  readonly capabilities: ShopCapabilities;
  /** URL trang uỷ quyền của sàn, mang `state` để kiểm ở callback. */
  authorizeUrl(state: string): string;
  /**
   * Callback OAuth: `params` là mọi query sàn trả trên URL callback trừ `state`; adapter tự đọc tham số mình cần, thiếu thì
   * ném `rejected` `missing_parameter`. Trả mọi gian hàng của lần uỷ quyền, mỗi gian hàng một `TokenSet`.
   */
  exchangeCode(params: Readonly<Record<string, string>>): Promise<ShopConnection[]>;
  /**
   * Token dán tay lấy trên console của sàn, đi qua cùng hợp đồng với callback. Adapter tự quyết có làm mới không (Lazada:
   * có refresh token thì làm mới một lần để biết hạn) và một token ra mấy gian hàng.
   */
  connectWithToken(input: { accessToken: string; refreshToken: string | null }): Promise<ShopConnection[]>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  /**
   * Từ lúc nào việc nền `channel.token_refresh` (chạy mỗi giờ) phải làm mới token này (#201, Documents/21 §18.4 "ngưỡng
   * adapter khai"); null là không tự làm mới. Không khai thì dùng `DEFAULT_REFRESH_LEAD_MS`. Phải để cách hạn access ít
   * nhất hơn một vòng việc nền, và đủ xa để token vừa làm mới không tới hạn lại ngay ở vòng sau.
   */
  refreshDueAt?(tokens: TokenExpiry): Date | null;
  /**
   * Hạn refresh token cố định từ lúc seller uỷ quyền, làm mới không gia hạn (Lazada). Khai `true` thì lần làm mới giữ
   * `refresh_expires_at` đã lưu, không lấy hạn adapter vừa tính lại từ "số giây còn lại" (lệch theo độ trễ mạng, làm
   * nhãn "Sắp hết hạn" và thư báo mất uỷ quyền #312 tưởng là hạn mới).
   */
  readonly refreshKeepsAuthDeadline?: boolean;
  listCategories(accessToken: string): Promise<PlatformCategory[]>;
  categoryAttributes(accessToken: string, externalCategoryId: string): Promise<CategoryAttribute[]>;
  /**
   * Đưa ảnh từ URL công khai lên sàn, trả chuỗi định danh ảnh trên sàn để truyền lại vào `createProduct`
   * (`NewProduct.imageUrls`): Lazada là URL, TikTok là `uri` của ảnh.
   */
  uploadImage(accessToken: string, url: string): Promise<string>;
  createProduct(accessToken: string, product: NewProduct): Promise<CreatedProduct>;
  /**
   * Đẩy lại sản phẩm đã có trên sàn (#219: listing `push_failed`, `rejected`, `platform_hold`, hay dòng mới sau gỡ còn
   * giữ mã sàn của dòng cũ): ghi nội dung `product` lên sản phẩm `externalProductId` (SKU `externalSkuId`), rồi bật lại nếu
   * sản phẩm đang tắt. `live`: sàn cho bán ngay; false là chờ duyệt (kể cả sàn vừa từ chối lại, trạng thái về qua đồng
   * bộ). Sản phẩm vẫn tắt hay bị khoá sau khi ghi thì ném `rejected` `still_inactive`. Không đổi SellerSku. Sửa nội dung
   * listing đang bán (`update_content`) là việc của #293, không dùng hàm này. Sàn chưa có thì không có hàm này.
   */
  updateProduct?(accessToken: string, externalProductId: string, externalSkuId: string, product: NewProduct): Promise<{ live: boolean }>;
  /**
   * Mọi SKU của gian hàng, cho gợi ý ghép lúc thiết lập (#198, Documents/21 §18.7.5) và lần đọc trọn của bản sao SKU sàn
   * (#220). Gian hàng quá giới hạn đọc của sàn thì ném `rejected`, không trả thiếu: số sản phẩm đọc được ít hơn tổng sàn
   * báo (trang thiếu, trang rỗng giữa chừng) thì `incomplete_list`, phản hồi thành công mà không có danh sách thì
   * `unexpected_response` (review #309 vòng 2 N1; bản sao xoá SKU không thấy nên không được nhận danh sách thiếu). `title` phân biệt được các SKU của cùng một sản phẩm khi sàn cho đọc nhãn biến thể
   * (TikTok: "tên sản phẩm - giá trị thuộc tính bán hàng", #282), kèm `imageUrl` khi có. `labels: false` khi chỉ cần
   * đếm hay không hiển thị: bỏ các lời gọi đọc nhãn, ảnh. `skipSellerSkus`: SKU Commerio bên gọi sẽ ghép theo SKU; sản phẩm
   * mà mọi SKU nằm trong đó không cần nhãn nên adapter không đọc nhãn, ảnh cho nó (`variantLabel`, `imageUrl` null).
   */
  listSkus?(accessToken: string, opts?: { labels?: boolean; skipSellerSkus?: ReadonlySet<string> }): Promise<RemoteSku[]>;
  /**
   * SKU của các sản phẩm sàn ghi nhận sửa từ `since` trở đi (lấy cả mốc), có nhãn biến thể như `listSkus`. Sản phẩm đã
   * xoá (`state: 'deleted'`) trả khi sàn trả trong cùng lời gọi (TikTok); Lazada không gọi thêm `filter=deleted` để giữ hạn
   * mức (review vòng 2 N2), lần đọc trọn mỗi ngày dọn. Cho lượt làm mới bản sao SKU sàn sau đồng bộ listing (#220 đợt 2): rẻ hơn đọc trọn.
   * Sàn không có bộ lọc theo giờ sửa thì không có hàm này (bên gọi đọc trọn).
   */
  listSkusChanged?(accessToken: string, since: Date): Promise<RemoteSku[]>;
  /**
   * Đếm nhanh hàng của gian hàng trên sàn bằng tổng sàn trả, không đọc hết danh sách; cho `remoteProductCount`,
   * `remoteSkuCount` lúc nối (§18.7.4). `productCount`: số sản phẩm chưa xoá trên sàn, bắt buộc. `skuCount`: số SKU của
   * sàn (phân loại; sản phẩm không chia phân loại tính là 1), không tính SKU của sản phẩm đã xoá; `null` khi sàn không trả
   * tổng số SKU và adapter không đọc hết danh sách, không suy từ số sản phẩm. Một hàm trả cả hai số để sàn lấy được cả hai
   * từ cùng một lời gọi (TikTok) không phải gọi hai lần. Adapter không có hàm này thì bên gọi đếm bằng `listSkus`.
   */
  countRemote?(accessToken: string): Promise<RemoteCounts>;
  /**
   * Chỉ SKU có SellerSku trong danh sách (shop thử dùng chung, #104 A4), **kể cả sản phẩm sàn đã xoá** (`state:
   * 'deleted'`) để đồng bộ đưa listing về `delisted` (#219). SellerSku không thấy trên sàn thì không có trong kết quả;
   * bên gọi không coi "vắng" là đã xoá. Sàn trả lý do từ chối thì `rejectReason` có câu đó.
   */
  getSkus(accessToken: string, sellerSkus: readonly string[]): Promise<RemoteSku[]>;
  /** Tự chia lô theo giới hạn của sàn. Token sai ném `unauthorized`; lỗi khác trả theo từng SKU. */
  updatePriceQuantity(accessToken: string, items: readonly PriceQuantity[]): Promise<PerSkuResult[]>;
  /** Tắt (ẩn) sản phẩm trên sàn. Sàn tắt theo cả sản phẩm (TikTok) thì mọi SKU của sản phẩm cùng ẩn. */
  deactivate(accessToken: string, externalProductId: string, externalSkuId: string): Promise<void>;
  /**
   * Hiện lại sản phẩm đã tắt (#224, `hideBy = 'deactivate'`). Sàn có thể đưa sản phẩm vào duyệt lại (TikTok về `PENDING`);
   * trạng thái về qua lần đồng bộ. Sàn chưa có thì không có hàm này.
   */
  activate?(accessToken: string, externalProductId: string, externalSkuId: string): Promise<void>;
  /** Khoản tiền theo đơn trong khoảng ngày `[from, to]` (#117). Sàn chưa hỗ trợ thì không có. */
  getTransactions?(accessToken: string, from: string, to: string): Promise<SettlementTxn[]>;
  /** Các kỳ quyết toán từ ngày `from` (#117). */
  getPayouts?(accessToken: string, from: string): Promise<Payout[]>;
  /**
   * Đơn có cập nhật từ `updatedAfter` (#105). Lật trang bằng con trỏ do adapter giữ (#218): lần đầu `cursor` null, lần
   * sau truyền `nextCursor` của trang trước; `nextCursor` null là hết. Trang có thể rỗng mà vẫn còn con trỏ.
   * - Đơn trả về không giảm theo `updatedAt`, trong trang và qua các trang (bên gọi lấy mốc bằng max `updatedAt`).
   * - Adapter không lật theo offset trần và bỏ đơn trùng giữa các trang, để danh sách đổi trong lúc lật không làm sót đơn.
   * - Chỗ adapter không bảo đảm được thì trả `safeUntil`: mọi đơn có `updatedAt` nhỏ hơn mốc này đã được trả ở trang
   *   này hoặc trước; đơn từ mốc trở đi có thể đã sót. Bên gọi không tiến mốc kéo qua `safeUntil` nhỏ nhất của lượt.
   *   null là không giới hạn.
   */
  listOrders?(
    accessToken: string,
    updatedAfter: Date,
    cursor: string | null,
  ): Promise<{ orders: RemoteOrderRef[]; nextCursor: string | null; safeUntil: Date | null }>;
  /**
   * Đơn **chưa xong** của gian hàng bất kể ngày đặt, cho lượt kéo một lần sau thiết lập (#198, Documents/21 §18.2). Lật
   * trang như `listOrders` (con trỏ, `safeUntil`); thứ tự giữa các trang không ràng buộc, đơn có thể trả hai lần.
   */
  listOpenOrders?(
    accessToken: string,
    cursor: string | null,
  ): Promise<{ orders: RemoteOrderRef[]; nextCursor: string | null; safeUntil: Date | null }>;
  /** Một đơn kèm các món (#105). */
  getOrder?(accessToken: string, externalOrderId: string): Promise<RemoteOrder>;
  /**
   * Nhiều đơn kèm món theo lô (#267): kết quả cùng thứ tự với `refs`, dữ liệu như gọi `getOrder` từng đơn. Adapter tự chia
   * lô theo giới hạn của sàn và dùng `detail` của ref nếu có. Sàn không có thì bên gọi gọi `getOrder` từng đơn.
   */
  getOrders?(accessToken: string, refs: readonly RemoteOrderRef[]): Promise<RemoteOrder[]>;
  /** Lý do huỷ sàn cho phép với các món này; sàn không cho huỷ thì ném `rejected` kèm câu của sàn (#105 PR 2). */
  cancelReasons?(accessToken: string, externalOrderId: string, externalLineIds: readonly string[]): Promise<{ id: string; label: string }[]>;
  /** Người bán huỷ các món; sàn xác nhận sau, đơn về qua lần kéo kế tiếp. */
  cancelOrder?(accessToken: string, externalOrderId: string, externalLineIds: readonly string[], reasonId: string): Promise<void>;
  /**
   * Đồng ý hay từ chối yêu cầu huỷ của khách trên đơn. `rejectReasonId`: lý do từ chối lấy từ `cancelRequestRejectReasons`;
   * sàn bắt buộc lý do khi từ chối (TikTok) mà thiếu thì ném `rejected` `reject_reason_required`, sàn không cần thì bỏ qua.
   */
  decideCancelRequest?(accessToken: string, externalOrderId: string, accept: boolean, rejectReasonId?: string): Promise<void>;
  /** Lý do từ chối yêu cầu huỷ của khách mà sàn cho dùng lúc này (#227). Sàn không đòi lý do thì không có hàm này. */
  cancelRequestRejectReasons?(accessToken: string, externalOrderId: string): Promise<{ id: string; label: string }[]>;
  /**
   * Yêu cầu trả, hoàn tiền của khách có cập nhật từ `updatedAfter` (tính cả mốc), cũ trước (#227, #202). Lật trang như
   * `listOrders`: lần đầu `cursor` null, `nextCursor` null là hết, trang có thể rỗng mà vẫn còn con trỏ.
   */
  listReturns?(accessToken: string, updatedAfter: Date, cursor: string | null): Promise<{ items: RemoteReturn[]; nextCursor: string | null }>;
  /** Lý do người bán dùng được khi từ chối trả hàng hay từ chối hoàn tiền (#202, Documents/21 §20.1). */
  returnReasons?(accessToken: string, externalReturnId: string, action: 'reject' | 'refuse-refund'): Promise<{ id: string; label: string; requiresImage: boolean }[]>;
  /**
   * Người bán quyết yêu cầu trả (#202): `accept` đồng ý trả hàng, `reject` từ chối (cần `reasonId`), `refund` hoàn tiền
   * cho khách giữ hàng. Kết quả về app qua lượt kéo yêu cầu trả kế tiếp.
   */
  decideReturn?(
    accessToken: string,
    externalReturnId: string,
    externalLineIds: readonly string[],
    decision: 'accept' | 'reject' | 'refund',
    /** `kind`: loại yêu cầu (chỉ hoàn tiền đi API riêng ở Lazada); thiếu là `return`. */
    opts: { reasonId?: string; comment?: string; kind?: 'return' | 'refund' },
  ): Promise<void>;
  /** Báo sàn kho đã nhận hàng trả (#202, §20.1 `confirmDelivery`). */
  confirmReturnReceived?(accessToken: string, externalReturnId: string, externalLineIds: readonly string[]): Promise<void>;
  /** Lịch sử đơn ngược phía sàn (#202, §20.1). */
  returnHistory?(
    accessToken: string,
    externalReturnId: string,
    externalLineIds: readonly string[],
  ): Promise<{ at: Date; reverseStatus: string; ofcStatus: string | null; note: string | null }[]>;
  /**
   * Lần huỷ đơn (khách xin huỷ, người bán, sàn huỷ) có cập nhật từ `updatedAfter`, lật trang như `listReturns`. Huỷ không vào
   * bảng yêu cầu trả: khách xin huỷ là cờ `cancel_requested` của đơn (Documents/21 §20.1).
   */
  listCancellations?(
    accessToken: string,
    updatedAfter: Date,
    cursor: string | null,
  ): Promise<{ items: RemoteCancellation[]; nextCursor: string | null }>;
  /**
   * Đơn tách kiện được không (#221). Chỉ sàn tự chia kiện mới có (`splitLevel` khác `none`); TikTok chỉ trả khi đơn đã
   * `AWAITING_SHIPMENT`, trước đó sàn từ chối (`rejected`, vd 21001008).
   */
  splitAttributes?(accessToken: string, externalOrderId: string): Promise<SplitAttributes>;
  /**
   * Tách đơn thành các kiện, mỗi nhóm là mã món (`externalLineId`) vào một kiện mới (#221; app gọi ở #205). Trả mã kiện
   * mới cùng thứ tự với `groups`. Sàn chỉ tách theo SKU (`splitLevel: 'sku'`) thì mọi món cùng SKU phải chung nhóm.
   * Kiện mới về app qua lần kéo đơn kế tiếp (`packageCode` của món đổi).
   */
  splitOrder?(accessToken: string, externalOrderId: string, groups: readonly (readonly string[])[]): Promise<string[]>;
  /**
   * Báo sàn kiện sẵn sàng giao (#221; app gọi ở #239): sàn xếp hãng tới lấy (`pickup`) hay người bán mang ra điểm gửi
   * (`drop_off`); không truyền thì sàn chọn theo cấu hình gian hàng. Trạng thái mới về qua lần kéo đơn kế tiếp.
   */
  shipPackage?(accessToken: string, packageCode: string, opts?: { handover?: 'pickup' | 'drop_off' }): Promise<void>;

  /** Trả danh sách rỗng khi sàn tự chọn nhà vận chuyển. */
  shipmentProviders?(accessToken: string, ref: PackageItemsRef): Promise<{ platformChooses: boolean; items: CarrierOption[] }>;
  /** Đóng gói các món, trả mã kiện sàn mới. */
  packItems?(accessToken: string, ref: PackageItemsRef & { carrierCode?: string }): Promise<PlatformPack>;
  /** Báo các kiện đã sẵn sàng giao. */
  readyToShip?(accessToken: string, packageCodes: readonly string[]): Promise<void>;
  /** Cho phép đóng gói lại một kiện chưa báo giao. */
  repackPackage?(accessToken: string, packageCode: string): Promise<void>;
  /** Mỗi phần tử là một tệp PDF, có thể chứa vận đơn của nhiều kiện. */
  shippingDocuments?(accessToken: string, packageCodes: readonly string[]): Promise<Uint8Array[]>;
}

/** Trạng thái yêu cầu trả của app (Documents/25 §9, Documents/21 §20; enum `sales.return_status`). */
export type RemoteReturnStatus = 'requested' | 'rejected' | 'refund_only' | 'awaiting_return' | 'received' | 'closed';

/** Một món trong yêu cầu trả hay lần huỷ của sàn. Tiền là chuỗi thập phân, trống là null. */
export interface RemoteAftersaleLine {
  /** Mã món của đơn (khớp `order_lines.external_line_id`). */
  externalLineId: string;
  /** Mã dòng đơn ngược của sàn khi khác mã món (Lazada `reverse_order_line_id`, dùng khi quyết trên sàn, #202). */
  externalReturnLineId?: string | null;
  /** Số món của dòng; không có là 1 (mỗi món một dòng). */
  quantity?: number;
  externalSkuId: string | null;
  sellerSku: string | null;
  refundAmount: string | null;
}

/** Phần chung của yêu cầu trả và lần huỷ đã chuẩn hoá. */
interface RemoteAftersale {
  /** Mã yêu cầu trả hay lần huỷ của sàn (app lưu ở `external_return_id`). */
  externalId: string;
  externalOrderId: string;
  /** Trạng thái gốc của sàn, chỉ để hiện (R11). */
  rawStatus: string;
  initiator: 'buyer' | 'seller' | 'platform' | null;
  /** Mã lý do của sàn và câu hiển thị. */
  reasonCode: string | null;
  reason: string | null;
  /** Tổng tiền hoàn cho khách theo sàn; null khi sàn chưa trả. */
  refundAmount: string | null;
  lines: RemoteAftersaleLine[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Yêu cầu trả, hoàn tiền của sàn (#227). `status` là trạng thái yêu cầu trả của app mà trạng thái sàn tương ứng; null khi
 * app chưa có luồng (đổi hàng). `closed` chỉ do khách rút hay sàn tự đóng (`closeResult = 'buyer_cancelled'`); đóng sau khi
 * kiểm hàng hoàn là việc của app. Máy trạng thái của #202 quyết định có chuyển được không.
 */
export interface RemoteReturn extends RemoteAftersale {
  /** `return`: khách gửi trả hàng rồi mới hoàn tiền; `refund`: chỉ hoàn tiền; `replacement`: đổi hàng, đổi biến thể. */
  kind: 'return' | 'refund' | 'replacement';
  status: RemoteReturnStatus | null;
  closeResult: 'buyer_cancelled' | null;
  /** Sàn đang phân xử khiếu nại. */
  disputeInProgress: boolean;
  returnTrackingCode: string | null;
  /** Hạn người bán phải trả lời, null khi không chờ người bán. */
  respondBy: Date | null;
  /** Trạng thái vận chuyển chiều về của sàn (Lazada `ofc_status`), chỉ để hiện (#202). */
  ofcStatus?: string | null;
  /** Hàng trả về kho sàn hay về người bán (Lazada `return_to_type`/`is_rtm`). */
  returnTo?: 'warehouse' | 'merchant' | null;
}

/**
 * Lần huỷ của sàn (#227). `pending`: chờ duyệt (khách xin huỷ: đơn bật `cancel_requested`; người bán huỷ: `cancelling`);
 * `cancelled`: sàn đã huỷ; `withdrawn`: khách rút hay người bán từ chối, bỏ cờ. null khi sàn trả giá trị lạ.
 */
export interface RemoteCancellation extends RemoteAftersale {
  /** Khách xin huỷ, người bán phải trả lời; false là huỷ thẳng (người bán, sàn). */
  buyerRequest: boolean;
  status: 'pending' | 'cancelled' | 'withdrawn' | null;
  respondBy: Date | null;
}

/**
 * Lỗi khi gọi sàn, đã phân loại (Documents/21 §1.1 R8, R9). `platformCode`, `platformMessage` là mã và câu gốc của sàn.
 * - `unavailable`: lỗi tạm (mạng, 5xx, sàn quá tải), thử lại được.
 * - `unauthorized`: token sai hoặc hết hạn: gian hàng cần nối lại.
 * - `rejected`: sàn từ chối, chưa có mã riêng.
 * - `unsupported`: sàn chưa cấu hình hoặc không có năng lực này.
 */
export type MarketplaceErrorKind = 'unavailable' | 'unauthorized' | 'rejected' | 'unsupported';

export class MarketplaceError extends Error {
  readonly kind: MarketplaceErrorKind;
  readonly platformCode: string | null;
  readonly platformMessage: string | null;

  constructor(kind: MarketplaceErrorKind, platformCode: string | null = null, platformMessage: string | null = null) {
    super(`Sàn trả lỗi ${kind}${platformCode ? ` (${platformCode})` : ''}`);
    this.name = 'MarketplaceError';
    this.kind = kind;
    this.platformCode = platformCode;
    this.platformMessage = platformMessage;
  }
}

/**
 * Kết quả xin một lượt trong hạn mức gọi sàn trước mỗi request (#102, #215): `ok`, hết trần chung của app
 * (`daily_call_limit`), hoặc hết phần của công ty (`company_call_limit`, Documents/21 §18.6.8).
 */
export type CallReservation = 'ok' | 'daily_call_limit' | 'company_call_limit';
export type ReserveCall = () => Promise<CallReservation>;

/** Xin lượt trước khi gọi mạng; hết lượt thì ném `unavailable` kèm mã hết lượt, không gọi mạng. */
export async function reserveOrThrow(reserveCall: ReserveCall | undefined, platformName: string): Promise<void> {
  const outcome = reserveCall ? await reserveCall() : 'ok';
  if (outcome === 'ok') return;
  const message =
    outcome === 'company_call_limit'
      ? `Công ty đã dùng hết phần hạn mức gọi ${platformName} hôm nay`
      : `Đã dùng hết hạn mức gọi ${platformName} trong ngày`;
  throw new MarketplaceError('unavailable', outcome, message);
}
