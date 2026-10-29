-- Extension cần có trước khi tạo bảng. `vector` (pgvector, cột `insight.document_chunks.embedding`) không "trusted":
-- Supabase bật bằng danh sách extension cho phép, test bật sẵn trong global-setup.ts. `btree_gist` cho ràng buộc
-- EXCLUDE chống hai phiên bản cấu hình cùng hiệu lực chồng ngày (`finance.config_versions`, 0002).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
