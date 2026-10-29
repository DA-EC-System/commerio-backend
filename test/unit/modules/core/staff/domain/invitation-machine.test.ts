import { describe, expect, it } from 'vitest';
import {
  canTransition,
  INVITATION_STATUSES,
  type InvitationStatus,
  isLinkExpired,
} from '#src/modules/core/staff/domain/invitation-machine.ts';

// Bảng chuyển trạng thái của spec #7 mục 6.4.
const ALLOWED: readonly [InvitationStatus, InvitationStatus][] = [
  ['open', 'open'],
  ['claimed', 'claimed'],
  ['open', 'claimed'],
  ['claimed', 'pending'],
  ['pending', 'approved'],
  ['pending', 'rejected'],
];

describe('máy trạng thái lời mời', () => {
  it('đủ năm trạng thái', () => {
    expect([...INVITATION_STATUSES].sort()).toEqual(['approved', 'claimed', 'open', 'pending', 'rejected']);
  });

  for (const from of INVITATION_STATUSES) {
    for (const to of INVITATION_STATUSES) {
      const allowed = ALLOWED.some(([f, t]) => f === from && t === to);
      it(`${from} → ${to}: ${allowed ? 'được' : 'không được'}`, () => {
        expect(canTransition(from, to)).toBe(allowed);
      });
    }
  }

  it('approved, rejected là trạng thái cuối', () => {
    for (const to of INVITATION_STATUSES) {
      expect(canTransition('approved', to)).toBe(false);
      expect(canTransition('rejected', to)).toBe(false);
    }
  });
});

describe('link hết hạn', () => {
  const expiresAt = new Date('2026-10-24T00:00:00.000Z');

  it('open, claimed: hết hạn từ đúng mốc expiresAt', () => {
    for (const status of ['open', 'claimed'] as const) {
      expect(isLinkExpired({ status, expiresAt }, new Date('2026-10-23T23:59:59.999Z'))).toBe(false);
      expect(isLinkExpired({ status, expiresAt }, expiresAt)).toBe(true);
    }
  });

  it('đã nộp, đã duyệt, đã từ chối thì không tính hết hạn (Review Focus 4)', () => {
    const later = new Date('2026-11-30T00:00:00.000Z');
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      expect(isLinkExpired({ status, expiresAt }, later)).toBe(false);
    }
  });
});
