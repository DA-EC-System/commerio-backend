import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// `allowShrink` đi từ việc xuống `syncTree`; lượt bị chặn vì cây thiếu log `error` kèm số node bỏ, tổng node (#400, Thành chốt
// 19/11/2026). Luật ngưỡng (`treeShrinkBlocked`) và ghi cây là của repository, test ở integration của BE1.
const syncTree = vi.fn();
vi.mock('#src/modules/channel/channel/repository/platform-categories.ts', async (orig) => ({
  ...(await orig<object>()),
  syncTree: (...args: unknown[]) => syncTree(...args),
}));

// Trạng thái đồng bộ cây ghi DB (#569); unit test không có DB nên thay bằng hàm rỗng.
vi.mock('#src/modules/channel/channel/repository/category-sync-state.ts', async (orig) => ({
  ...(await orig<object>()),
  setTreeSyncState: async () => undefined,
}));

const { CategoryTreeShrunkError } = await import('#src/modules/channel/channel/repository/platform-categories.ts');
const { runCategorySync } = await import('#src/modules/channel/channel/service/category-sync.ts');
const { registerAdapter, resetAdapters } = await import('#src/modules/channel/channel/service/marketplaces/index.ts');
const { logger } = await import('#src/shared/logger.ts');

const tree = [{ externalId: '1', parentExternalId: null, name: 'Gốc', isLeaf: true, path: 'Gốc' }];
registerAdapter('shopee', { categoriesNeedToken: false, categoryTree: async () => tree } as never);
afterEach(() => {
  vi.restoreAllMocks();
  syncTree.mockReset();
});

describe('runCategorySync: allowShrink', () => {
  it('truyền cờ của việc xuống syncTree (vắng là false)', async () => {
    syncTree.mockResolvedValue({ upserted: 1, removed: 0, specsRemoved: 0, specsRestored: 0, skipped: false });
    await runCategorySync({ platform: 'shopee', allowShrink: true });
    expect(syncTree).toHaveBeenLastCalledWith('shopee', tree, expect.any(Date), { allowShrink: true });
    await runCategorySync({ platform: 'shopee' });
    expect(syncTree).toHaveBeenLastCalledWith('shopee', tree, expect.any(Date), { allowShrink: false });
  });

  it('cây thiếu: log error kèm số node sắp bỏ, tổng node, số node nhận; ném để lượt hỏng', async () => {
    syncTree.mockRejectedValue(new CategoryTreeShrunkError('shopee', 200, 40));
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(runCategorySync({ platform: 'shopee' })).rejects.toBeInstanceOf(CategoryTreeShrunkError);
    expect(error).toHaveBeenCalledWith({ platform: 'shopee', active: 200, removing: 40, received: 1 }, expect.any(String));
  });
});
afterAll(() => resetAdapters());
