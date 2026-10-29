// Lưu token uỷ quyền của các lần smoke test vào .smoke-tokens.json (đã gitignore) để chạy lại không phải uỷ quyền lại.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../../.smoke-tokens.json', import.meta.url));

type Store = Record<string, Record<string, unknown>>;

function readAll(): Store {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Store) : {};
}

export function loadTokens<T>(platform: string): T {
  const tokens = readAll()[platform];
  if (!tokens) throw new Error(`Chưa có token ${platform}. Chạy lệnh "token" trước.`);
  return tokens as T;
}

export function saveTokens(platform: string, tokens: Record<string, unknown>): void {
  const all = readAll();
  all[platform] = { ...tokens, savedAt: new Date().toISOString() };
  // Chỉ chủ file đọc được (Windows bỏ qua mode); chmod thêm cho file đã tạo trước đó
  writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
  console.log(`Đã lưu token ${platform} vào ${FILE}`);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name} (xem .env.example)`);
  return value;
}

export function printStep(name: string, ok: boolean, detail: unknown): void {
  console.log(`\n${ok ? 'OK  ' : 'LỖI'} ${name}`);
  console.log(JSON.stringify(detail, null, 2).slice(0, 2000));
}
