import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadImage, isPrivateAddress } from '#src/modules/channel/channel/service/marketplaces/image-source.ts';
import { createTiktokClient, packTiktokToken, signTiktok } from '#src/modules/channel/channel/service/marketplaces/tiktok-client.ts';
import { tiktokListingMethods } from '#src/modules/channel/channel/service/marketplaces/tiktok-listing.ts';

// Tải ảnh nguồn qua server HTTP cục bộ (cổng 0) để kiểm kết nối thật: ghim địa chỉ đã kiểm, chuyển hướng, trần 10MB khi
// không có content-length (review #217 mục 3). Không gọi mạng ra ngoài: tên miền `.test` không phân giải được bằng DNS
// thật, nên tải được nghĩa là kết nối đã dùng đúng địa chỉ `resolveHost` trả (không phân giải lại).

const PNG = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
const MB = 1024 * 1024;
let server: http.Server;
let port: number;
let bigAborted: Promise<boolean>;
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const path = req.url ?? '';
    if (path === '/anh/coc.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    } else if (path === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>x</p>');
    } else if (path === '/redir-private') {
      res.writeHead(302, { location: `http://intra.test:${port}/anh/coc.png` }).end();
    } else if (path === '/redir-ok') {
      res.writeHead(302, { location: `http://img2.test:${port}/anh/coc.png` }).end();
    } else if (path === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (path === '/big') {
      // Không có content-length (chunked), gửi 12MB từng 256KB theo backpressure.
      res.writeHead(200, { 'content-type': 'image/png' });
      bigAborted = (async () => {
        const chunk = Buffer.alloc(256 * 1024, 1);
        const closed = once(res, 'close').then(() => 'close' as const);
        for (let sent = 0; sent < 12 * MB; sent += chunk.length) {
          if (res.destroyed) return true;
          if (!res.write(chunk)) {
            const drained = new Promise<'drain'>((r) => res.once('drain', () => r('drain')));
            if ((await Promise.race([drained, closed])) === 'close') return true;
          }
        }
        res.end();
        return false;
      })();
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  hits = [];
});

const HOSTS: Record<string, string[]> = { 'img.test': ['127.0.0.1'], 'img2.test': ['127.0.0.1'], 'intra.test': ['10.0.0.5'] };
/** Cho phép đúng server cục bộ của test, còn lại theo luật thật. */
const opts = (resolveHost = vi.fn(async (h: string) => HOSTS[h] ?? [])) => ({
  resolveHost,
  allowAddress: (ip: string) => ip === '127.0.0.1' || !isPrivateAddress(ip),
});

describe('downloadImage qua kết nối thật', () => {
  it('kết nối ghim địa chỉ đã kiểm: tên miền không có thật vẫn tải được, mỗi lượt chỉ phân giải một lần', async () => {
    const o = opts();
    const image = await downloadImage(`http://img.test:${port}/anh/coc.png`, o);
    expect(image).toEqual({ bytes: PNG, type: 'image/png', name: 'coc.png' });
    expect(o.resolveHost).toHaveBeenCalledTimes(1);
    expect(hits).toEqual(['/anh/coc.png']);
  });

  it('DNS rebinding: lần phân giải sau trả địa chỉ nội bộ cũng không ảnh hưởng, vì kết nối dùng địa chỉ của lần kiểm', async () => {
    const answers = [['127.0.0.1'], ['10.0.0.5']];
    const o = opts(vi.fn(async () => answers.shift() ?? []));
    await expect(downloadImage(`http://img.test:${port}/anh/coc.png`, o)).resolves.toMatchObject({ bytes: PNG });
    expect(o.resolveHost).toHaveBeenCalledTimes(1);
  });

  it('mặc định chặn chính server cục bộ (127.0.0.1) dù tên miền nào trỏ tới', async () => {
    await expect(
      downloadImage(`http://img.test:${port}/anh/coc.png`, { resolveHost: async () => ['127.0.0.1'] }),
    ).rejects.toMatchObject({ platformCode: 'image_source_invalid' });
    expect(hits).toEqual([]);
  });

  it('chuyển hướng: kiểm lại và ghim ở mỗi bước; sang host nội bộ thì chặn, không nối tới đó', async () => {
    await expect(downloadImage(`http://img.test:${port}/redir-ok`, opts())).resolves.toMatchObject({ name: 'coc.png' });
    expect(hits).toEqual(['/redir-ok', '/anh/coc.png']);
    hits = [];
    await expect(downloadImage(`http://img.test:${port}/redir-private`, opts())).rejects.toMatchObject({
      platformCode: 'image_source_invalid',
    });
    expect(hits).toEqual(['/redir-private']);
  });

  it('chuyển hướng quá 3 lần thì dừng', async () => {
    await expect(downloadImage(`http://img.test:${port}/loop`, opts())).rejects.toMatchObject({ platformCode: 'image_source_invalid' });
    expect(hits).toHaveLength(4);
  });

  it('không phải ảnh thì chặn', async () => {
    await expect(downloadImage(`http://img.test:${port}/html`, opts())).rejects.toMatchObject({ platformCode: 'image_source_invalid' });
  });

  it('body quá 10MB không có content-length: huỷ kết nối giữa chừng, báo ảnh quá lớn', async () => {
    const err = await downloadImage(`http://img.test:${port}/big`, opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({ platformCode: 'image_source_invalid', platformMessage: 'Ảnh quá 10MB' });
    expect(await bigAborted).toBe(true);
  });
});

describe('uploadImage TikTok', () => {
  it('tải ảnh nguồn rồi đưa lên bằng multipart: không ký body, không gửi shop_cipher, trả uri', async () => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return new Response(JSON.stringify({ code: 0, message: 'Success', request_id: 'r', data: { uri: 'tos-alisg/abc' } }));
    });
    const config = { appKey: 'appk', appSecret: 'apps', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' };
    const methods = tiktokListingMethods(createTiktokClient(config, fetchFn), { image: opts() });
    const token = packTiktokToken({ token: 'TTP_at', cipher: 'ROW_c', shopId: '749' });
    expect(await methods.uploadImage(token, `http://img.test:${port}/anh/coc.png`)).toBe('tos-alisg/abc');
    const call = calls[0]!;
    expect(call.url.pathname).toBe('/product/202309/images/upload');
    const form = call.init!.body as FormData;
    expect(form.get('use_case')).toBe('MAIN_IMAGE');
    const file = form.get('data') as File;
    expect(file.name).toBe('coc.png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    expect(call.init!.headers).toEqual({ 'x-tts-access-token': 'TTP_at' });
    expect(call.url.searchParams.has('shop_cipher')).toBe(false);
    const query = Object.fromEntries([...call.url.searchParams].filter(([k]) => k !== 'sign'));
    expect(call.url.searchParams.get('sign')).toBe(signTiktok('/product/202309/images/upload', query, '', 'apps'));
  });
});
