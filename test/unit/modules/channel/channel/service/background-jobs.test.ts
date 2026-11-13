import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../../../../../src/modules/channel/channel');
const allowed = 'service/background-jobs.ts';

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

// #215: việc nền của channel phải đăng ký qua `workChannelQueue`, `registerChannelConsumer` để chạy dưới `inBackground`
// (tới 100% phần hạn mức công ty); gọi thẳng `workQueue`, `registerConsumer` của core thì handler bị tính là bấm tay.
describe('channel đăng ký việc nền qua background-jobs.ts', () => {
  it('không file nào khác trong channel gọi thẳng workQueue hay registerConsumer của core', () => {
    const offenders = tsFiles(root)
      .map((file) => ({ file: relative(root, file).split(sep).join('/'), src: readFileSync(file, 'utf8') }))
      .filter(({ file, src }) => file !== allowed && /\b(workQueue|registerConsumer)\s*\(/.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('index.ts có đăng ký việc nền và chỉ qua hai hàm bọc', () => {
    const src = readFileSync(join(root, 'index.ts'), 'utf8');
    expect(src).toMatch(/workChannelQueue\(/);
    expect(src).toMatch(/registerChannelConsumer\(/);
  });
});
