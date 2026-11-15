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
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface ImageSourceOptions {
  /** Phân giải tên miền (mặc định DNS hệ thống, mọi địa chỉ); test thay. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Địa chỉ được phép nối (mặc định: không phải `isPrivateAddress`); test thay để nối server cục bộ. */
  allowAddress?: (ip: string) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface DocumentSourceOptions extends ImageSourceOptions {
  /** Origin từ cấu hình của sàn, cho phép tải từ sàn giả lập cục bộ. */
  trustedOrigin?: string;
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
 * Địa chỉ không được tải ảnh. IPv4: loopback, mạng riêng, link-local, CGNAT, 198.18/15, tài liệu, multicast, dành riêng.
 * IPv6 theo danh sách cho phép: IPv4-mapped (`::ffff:0:0/96`, cả dạng hex) và IPv4-compatible (`::/96`, gồm `::`, `::1`)
 * tách IPv4 ra xét theo luật IPv4; ngoài ra chỉ nhận unicast toàn cầu `2000::/3`, trong đó vẫn chặn các dải nhúng IPv4
 * hay dành riêng: 6to4 `2002::/16`, khối giao thức IETF `2001::/23` (gồm Teredo `2001::/32`, benchmark, ORCHID), tài
 * liệu `2001:db8::/32` và `3fff::/20`. Nên NAT64 `64:ff9b::/96`, `64:ff9b:1::/48`, discard `100::/64`, ULA, link-local,
 * site-local, multicast đều bị chặn vì nằm ngoài `2000::/3`. Chuỗi không phải IP cũng chặn.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v !== 6) return true;
  const h = hextets(ip);
  if (h.length !== 8 || h.some((x) => Number.isNaN(x))) return true;
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  const embeddedV4 = () => `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  if (zeros(0, 5) && (h[5] === 0xffff || h[5] === 0)) return privateV4(embeddedV4());
  const [a, b] = h as [number, number];
  if ((a & 0xe000) !== 0x2000) return true; // ngoài 2000::/3
  if (a === 0x2002) return true; // 6to4
  if (a === 0x2001 && b < 0x200) return true; // 2001::/23: Teredo, benchmark, ORCHID…
  if (a === 0x2001 && b === 0xdb8) return true; // tài liệu
  if (a === 0x3fff && b < 0x1000) return true; // tài liệu 3fff::/20 (RFC 9637)
  return false;
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

function get(url: URL, addresses: readonly string[] | null, signal: AbortSignal, accept: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // `agent: false`: không dùng lại socket đã nối tới địa chỉ khác của cùng host.
    const req = mod.request(url, {
      method: 'GET',
      agent: false,
      signal,
      headers: { accept },
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
  const { bytes, type, url } = await download(source, opts, {
    accept: 'image/*',
    isType: (type) => type.startsWith('image/'),
    maxBytes: MAX_IMAGE_BYTES,
    error: (why) => new MarketplaceError('rejected', 'image_source_invalid', why),
  });
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.split('/').pop() || 'image') || 'image';
  } catch {
    name = 'image';
  }
  return { bytes, type, name };
}

function documentError() {
  return new MarketplaceError('unavailable', 'document_download_failed', 'Sàn trả tệp vận đơn hỏng, thử lại sau');
}

export async function downloadDocument(source: string, opts: DocumentSourceOptions = {}): Promise<Uint8Array> {
  const { bytes } = await download(source, opts, {
    accept: 'application/pdf',
    isType: (type) => type === 'application/pdf',
    maxBytes: MAX_DOCUMENT_BYTES,
    httpsOnly: true,
    error: documentError,
  });
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw documentError();
  return bytes;
}

interface DownloadPolicy {
  accept: string;
  isType: (type: string) => boolean;
  maxBytes: number;
  httpsOnly?: boolean;
  error: (why: string) => MarketplaceError;
}

async function download(source: string, opts: DocumentSourceOptions, policy: DownloadPolicy) {
  const resolveHost = opts.resolveHost ?? defaultResolve;
  const allow = opts.allowAddress ?? ((ip: string) => !isPrivateAddress(ip));
  const max = opts.maxBytes ?? policy.maxBytes;
  const bad = policy.error;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw bad('URL ảnh không hợp lệ');
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const trusted = url.origin === opts.trustedOrigin;
    if (url.protocol !== 'https:' && (url.protocol !== 'http:' || (policy.httpsOnly && !trusted))) {
      throw bad('URL ảnh phải là http hoặc https');
    }
    if (url.username || url.password) throw bad('URL ảnh không được chứa tài khoản');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host) !== 0;
    const addrs = literal ? [host] : await resolveHost(host).catch(() => []);
    if (!addrs.length || (!trusted && !addrs.every(allow))) throw bad('Không tải được ảnh từ địa chỉ này');
    let res: IncomingMessage;
    try {
      res = await get(url, literal ? null : addrs, signal, policy.accept);
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
    if (!policy.isType(type)) {
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
    return { bytes, type, url };
  }
}
