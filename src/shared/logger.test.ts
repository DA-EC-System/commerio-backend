import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';

describe('logger', () => {
  it('ẩn header Authorization, Cookie, Set-Cookie', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line: string) => void lines.push(line) });
    log.level = 'info';

    log.info({
      req: { headers: { authorization: 'Bearer bimat', cookie: 'sid=bimat' } },
      res: { headers: { 'set-cookie': 'sid=bimat' } },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('bimat');
    expect(lines[0]).toContain('[ẩn]');
  });
});
