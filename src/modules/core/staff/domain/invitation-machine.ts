// Máy trạng thái lời mời (#7 [C], spec 6.4). Câu UPDATE có điều kiện ở repository là nguồn sự thật cuối;
// bảng này để test và để service đọc cho rõ.

export const INVITATION_STATUSES = ['open', 'claimed', 'pending', 'approved', 'rejected'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * - `open → open`, `claimed → claimed`: xin lại mã OTP.
 * - `open | claimed → claimed`: nhập đúng mã.
 * - `claimed → pending`: nộp (đặt mật khẩu hoặc đăng nhập tài khoản đã có).
 * - `pending → approved | rejected`: Admin duyệt; hết hạn link không chặn.
 */
export const TRANSITIONS: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>> = {
  open: ['open', 'claimed'],
  claimed: ['claimed', 'pending'],
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function canTransition(from: InvitationStatus, to: InvitationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** `expired` không lưu: suy ra từ `expiresAt`, chỉ khi người được mời còn đang làm (`open`, `claimed`). */
export function isLinkExpired(row: { status: InvitationStatus; expiresAt: Date }, now: Date): boolean {
  return (row.status === 'open' || row.status === 'claimed') && row.expiresAt.getTime() <= now.getTime();
}
