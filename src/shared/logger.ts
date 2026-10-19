import { pino, type DestinationStream, type Logger } from 'pino';
import { env } from './config/env.ts';

const HIDDEN = '[ẩn]';

// Query string của webhook mang chữ ký cổng (vnp_SecureHash…), đường dẫn SePay mang khoá nhận webhook.
const hideUrlSecrets = (url: string) => url.split('?')[0]!.replace(/(\/webhooks\/sepay\/)[^/]+/i, `$1${HIDDEN}`);

// Lỗi Drizzle ghi `\nparams: <tham số>` vào message và stack; tham số có thể nhiều dòng nên cắt tới hết
// message, và trong stack (có thể gồm stack của lỗi lồng) cắt mỗi đoạn tới dòng `    at ` kế tiếp.
const hideQueryParams = (text: string, key: string) =>
  key === 'stack' ? text.replace(/\nparams: [\s\S]*?(?=\n {4}at |$)/g, '') : text.replace(/\nparams: [\s\S]*$/, '');

/** Che một giá trị theo đường dẫn khoá; trả `undefined` thì khoá biến mất khỏi dòng log. */
function censor(value: unknown, path: string[]): unknown {
  const key = path.at(-1);
  if (path[0] === 'err') {
    // `detail` của lỗi PostgreSQL chép giá trị dòng vi phạm, vd `Key (email)=(…)`.
    if (key === 'params' || key === 'detail') return undefined;
    return typeof value === 'string' && key ? hideQueryParams(value, key) : value;
  }
  if (key === 'query') return undefined;
  if (key === 'url') return typeof value === 'string' ? hideUrlSecrets(value) : value;
  return HIDDEN;
}

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    // Không ghi token, cookie, chữ ký và khoá webhook, tham số câu SQL vào log.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.url',
        'req.query',
        'err.params',
        'err.detail',
        'err.message',
        'err.stack',
      ],
      censor,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
