import { describe, expect, it, vi } from 'vitest';
import { INVALID_AMOUNT, MarketplaceError } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { settlementPayouts, settlementTransactions } from '#src/modules/channel/channel/service/settlement-port.ts';
import { shopSession } from '#src/modules/channel/channel/service/shops.ts';

vi.mock('#src/shared/db/client.ts', () => ({ withCompany: (_id: string, fn: () => unknown) => fn(), currentCompanyId: () => null }));
vi.mock(import('#src/modules/channel/channel/service/shops.ts'), async (original) => ({
  ...(await original()),
  shopSession: vi.fn(),
}));

const SENTENCE = 'Không đọc được số tiền sàn trả về. Đã báo kỹ thuật, thử lại sau.';
const badAmount = (): never => {
  throw new MarketplaceError('rejected', INVALID_AMOUNT, 'Số tiền sàn trả không đọc được (amount, giao dịch TX1): "1.600,02"');
};
const session = (adapter: object) => vi.mocked(shopSession).mockResolvedValue({ adapter, accessToken: 't' } as never);

describe('cổng quyết toán: sàn trả số tiền không đọc được (#349)', () => {
  it('getTransactions trả số hỏng: 502 marketplace_invalid_amount, câu cho người dùng, giữ chi tiết cho kỹ thuật', async () => {
    session({ getTransactions: async () => badAmount() });
    await expect(settlementTransactions('c', 's', '2026-10-01', '2026-10-31')).rejects.toMatchObject({
      status: 502,
      code: 'marketplace_invalid_amount',
      message: SENTENCE,
      extensions: { platformCode: 'invalid_amount', platformMessage: expect.stringContaining('TX1') },
    });
  });

  it('getPayouts trả số hỏng: cùng lỗi 502', async () => {
    session({ getPayouts: async () => badAmount() });
    await expect(settlementPayouts('c', 's', '2026-10-01')).rejects.toMatchObject({ status: 502, code: 'marketplace_invalid_amount' });
  });

  it('mã rejected khác vẫn là 409 marketplace_rejected', async () => {
    session({
      getTransactions: async () => {
        throw new MarketplaceError('rejected', 'E1', 'x');
      },
    });
    await expect(settlementTransactions('c', 's', '2026-10-01', '2026-10-31')).rejects.toMatchObject({ status: 409, code: 'marketplace_rejected' });
  });
});
