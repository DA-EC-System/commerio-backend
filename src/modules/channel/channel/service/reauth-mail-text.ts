// Nội dung thư báo gian hàng sắp hết hoặc đã mất uỷ quyền (#312). Văn bản thường, tiếng Việt. Không có token, mã uỷ
// quyền hay số tiền: hàm chỉ nhận tên, sàn, mốc thời gian và id gian hàng.
import type { ReauthMailStage } from '../domain/reauth-mail.ts';

const PLATFORM_NAMES: Record<string, string> = { lazada: 'Lazada', shopee: 'Shopee', tiktok: 'TikTok Shop', mock: 'Sàn thử' };
const VN_OFFSET_MS = 7 * 3600_000;

/** Tên gian hàng lấy từ sàn: gộp xuống dòng thành khoảng trắng để không chen dòng lạ vào thư. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:mm dd/MM/yyyy` giờ Việt Nam (UTC+7, không đổi giờ theo mùa), không phụ thuộc múi giờ của máy chủ. */
export function vnTime(at: Date): string {
  const d = new Date(at.getTime() + VN_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

export interface ReauthMailInput {
  stage: ReauthMailStage;
  shopId: string;
  shopName: string;
  platform: string;
  /** Hạn uỷ quyền (`authDeadline`), null khi token dán tay không có hạn. */
  authDeadline: Date | null;
  /** Lúc chuyển sang `needs_reauth`, chỉ có ở thư `lost`. */
  lostAt: Date | null;
  /** `PUBLIC_WEB_URL`; chưa đặt thì thư chỉ ghi đường dẫn trong app. */
  webUrl: string | undefined;
}

export function renderReauthMail(input: ReauthMailInput): { subject: string; text: string } {
  const shop = oneLine(input.shopName);
  const platform = PLATFORM_NAMES[input.platform] ?? input.platform;
  const path = `/channel/shops/${input.shopId}`;
  const link = input.webUrl ? `${input.webUrl.replace(/\/+$/, '')}${path}` : null;
  const lost = input.stage === 'lost';
  const subject = lost
    ? `[Commerio] Gian hàng ${shop} (${platform}) đã mất uỷ quyền, cần kết nối lại`
    : `[Commerio] Gian hàng ${shop} (${platform}) sắp hết uỷ quyền`;
  const when = lost
    ? [`Mất uỷ quyền lúc: ${input.lostAt ? vnTime(input.lostAt) : 'không rõ'} (giờ Việt Nam)`]
    : [];
  const deadline = input.authDeadline ? [`Hạn uỷ quyền: ${vnTime(input.authDeadline)} (giờ Việt Nam)`] : [];
  const consequence = lost
    ? 'Trong lúc chưa kết nối lại:'
    : 'Nếu không kết nối lại trước hạn, gian hàng sẽ mất uỷ quyền và:';
  return {
    subject,
    text: [
      'Chào anh/chị,',
      '',
      lost
        ? `Gian hàng ${shop} trên ${platform} đã mất uỷ quyền với sàn.`
        : `Uỷ quyền của gian hàng ${shop} trên ${platform} sắp hết hạn.`,
      '',
      `Gian hàng: ${shop}`,
      `Sàn: ${platform}`,
      ...deadline,
      ...when,
      '',
      consequence,
      '- Đơn mới của gian hàng này không về Commerio.',
      '- Tồn của các sản phẩm bán ở gian hàng này tạm ngừng cập nhật lên các gian hàng khác, để không bán vượt.',
      '',
      link ? `Kết nối lại tại: ${link}` : `Kết nối lại: mở Commerio, vào trang gian hàng ${path}.`,
      '',
      lost ? 'Thư này nhắc lại mỗi 6 giờ tới khi gian hàng được kết nối lại hoặc bị ngắt.' : '',
      'Commerio',
    ]
      .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
      .join('\n'),
  };
}
