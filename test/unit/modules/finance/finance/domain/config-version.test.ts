import { describe, expect, it } from 'vitest';
import { AppError } from '#src/shared/errors/app-error.ts';
import { assertTransition } from '#src/modules/core/index.ts';
import {
  addDays,
  configMachine,
  type DatedVersion,
  parsePayload,
  pickEffective,
  placeInTimeline,
  vnDate,
} from '#src/modules/finance/finance/domain/config-version.ts';

const all = ['finance.config.manage', 'finance.config.approve'];
const actor = (accountId: string, permissions = all) => ({ accountId, permissions, enabledModules: ['finance'] });
const record = (over: Partial<{ createdBy: string; effectiveFrom: string; today: string }> = {}) => ({
  createdBy: 'author',
  effectiveFrom: '2026-11-10',
  today: '2026-11-02',
  ...over,
});
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? `${err.status} ${err.code}` : String(err);
  }
  return 'ok';
};

describe('nội dung cấu hình theo loại', () => {
  it('phí sàn đủ bốn mức phần trăm và phí hoàn hàng thì hợp lệ', () => {
    const r = parsePayload('fee', { fixedPct: 4, transactionPct: 2.5, servicePct: 1.2, optionalPct: 0, returnFee: 15000 });
    expect(r.success).toBe(true);
  });

  it('từ chối phần trăm ngoài 0–100, quá hai chữ số thập phân, phí hoàn hàng lẻ đồng, trường lạ', () => {
    const ok = { fixedPct: 4, transactionPct: 2, servicePct: 0, optionalPct: 0, returnFee: 0 };
    expect(parsePayload('fee', { ...ok, fixedPct: 101 }).success).toBe(false);
    expect(parsePayload('fee', { ...ok, fixedPct: 1.234 }).success).toBe(false);
    expect(parsePayload('fee', { ...ok, returnFee: 1.5 }).success).toBe(false);
    expect(parsePayload('fee', { ...ok, extra: 1 }).success).toBe(false);
  });

  it('loại hình thuế chỉ nhận công ty, hộ kinh doanh, cá nhân', () => {
    expect(parsePayload('tax_regime', { regime: 'household' }).success).toBe(true);
    expect(parsePayload('tax_regime', { regime: 'partnership' }).success).toBe(false);
  });

  it('ngưỡng lệch cần số tuyệt đối, phần trăm và hạn mức tự chốt', () => {
    expect(parsePayload('mismatch_threshold', { abs: 5000, pct: 1, resolveLimit: 200000 }).success).toBe(true);
    expect(parsePayload('mismatch_threshold', { abs: 5000, pct: 1 }).success).toBe(false);
  });
});

describe('máy trạng thái phiên bản cấu hình (§21.4)', () => {
  it('người soạn gửi duyệt; người khác có quyền duyệt thì sang chờ hiệu lực', () => {
    expect(assertTransition(configMachine, 'draft', 'submit', { actor: actor('author'), record: record() }).to).toBe('pending_approval');
    expect(assertTransition(configMachine, 'pending_approval', 'approve', { actor: actor('ceo'), record: record() })).toEqual({
      to: 'scheduled',
      selfApproved: false,
    });
  });

  it('người soạn tự duyệt bị chặn, trừ khi được tự duyệt (CEO, công ty một người)', () => {
    const ctx = { actor: actor('author'), record: record() };
    expect(codeOf(() => assertTransition(configMachine, 'pending_approval', 'approve', ctx))).toBe('409 second_person_required');
    expect(assertTransition(configMachine, 'pending_approval', 'approve', { ...ctx, canSelfApprove: true }).selfApproved).toBe(true);
  });

  it('trả về và từ chối cần người thứ hai và lý do, không có ngoại lệ tự duyệt', () => {
    const own = { actor: actor('author'), record: record(), reason: 'sai mức phí', canSelfApprove: true };
    expect(codeOf(() => assertTransition(configMachine, 'pending_approval', 'reject', own))).toBe('409 second_person_required');
    expect(codeOf(() => assertTransition(configMachine, 'pending_approval', 'reject', { actor: actor('ceo'), record: record() }))).toBe(
      '422 reason_required',
    );
    expect(
      assertTransition(configMachine, 'pending_approval', 'request_changes', { actor: actor('ceo'), record: record(), reason: 'sửa ngày' }).to,
    ).toBe('draft');
  });

  it('thiếu quyền duyệt thì 403 dù khác người soạn', () => {
    const admin = actor('admin', ['finance.config.manage']);
    expect(codeOf(() => assertTransition(configMachine, 'pending_approval', 'approve', { actor: admin, record: record() }))).toBe(
      '403 forbidden',
    );
  });

  it('huỷ được trước ngày hiệu lực, tới ngày thì 409 config_already_effective', () => {
    const ctx = (effectiveFrom: string) => ({ actor: actor('author'), record: record({ effectiveFrom }) });
    expect(assertTransition(configMachine, 'scheduled', 'cancel', ctx('2026-11-10')).to).toBe('cancelled');
    expect(codeOf(() => assertTransition(configMachine, 'scheduled', 'cancel', ctx('2026-11-02')))).toBe('409 config_already_effective');
  });

  it('áp dụng, hết hiệu lực chỉ hệ thống làm; người dùng gọi thì 409 invalid_transition', () => {
    expect(assertTransition(configMachine, 'scheduled', 'activate', { actor: null }).to).toBe('active');
    expect(assertTransition(configMachine, 'active', 'expire', { actor: null }).to).toBe('expired');
    expect(codeOf(() => assertTransition(configMachine, 'scheduled', 'activate', { actor: actor('ceo') }))).toBe('409 invalid_transition');
  });

  it('chuyển ngoài bảng bị chặn: duyệt bản nháp, gửi lại bản đang áp dụng, huỷ bản đã hết hiệu lực', () => {
    const ctx = { actor: actor('ceo'), record: record() };
    expect(codeOf(() => assertTransition(configMachine, 'draft', 'approve', ctx))).toBe('409 invalid_transition');
    expect(codeOf(() => assertTransition(configMachine, 'active', 'submit', ctx))).toBe('409 invalid_transition');
    expect(codeOf(() => assertTransition(configMachine, 'expired', 'cancel', ctx))).toBe('409 invalid_transition');
  });
});

