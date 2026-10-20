import { hash, verify } from '@node-rs/argon2';

// argon2id với tham số mặc định của thư viện (19 MiB, 2 vòng, theo khuyến nghị OWASP).
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

let dummyHash: Promise<string> | undefined;

/**
 * So mật khẩu với bản băm. Tài khoản không tồn tại hay chưa có mật khẩu vẫn chạy argon2
 * trên một bản băm giả, để thời gian trả lời không lộ email nào có tài khoản (UC-PI-03 ngoại lệ bước 4).
 */
export async function verifyPassword(passwordHash: string | null | undefined, password: string): Promise<boolean> {
  if (!passwordHash) {
    dummyHash ??= hash('commerio-mat-khau-gia');
    await verify(await dummyHash, password);
    return false;
  }
  return verify(passwordHash, password);
}
