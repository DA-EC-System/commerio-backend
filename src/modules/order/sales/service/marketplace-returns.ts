// Tách khỏi returns.ts để orders.ts (SalesContext) không import vòng.
/** Thao tác yêu cầu trả trên sàn của channel; gọi ngoài giao dịch, lỗi sàn đã là `AppError` (R8, R9). */
export interface MarketplaceReturns {
  reasons(
    companyId: string,
    shopId: string,
    externalReturnId: string,
    action: 'reject' | 'refuse-refund',
  ): Promise<{ id: string; label: string; requiresImage: boolean }[]>;
  decide(
    companyId: string,
    shopId: string,
    externalReturnId: string,
    externalLineIds: readonly string[],
    decision: 'accept' | 'reject' | 'refund',
    /**
     * `images`: ảnh minh chứng khi từ chối (#437), `url` là link ký sẵn của kho tệp, chỉ dùng ngay để đưa ảnh lên sàn.
     * Sàn không nhận ảnh trong bước này thì bỏ qua ảnh. Kiểu ảnh sàn không nhận: 422 `validation_failed` ở `attachmentIds`.
     */
    opts: { reasonId?: string; comment?: string; kind?: 'return' | 'refund'; images?: readonly { name: string; url: string; contentType: string }[] },
  ): Promise<{ platformImages: string[] }>;
  confirmReceived(companyId: string, shopId: string, externalReturnId: string, externalLineIds: readonly string[]): Promise<void>;
  history(
    companyId: string,
    shopId: string,
    externalReturnId: string,
    externalLineIds: readonly string[],
  ): Promise<{ at: string; reverseStatus: string; ofcStatus: string | null; note: string | null }[]>;
}
