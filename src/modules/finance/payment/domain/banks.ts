// Tên ngân hàng theo mã BIN NAPAS cho VietQR (plan #23 A5). Thuần, không I/O.
// Chỉ các ngân hàng hay dùng; BIN khác vẫn lưu được, tên hiện bằng chính BIN.
const BANK_NAMES: Readonly<Record<string, string>> = {
  '970422': 'MB Bank',
  '970436': 'Vietcombank',
  '970415': 'VietinBank',
  '970418': 'BIDV',
  '970416': 'ACB',
  '970423': 'TPBank',
  '970407': 'Techcombank',
  '970432': 'VPBank',
  '970403': 'Sacombank',
  '970448': 'OCB',
  '970426': 'MSB',
  '970452': 'KienlongBank',
};

export function bankNameOf(bankBin: string): string {
  return BANK_NAMES[bankBin] ?? bankBin;
}
