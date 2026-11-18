-- Link huỷ từ `open` trước #403 còn giữ email, họ tên người cầm link tự gõ ở `/join/otp` mà chưa qua OTP (API trả ra cho
-- Admin). Từ #403 `revokeInvitationRow` xoá hai cột này khi huỷ từ `open`. Dòng cũ nhận ra bằng nhật ký huỷ
-- (`before.status = 'open'`, `after.status = 'revoked'`). Chỉ dữ liệu, chạy lại được.
UPDATE "core"."invitations" i
SET "email" = NULL, "full_name" = NULL
WHERE i."status" = 'revoked'
  AND (i."email" IS NOT NULL OR i."full_name" IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM "core"."audit_logs" a
    WHERE a."entity_type" = 'core.invitations'
      AND a."entity_id" = i."id"
      AND a."before" ->> 'status' = 'open'
      AND a."after" ->> 'status' = 'revoked'
  );
