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
    opts: { reasonId?: string; comment?: string; kind?: 'return' | 'refund' },
  ): Promise<void>;
  confirmReceived(companyId: string, shopId: string, externalReturnId: string, externalLineIds: readonly string[]): Promise<void>;
  history(
    companyId: string,
    shopId: string,
    externalReturnId: string,
    externalLineIds: readonly string[],
  ): Promise<{ at: string; reverseStatus: string; ofcStatus: string | null; note: string | null }[]>;
}
