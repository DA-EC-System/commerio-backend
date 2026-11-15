import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadDocument } from '#src/modules/channel/channel/service/marketplaces/image-source.ts';

const PDF = Buffer.from('%PDF-1.4\n%Van don');
const failure = { kind: 'unavailable', platformCode: 'document_download_failed' };
let origin: string;
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: origin.replace('127.0.0.1', 'localhost') }).end();
  } else {
    const type = req.url === '/html' ? 'text/html' : 'application/pdf';
    res.writeHead(200, { 'content-type': type }).end(req.url === '/bad' ? '<html>' : PDF);
  }
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

describe('tải tệp vận đơn', () => {
  it('tải PDF qua origin tin cậy, trả đúng byte', async () => {
    expect(await downloadDocument(origin, { trustedOrigin: origin })).toEqual(PDF);
  });

  it('từ chối HTTP ngoài origin tin cậy, kể cả sau chuyển hướng', async () => {
    await expect(downloadDocument(origin)).rejects.toMatchObject(failure);
    await expect(downloadDocument(`${origin}/redirect`, { trustedOrigin: origin })).rejects.toMatchObject(failure);
  });

  it.each(['/html', '/bad'])('từ chối phản hồi không phải PDF tại %s', async (path) => {
    await expect(downloadDocument(origin + path, { trustedOrigin: origin })).rejects.toMatchObject(failure);
  });

  it('huỷ khi nội dung vượt trần byte', async () => {
    await expect(downloadDocument(origin, { trustedOrigin: origin, maxBytes: 10 })).rejects.toMatchObject(failure);
  });

  it('từ chối địa chỉ riêng khi không có origin tin cậy', async () => {
    await expect(downloadDocument('https://s3.test', { resolveHost: async () => ['10.0.0.1'] })).rejects.toMatchObject(failure);
  });
});
