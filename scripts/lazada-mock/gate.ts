// Cổng của sàn giả lập Lazada (#115), chạy trong container Node trước WireMock (deploy/compose.yaml, profile
// lazada-mock). WireMock không tính được HMAC, nên cổng kiểm chữ ký như Lazada rồi mới chuyển request nguyên vẹn
// sang WireMock; trang uỷ quyền OAuth trả thẳng về `redirect_uri` kèm `code`. Chỉ dùng thư viện có sẵn của Node.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { checkRequest } from './sign.ts';

const PORT = Number(process.env.PORT ?? 8090);
const UPSTREAM = process.env.WIREMOCK_URL ?? 'http://lazada-wiremock:8080';
const APP_KEY = process.env.LAZADA_MOCK_APP_KEY ?? 'mock-app-key';
const APP_SECRET = process.env.LAZADA_MOCK_APP_SECRET ?? 'mock-app-secret';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(text);
}

/** Trang uỷ quyền giả: không hỏi đăng nhập, chuyển về app ngay với một `code` (đổi token ở /auth/token/create). */
function authorize(url: URL, res: ServerResponse) {
  const redirect = url.searchParams.get('redirect_uri');
  if (url.searchParams.get('client_id') !== APP_KEY || !redirect) return send(res, 400, 'client_id hoặc redirect_uri sai');
  const target = new URL(redirect);
  target.searchParams.set('code', `mock-code-${randomUUID().slice(0, 8)}`);
  const state = url.searchParams.get('state');
  if (state) target.searchParams.set('state', state);
  send(res, 302, '', { location: target.toString() });
}

/** `/rest/<apiPath>`: kiểm chữ ký trên mọi tham số (URL và form body), đúng thì chuyển sang WireMock. */
async function api(req: IncomingMessage, url: URL, res: ServerResponse) {
  const body = req.method === 'POST' ? await readBody(req) : '';
  const params = Object.fromEntries(url.searchParams);
  if (body && (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
    Object.assign(params, Object.fromEntries(new URLSearchParams(body)));
  }
  const apiPath = url.pathname.slice('/rest'.length);
  const check = checkRequest(apiPath, params, APP_KEY, APP_SECRET);
  if (!check.ok) return send(res, 200, { type: 'ISV', code: check.code, message: check.message, request_id: `mock-${randomUUID()}` });

  const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
    method: req.method,
    headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
    body: body || undefined,
  });
  send(res, upstream.status, await upstream.text(), { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gate');
  const route =
    url.pathname === '/health'
      ? Promise.resolve(send(res, 200, { ok: true }))
      : url.pathname === '/oauth/authorize'
        ? Promise.resolve(authorize(url, res))
        : url.pathname.startsWith('/rest/')
          ? api(req, url, res)
          : Promise.resolve(send(res, 404, { type: 'ISV', code: 'InvalidApiPath', message: 'The specified API path is invalid' }));
  route.catch((err: unknown) => send(res, 502, { type: 'SYSTEM', code: 'MockGateError', message: String(err) }));
}).listen(PORT, () => console.log(`lazada-mock gate :${PORT} → ${UPSTREAM}`));
