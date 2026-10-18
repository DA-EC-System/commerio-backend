-- pgvector cho assistant.document_chunks.embedding (0013). Extension không "trusted": cần superuser, hoặc cơ chế
-- extension cho phép của Supabase. Đã bật sẵn (dashboard Supabase, global-setup của test) thì lệnh này không làm gì.
CREATE EXTENSION IF NOT EXISTS vector;
