// Gọi API của một server đang chạy (máy dev, CI hoặc staging) bằng `fetch`, không dựng app trong tiến trình test.
// Địa chỉ và mật khẩu tài khoản QA lấy từ biến môi trường (test/CLAUDE.md, mục Hộp đen).

export const BASE_URL = (process.env.BLACKBOX_BASE_URL ?? '').replace(/\/+$/, '');
export const PASSWORD = process.env.BLACKBOX_PASSWORD ?? '';

/** Tài khoản của hai công ty QA, trùng `blackboxCompanies` ở `db/seed/demo.ts`. */
export const ACCOUNTS = {
  ceo: 'qa-ceo@commerio.dev',
  admin: 'qa-admin@commerio.dev',
  sale: 'qa-sale@commerio.dev',
  kho: 'qa-kho@commerio.dev',
  buyer: 'qa-mua@commerio.dev',
  lead: 'qa-truong-mua@commerio.dev',
  ceoB: 'qa-ceo-b@commerio.dev',
} as const;
export type Role = keyof typeof ACCOUNTS;

export interface Res {
  status: number;
  contentType: string;
  // Body JSON của server, test tự đọc trường cần kiểm.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** Một request; `path` bắt đầu bằng `/` là tương đối với `/api/v1`, còn lại là đường dẫn đầy đủ (vd `/health`). */
export async function call(method: string, path: string, init: { token?: string; body?: unknown } = {}): Promise<Res> {
  const url = `${BASE_URL}${path.startsWith('/api/') || path === '/health' ? '' : '/api/v1'}${path}`;
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, contentType, body: contentType.includes('json') && text ? JSON.parse(text) : text };
}

export function api(token?: string) {
  return {
    get: (path: string) => call('GET', path, { token }),
    post: (path: string, body: unknown = {}) => call('POST', path, { token, body }),
    put: (path: string, body: unknown) => call('PUT', path, { token, body }),
    delete: (path: string) => call('DELETE', path, { token }),
  };
}

/** Đăng nhập rồi chọn công ty duy nhất của tài khoản; trả token đã gắn công ty. */
export async function signIn(email: string): Promise<{ token: string; companyId: string }> {
  const login = await call('POST', '/identity/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`Đăng nhập ${email}: ${login.status} ${JSON.stringify(login.body)}`);
  const companyId = login.body.memberships?.[0]?.companyId as string | undefined;
  if (!companyId) throw new Error(`${email} chưa thuộc công ty nào: chạy npm run db:seed trên server này`);
  const selected = await call('POST', '/identity/select-company', { token: login.body.accessToken, body: { companyId } });
  if (selected.status !== 200) throw new Error(`Chọn công ty của ${email}: ${selected.status} ${JSON.stringify(selected.body)}`);
  return { token: selected.body.accessToken as string, companyId };
}

/** Đường dẫn server khai trong `/api/openapi.json` (`GET /api/v1/...`); `null` khi server tắt tài liệu API. */
export async function declaredRoutes(): Promise<string[] | null> {
  const res = await call('GET', '/api/openapi.json');
  if (res.status !== 200 || typeof res.body !== 'object') return null;
  return Object.entries(res.body.paths as Record<string, Record<string, unknown>>).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

/** Mã ngẫu nhiên cho tên bản ghi: dữ liệu của lần chạy trước còn trên server. */
export const uniq = () => Math.random().toString(36).slice(2, 8).toUpperCase();
