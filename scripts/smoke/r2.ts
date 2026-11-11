// Smoke test kho tệp R2 (#212): chạy đúng đường ký URL của module `files` vào bucket thật, rồi xoá tệp thử.
// Cần các biến S3_* trong .env (mẫu ở .env.example). Chạy: npm run smoke:r2 [origin FE cần kiểm CORS ...]
// Tốn vài thao tác Class A/B của R2, xoá tệp miễn phí.
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { headObject, signDownload, signUpload, storageConfig } from '../../src/modules/core/files/service/storage.ts';

const config = storageConfig();
if (!config) {
  console.error('Thiếu S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_BUCKET hoặc S3_PRIVATE_BUCKET trong .env');
  process.exit(1);
}
const origins = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['http://localhost:5173'];

// Ảnh PNG 1×1 và một PDF tối thiểu: kho không đọc nội dung.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ĐẠT ' : 'HỎNG'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function put(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  // fetch tự đặt Content-Length theo thân, như trình duyệt (trình duyệt bỏ qua header này nếu FE gửi kèm).
  const rest = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-length'));
  const res = await fetch(url, { method: 'PUT', headers: rest, body: new Uint8Array(body) });
  await res.arrayBuffer();
  return res.status;
}

const publicKey = `${config.keyPrefix}/smoke-${randomUUID()}.png`;
const privateKey = `${config.keyPrefix}/smoke-${randomUUID()}.pdf`;
const s3 = new S3Client({
  region: config.region,
  endpoint: config.endpoint,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
});

try {
  const image = { bucket: config.buckets.public, key: publicKey, contentType: 'image/png', sizeBytes: png.length };

  // 1. CORS: trình duyệt hỏi trước khi PUT sang tên miền khác.
  const signed = await signUpload(config, image, 60);
  for (const origin of origins) {
    const res = await fetch(signed.url, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    const allowed = res.headers.get('access-control-allow-origin');
    check(`CORS cho ${origin}`, res.ok && (allowed === origin || allowed === '*'), `HTTP ${res.status}, allow-origin=${allowed}`);
  }

  // 2. Chữ ký giữ đúng cỡ và kiểu đã khai.
  const tooBig = await signUpload(config, { ...image, sizeBytes: png.length - 1 }, 60);
  check('PUT to hơn cỡ đã khai bị từ chối', (await put(tooBig.url, tooBig.headers, png)) === 403);
  const wrongType = await put(signed.url, { ...signed.headers, 'Content-Type': 'image/jpeg' }, png);
  check('PUT khác kiểu đã khai bị từ chối', wrongType === 403);

  // 3. Ảnh vào bucket công khai, xem được qua tên miền riêng.
  const status = await put(signed.url, signed.headers, png);
  check('PUT ảnh vào bucket công khai', status === 200, `HTTP ${status}`);
  if (process.env.S3_PUBLIC_URL) {
    const res = await fetch(`${process.env.S3_PUBLIC_URL}/${publicKey}`);
    await res.arrayBuffer();
    check('Xem ảnh qua S3_PUBLIC_URL', res.ok && res.headers.get('content-type') === 'image/png', `HTTP ${res.status}`);
  } else {
    console.log('BỎ   Xem ảnh công khai: chưa đặt S3_PUBLIC_URL');
  }

  // 4. Đính kèm vào bucket riêng.
  const file = await signUpload(
    config,
    { bucket: config.buckets.private, key: privateKey, contentType: 'application/pdf', sizeBytes: pdf.length },
    60,
  );
  const pdfStatus = await put(file.url, file.headers, pdf);
  check('PUT PDF vào bucket riêng', pdfStatus === 200, `HTTP ${pdfStatus}`);

  // 5. Đường đọc của tệp đính kèm: hỏi kho (xác nhận đã PUT xong) rồi mở link tải ký sẵn.
  const target = { bucket: config.buckets.private, key: privateKey };
  const found = await headObject(config, target);
  check('HeadObject thấy PDF đúng cỡ', found?.sizeBytes === pdf.length, `cỡ ${found?.sizeBytes ?? 'không có'}`);
  check('HeadObject tệp chưa có trả null', (await headObject(config, { ...target, key: `${privateKey}.khong-co` })) === null);
  const download = await signDownload(config, { ...target, contentType: 'application/pdf', fileName: 'biên bản.pdf' }, 60);
  const got = await fetch(download);
  await got.arrayBuffer();
  check(
    'Link tải PDF: tải về dạng tệp',
    got.ok && (got.headers.get('content-disposition') ?? '').startsWith('attachment;'),
    `HTTP ${got.status}, ${got.headers.get('content-disposition')}`,
  );
} finally {
  await s3.send(new DeleteObjectCommand({ Bucket: config.buckets.public, Key: publicKey })).catch(() => {});
  await s3.send(new DeleteObjectCommand({ Bucket: config.buckets.private, Key: privateKey })).catch(() => {});
}

console.log(failed === 0 ? '\nKho tệp chạy được.' : `\n${failed} bước hỏng.`);
process.exit(failed === 0 ? 0 : 1);
