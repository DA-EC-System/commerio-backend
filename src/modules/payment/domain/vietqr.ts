// Chuỗi VietQR động (EMVCo QR, chuẩn NAPAS) để khách quét chuyển khoản (QT-37; plan #23 A11, A12). Thuần, không I/O.
// Thuật toán CRC đã kiểm trên chuỗi VietQR thật do ZaloPay sandbox trả (ground-truth S11).
import type { Decimal } from 'decimal.js';

export interface VietQrTransfer {
  bankBin: string;
  accountNo: string;
  /** Số nguyên đồng. */
  amount: Decimal;
  /** Nội dung chuyển khoản: mã thanh toán. */
  content: string;
}

const NAPAS_GUID = 'A000000727';
const TO_ACCOUNT = 'QRIBFTTA';

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC16-CCITT (đa thức 0x1021, khởi đầu 0xFFFF), 4 ký tự hex in hoa. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(data, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildVietQr(t: VietQrTransfer): string {
  const merchant = tlv('00', NAPAS_GUID) + tlv('01', tlv('00', t.bankBin) + tlv('01', t.accountNo)) + tlv('02', TO_ACCOUNT);
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('38', merchant) +
    tlv('53', '704') +
    tlv('54', t.amount.toFixed(0)) +
    tlv('58', 'VN') +
    tlv('62', tlv('08', t.content)) +
    '6304';
  return body + crc16(body);
}

function fields(data: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let i = 0; i < data.length; ) {
    const len = Number(data.slice(i + 2, i + 4));
    if (!/^\d{4}$/.test(data.slice(i, i + 4)) || i + 4 + len > data.length) return null;
    out.set(data.slice(i, i + 2), data.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

/** Giải chuỗi VietQR (đọc lại `bankTransfer` từ `qr_content`, plan A12); `null` khi không phải VietQR NAPAS. */
export function parseVietQr(qr: string): { bankBin: string; accountNo: string; amount: string; content: string } | null {
  const top = fields(qr);
  const merchant = fields(top?.get('38') ?? '');
  const account = fields(merchant?.get('01') ?? '');
  if (!top || !merchant || !account || merchant.get('00') !== NAPAS_GUID) return null;
  const extra = fields(top.get('62') ?? '');
  return {
    bankBin: account.get('00') ?? '',
    accountNo: account.get('01') ?? '',
    amount: top.get('54') ?? '',
    content: extra?.get('08') ?? '',
  };
}