const v = (id: string, status: DatedVersion['status'], effectiveFrom: string, effectiveTo: string | null = null, supersedesId: string | null = null) => ({
  id,
  status,
  effectiveFrom,
  effectiveTo,
  supersedesId,
});

describe('chọn phiên bản theo ngày', () => {
  const versions = [v('a', 'expired', '2026-10-01', '2026-10-31'), v('b', 'active', '2026-11-01'), v('c', 'scheduled', '2026-12-01')];

  it('lấy bản đã áp dụng có khoảng ngày chứa ngày cần tính', () => {
    expect(pickEffective(versions, '2026-10-15')?.id).toBe('a');
    expect(pickEffective(versions, '2026-11-01')?.id).toBe('b');
    expect(pickEffective(versions, '2026-12-05')?.id).toBe('b');
  });

  it('trước bản đầu tiên thì không có; bản chưa tới ngày (scheduled) không được chọn', () => {
    expect(pickEffective(versions, '2026-09-30')).toBeUndefined();
  });

  it('bản sửa lỗi cùng ngày hiệu lực thay bản bị sửa', () => {
    const fixed = [v('a', 'expired', '2026-10-01', '2026-10-01'), v('a2', 'active', '2026-10-01', null, 'a')];
    expect(pickEffective(fixed, '2026-10-01')?.id).toBe('a2');
  });
});

describe('xếp bản mới vào dòng thời gian của ô', () => {
  it('bản đứng trước kết thúc trước ngày bản mới; bản mới kết thúc trước bản đứng sau', () => {
    const live = [v('a', 'active', '2026-11-01'), v('c', 'scheduled', '2026-12-01')];
    const placed = placeInTimeline(live, { effectiveFrom: '2026-11-15', supersedesId: null });
    expect(placed).toEqual({ overlap: false, predecessor: live[0], effectiveTo: '2026-11-30' });
  });

  it('trùng ngày hiệu lực là overlap, trừ khi là bản sửa lỗi của chính bản đó', () => {
    const live = [v('a', 'active', '2026-11-01')];
    expect(placeInTimeline(live, { effectiveFrom: '2026-11-01', supersedesId: null })).toEqual({ overlap: true });
    expect(placeInTimeline(live, { effectiveFrom: '2026-11-01', supersedesId: 'a' })).toEqual({
      overlap: false,
      predecessor: undefined,
      effectiveTo: null,
    });
  });
});

describe('ngày theo giờ Việt Nam', () => {
  it('17:00 UTC đã sang ngày hôm sau ở Việt Nam', () => {
    expect(vnDate(new Date('2026-10-31T16:59:00Z'))).toBe('2026-10-31');
    expect(vnDate(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01');
  });

  it('cộng trừ ngày qua đầu tháng', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
