import { describe, expect, it } from 'vitest';
import type { ListingStatus } from '#src/modules/channel/channel/domain/listing.ts';
import { presenceOf } from '#src/modules/channel/channel/domain/presence.ts';

// Hiện diện của SKU trên sàn (#204 D8, Thành sửa 16/11/2026 theo Documents/25 §5.1): live > error > pending > not_listed.
describe('presenceOf', () => {
  const cases: [ListingStatus[], string, boolean][] = [
    [[], 'not_listed', false],
    [['live'], 'live', false],
    [['live', 'rejected'], 'live', true],
    [['live', 'push_failed', 'pushing'], 'live', true],
    [['rejected'], 'error', true],
    [['push_failed'], 'error', true],
    [['platform_hold'], 'error', true],
    [['platform_hold', 'pushing'], 'error', true],
    [['pushing'], 'pending', false],
    [['under_review', 'hidden'], 'pending', false],
    [['hidden'], 'not_listed', false],
    [['delisted'], 'not_listed', false],
    [['delisted', 'hidden'], 'not_listed', false],
  ];

  it.each(cases)('%j → %s, hasListingError %s', (statuses, presence, hasListingError) => {
    expect(presenceOf(statuses)).toEqual({ presence, hasListingError });
  });
});
