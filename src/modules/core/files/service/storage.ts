import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../../../shared/config/env.ts';

// Kho tệp Cloudflare R2 qua API S3 (#212). Chỉ module `files` nói chuyện với kho; module khác gọi hàm của `files`.

export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly buckets: { readonly public: string; readonly private: string };
  readonly keyPrefix: string;
}

/** Cấu hình kho từ biến môi trường; `null` khi thiếu một trong các biến bắt buộc (route trả 503). */
export function storageConfig(): StorageConfig | null {
  const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_BUCKET, S3_PRIVATE_BUCKET } = env;
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_PUBLIC_BUCKET || !S3_PRIVATE_BUCKET) return null;
  return {
    endpoint: S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    buckets: { public: S3_PUBLIC_BUCKET, private: S3_PRIVATE_BUCKET },
    keyPrefix: env.S3_KEY_PREFIX,
  };
}

let client: S3Client | undefined;

function s3(config: StorageConfig): S3Client {
  client ??= new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Mặc định SDK gắn checksum CRC32 của thân rỗng vào URL ký sẵn, kho sẽ từ chối tệp thật. Chỉ tính khi API bắt buộc.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

export interface SignedUpload {
  readonly url: string;
  /** Header FE phải gửi đúng khi PUT (Documents/21 §14.3); khác đi thì chữ ký sai, kho từ chối. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * URL PUT ký sẵn, ký cả `Content-Type` và `Content-Length` để FE không gửi được tệp khác kiểu hay to hơn đã khai.
 * Chỉ tính chữ ký trong máy, không gọi mạng. R2 không có POST policy (`content-length-range`) nên dùng cách này.
 */
export async function signUpload(
  config: StorageConfig,
  target: { bucket: string; key: string; contentType: string; sizeBytes: number },
  expiresInSeconds: number,
): Promise<SignedUpload> {
  const command = new PutObjectCommand({
    Bucket: target.bucket,
    Key: target.key,
    ContentType: target.contentType,
    ContentLength: target.sizeBytes,
  });
  const url = await getSignedUrl(s3(config), command, {
    expiresIn: expiresInSeconds,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return { url, headers: { 'Content-Type': target.contentType, 'Content-Length': String(target.sizeBytes) } };
}
