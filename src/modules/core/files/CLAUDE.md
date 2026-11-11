# src/modules/core/files/

Thông tin tệp và tệp đính kèm chứng từ (#212). Nội dung tệp nằm ở **Cloudflare R2** qua API S3; chỉ module này nói chuyện với kho (`service/storage.ts`), module khác gọi hàm của `files`. Hợp đồng API: `Documents/21` §5.2, §5.3, §14.3. API gắn tại `/api/v1/files`.

## Kho

| Mục đích (`purpose`) | Kiểu | Tối đa | Bucket | Xem bằng |
|---|---|---|---|---|
| `product_image` | JPG, PNG, WebP | 5 MB | `S3_PUBLIC_BUCKET` | Link cố định `<S3_PUBLIC_URL>/<storage_key>` (tên miền riêng, có cache) |
| `attachment` | JPG, PNG, WebP, PDF | 10 MB | `S3_PRIVATE_BUCKET` | Chỉ link ký sẵn 15 phút |

- MVP không nhận video. Luật ở `domain/upload-rules.ts`.
- `storage_key` = `<S3_KEY_PREFIX>/<id tệp>.<đuôi>`: tiền tố tách máy dev (`dev`) với staging (`staging`) trên cùng bucket; có đuôi để Cloudflare cache ảnh (mặc định cache theo đuôi). Không chứa tên tệp người dùng gửi (tên gốc ở `file_name`). Lưu khoá chứ không lưu link: đổi tên miền ảnh chỉ cần đổi `S3_PUBLIC_URL`.
- R2 không có POST policy, nên vé là URL **PUT** ký cả `Content-Type` và `Content-Length` (`signableHeaders`): FE gửi khác kiểu hoặc to hơn đã khai thì kho trả 403. Client tắt checksum mặc định (`requestChecksumCalculation: 'WHEN_REQUIRED'`), không thì SDK ký CRC32 của thân rỗng và kho từ chối tệp thật.
- Ký URL chỉ tính trong máy, không gọi mạng; test dùng cấu hình giả ở `vitest.config.ts`. Thử với R2 thật: `npm run smoke:r2` (`scripts/smoke/r2.ts`).

## Chỉ dùng gói miễn phí của R2

R2 không có trần chi phí cứng (budget alert chỉ gửi email, trễ khoảng một ngày), nên backend tự chặn:
- Trần tổng `STORAGE_QUOTA_BYTES` (mặc định 8 GiB, gói miễn phí 10 GB): cộng `size_bytes` của **mọi công ty** (`totalStoredBytes`, chạy ngoài giao dịch công ty bằng role chủ bảng), vượt thì 507 `storage_quota_exceeded`. Tính cả tệp đã xin vé mà chưa PUT, nên là cận trên. Không khoá: hai vé cùng lúc có thể vượt thêm một tệp.
- Cỡ từng tệp theo bảng trên, ký vào URL.
- Không gọi `ListObjects` (tính vào thao tác Class A); danh sách tệp đọc từ DB.
- Metric `files_upload_tickets_total{purpose,result}`; `result="quota_exceeded"` tăng là kho sắp chạm gói miễn phí.

## Quyền

| Thao tác | Ai |
|---|---|
| `POST /uploads`, `purpose: product_image` | `catalog.product.manage` (như sửa sản phẩm) |
| `POST /uploads`, `purpose: attachment` | Mọi thành viên còn làm việc được trong công ty: middleware `member` ở `api/routes.ts`, cùng các bước của `authorize` trừ mã quyền, đọc membership bằng `loadCompanyAccess` của `identity` |

Quyền phụ thuộc `purpose` trong body nên kiểm sau `validate()`.

## Gắn tệp vào chứng từ (`service/attachments.ts`, export từ `core/index.ts`)

Chứng từ là `{ type: '<tên bảng>', id }` (vd `goods_receipts`). Bên gọi làm theo thứ tự:

1. `confirmUploads(companyId, fileIds)` **trước** khi mở giao dịch: tệp chưa có `uploaded_at` thì `HeadObject` lên kho (song song), có và đúng cỡ đã khai thì ghi `uploaded_at`, lần sau khỏi hỏi lại. Lời gọi mạng nằm ngoài giao dịch để không giữ khoá dòng. Kho không trả lời thì 503 `storage_unavailable`.
2. Trong `withCompany`: `attachmentProblem(fileIds)` trả câu lỗi cho ô tệp của chứng từ (`null` là được). Tệp phải thuộc công ty (RLS), xin vé với `purpose: 'attachment'`, đã PUT xong, không lặp, tối đa 10. Bên gọi đặt câu đó vào ô của mình (`errors.attachments` ở phiếu nhận, `errors.attachmentIds` ở yêu cầu trả).
3. `replaceAttachments(entity, fileIds, actorId)` thay toàn bộ theo thứ tự gửi. Gỡ tệp không xoá tệp.

Đọc: `attachmentsOf(entity)` trả `{ fileId, name, url, contentType }[]`; `url` là link GET ký sẵn 15 phút, ép `Content-Type` theo kiểu đã lưu, `Content-Disposition` ảnh `inline`, PDF `attachment` (tên tệp UTF-8). `hasAttachments(entity)`, `attachmentIdsOf(entity)` cho bằng chứng và nhật ký.

**`X-Content-Type-Options: nosniff`**: R2 không trả header này và link ký sẵn không thêm được. Tệp nằm ở tên miền của R2, khác origin của app (cookie refresh `HttpOnly` gắn với tên miền app), kiểu tệp đã ký lúc tải lên và ép lại lúc tải xuống. Ảnh công khai ở `S3_PUBLIC_URL` thêm được bằng Transform Rule của Cloudflare nếu cần.

Test thay kho bằng `setHeadObject(fake)` (`service/storage.ts`), trả về kho thật bằng `setHeadObject(null)`.

## Bất biến

- Dòng `core.files` ghi lúc cấp vé, **trước** khi FE PUT: có dòng mà chưa có tệp trên kho là bình thường. `uploaded_at` ghi lần đầu thấy tệp trên kho, chỉ tệp có `uploaded_at` mới gắn được.
- `size_bytes > 0` (CHECK `files_size_positive`); `purpose` là enum `core.file_purpose`; `storage_key` unique.
- RLS theo `company_id` (bật chung ở migration `0002`).
- Không log URL ký sẵn (chữ ký dùng được tới khi hết hạn).

## Chưa làm

- Dọn tệp xin vé mà không gắn vào đâu (ngoài #212).
- Bật ảnh sản phẩm ở catalog (`imageFileIds`, `noImages` ở `product/catalog/api/schemas.ts`): chưa có issue.
- Gắn tệp cho yêu cầu trả (#202) dùng các hàm trên.
