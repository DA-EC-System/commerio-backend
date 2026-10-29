import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '#src/modules/insight/report/domain/csv.ts';

describe('CSV (plan #29 A9)', () => {
  it('BOM UTF-8, xuống dòng CRLF, tiếng Việt giữ nguyên', () => {
    const buf = toCsv([
      ['Gian hàng', 'Doanh thu'],
      ['Đồ gia dụng', 1000],
    ]);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.subarray(3).toString('utf8')).toBe('Gian hàng,Doanh thu\r\nĐồ gia dụng,1000\r\n');
  });

  it('bọc ô có dấu phẩy, ngoặc kép, xuống dòng; nhân đôi ngoặc kép; số âm, null', () => {
    expect(csvCell('A, B')).toBe('"A, B"');
    expect(csvCell('Shop "Xịn"')).toBe('"Shop ""Xịn"""');
    expect(csvCell('dòng 1\ndòng 2')).toBe('"dòng 1\ndòng 2"');
    expect(csvCell(-5000)).toBe('-5000');
    expect(csvCell(null)).toBe('');
  });

  it('chặn công thức khi mở bằng Excel: ô chữ bắt đầu bằng = + - @, Tab được thêm dấu nháy', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
  });
});
