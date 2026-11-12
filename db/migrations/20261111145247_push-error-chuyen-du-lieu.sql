-- #219: `listings.push_error` từ chuỗi sang `{ code, message, at }` (Documents/21 §18.6.4). Viết tay vì PostgreSQL không
-- tự ép text sang jsonb: câu `SET DATA TYPE jsonb` drizzle sinh ở migration ngay sau sẽ lỗi nếu cột còn là text. Dòng cũ
-- giữ câu lỗi trong `message`. Hai câu cố định của bản trước (lỗi tạm, kẹt `pushing` quá 30 phút) là
-- `marketplace_unavailable`; câu khác là câu của sàn hoặc câu mặc định khi sàn từ chối: `marketplace_rejected`. Rỗng thì
-- null (không có gì để hiện). `at` lấy `updated_at` của dòng. Test: test/integration/channel/channel/push-error-migration.test.ts.
ALTER TABLE "channel"."listings" ALTER COLUMN "push_error" SET DATA TYPE jsonb USING (
  CASE WHEN "push_error" IS NULL OR btrim("push_error") = '' THEN NULL
  ELSE jsonb_build_object(
    'code', CASE WHEN "push_error" IN ('Sàn lỗi tạm, đẩy lại sau', 'Quá 30 phút chưa có kết quả từ sàn, đẩy lại')
      THEN 'marketplace_unavailable' ELSE 'marketplace_rejected' END,
    'message', "push_error",
    'at', to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) END
);
