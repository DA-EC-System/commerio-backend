// Tải ảnh nguồn từ URL người dùng đưa (sàn chỉ nhận file, vd TikTok upload-product-image-202309) mà không mở đường SSRF:
// chỉ http(s), host phải phân giải ra địa chỉ công khai, và kết nối **ghim** đúng địa chỉ đã kiểm (lookup tuỳ biến của
// `node:http(s)`), nên DNS đổi giữa lúc kiểm và lúc nối (DNS rebinding) không lừa được. Kiểm lại ở mỗi lần chuyển hướng.
// Đọc body dạng stream có trần, vượt thì huỷ, kể cả khi không có `content-length`.
import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { MarketplaceError } from './common.ts';

/** Ảnh tối đa 10MB (upload-product-image-202309). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface ImageSourceOptions {
  /** Phân giải tên miền (mặc định DNS hệ thống, mọi địa chỉ); test thay. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Địa chỉ được phép nối (mặc định: không phải `isPrivateAddress`); test thay để nối server cục bộ. */
  allowAddress?: (ip: string) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface DownloadedImage {
  bytes: Buffer;
  type: string;
  name: string;
}

/** IPv6 → 8 nhóm 16 bit (nhận dạng rút gọn `::`, đuôi IPv4 chấm, bỏ zone `%…`). Gọi sau khi `isIP` báo 6. */
function hextets(ip: string): number[] {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const parts = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return parts.map((p) => parseInt(p, 16));
}

function privateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, metadata đám mây
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 đo hiệu năng
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, dành riêng, broadcast
  );
}

/**
 * Địa chỉ không được tải ảnh: loopback, mạng riêng, link-local, CGNAT, 198.18/15, tài liệu, multicast; IPv6 `::/96`
 * (gồm `::`, `::1`, IPv4-compatible), IPv4-mapped (`::ffff:a.b.c.d`, cả dạng hex) theo luật IPv4, NAT64 `64:ff9b::/96`
 * và `64:ff9b:1::/48`, ULA `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10`, multicast `ff00::/8`, tài liệu
 * `2001:db8::/32`, discard `100::/64`. Chuỗi không phải IP cũng chặn.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v !== 6) return true;
  const h = hextets(ip);
  if (h.length !== 8 || h.some((x) => Number.isNaN(x))) return true;
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return privateV4(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`);
  if (zeros(0, 6)) return true;
  if (h[0] === 0x64 && h[1] === 0xff9b && (zeros(2, 6) || h[2] === 1)) return true;
  if (h[0] === 0x100 && zeros(1, 4)) return true;
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true;
  const top = h[0]!;
  return (top & 0xfe00) === 0xfc00 || (top & 0xffc0) === 0xfe80 || (top & 0xffc0) === 0xfec0 || (top & 0xff00) === 0xff00;
}

const defaultResolve = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** `lookup` cho `net.connect` chỉ trả các địa chỉ đã kiểm: kết nối không phân giải lại tên miền. */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
    const list = addresses.map((address) => ({ address, family: isIP(address) })).filter((a) => !family || a.family === family);
    if (!list.length) {
      callback(Object.assign(new Error('Không có địa chỉ phù hợp'), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  };
}

function get(url: URL, addresses: readonly string[] | null, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // `agent: false`: không dùng lại socket đã nối tới địa chỉ khác của cùng host.
    const req = mod.request(url, {
      method: 'GET',
      agent: false,
      signal,
      headers: { accept: 'image/*' },
      ...(addresses && { lookup: pinnedLookup(addresses) }),
    });
    req.once('response', resolve);
    req.once('error', reject);
    req.end();
  });
}

/** Đọc body tới `max` byte; vượt thì huỷ kết nối ngay và trả null. */
async function readCapped(res: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) {
      res.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Tải ảnh nguồn an toàn. Lỗi nào cũng là `rejected` `image_source_invalid` kèm câu cho người dùng; không lộ địa chỉ đã
 * phân giải hay lỗi mạng chi tiết.
 */
export async function downloadImage(source: string, opts: ImageSourceOptions = {}): Promise<DownloadedImage> {
  const resolveHost = opts.resolveHost ?? defaultResolve;
  const allow = opts.allowAddress ?? ((ip: string) => !isPrivateAddress(ip));
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const bad = (why: string) => new MarketplaceError('rejected', 'image_source_invalid', why);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw bad('URL ảnh không hợp lệ');
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? IMAGE_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw bad('URL ảnh phải là http hoặc https');
    if (url.username || url.password) throw bad('URL ảnh không được chứa tài khoản');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host) !== 0;
    const addrs = literal ? [host] : await resolveHost(host).catch(() => []);
    if (!addrs.length || !addrs.every(allow)) throw bad('Không tải được ảnh từ địa chỉ này');
    let res: IncomingMessage;
    try {
      res = await get(url, literal ? null : addrs, signal);
    } catch {
      throw bad('Không tải được ảnh nguồn');
    }
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) throw bad('Ảnh chuyển hướng quá nhiều lần');
      try {
        url = new URL(location, url);
      } catch {
        throw bad('URL chuyển hướng không hợp lệ');
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      throw bad(`Tải ảnh nguồn lỗi HTTP ${status}`);
    }
    const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!type.startsWith('image/')) {
      res.destroy();
      throw bad('URL không trỏ tới ảnh');
    }
    if (Number(res.headers['content-length'] ?? 0) > max) {
      res.destroy();
      throw bad('Ảnh quá 10MB');
    }
    let bytes: Buffer | null;
    try {
      bytes = await readCapped(res, max);
    } catch {
      throw bad('Không tải được ảnh nguồn');
    }
    if (!bytes) throw bad('Ảnh quá 10MB');
    if (!bytes.length) throw bad('Ảnh rỗng');
    let name: string;
    try {
      name = decodeURIComponent(url.pathname.split('/').pop() || 'image') || 'image';
    } catch {
      name = 'image';
    }
    return { bytes, type, name };
  }
}
