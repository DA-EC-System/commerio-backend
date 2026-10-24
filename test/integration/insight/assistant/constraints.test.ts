import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const vectorOf = (dimensions: number) => `[${Array.from({ length: dimensions }, (_, i) => (i % 7) / 10).join(',')}]`;

async function insertDocument(companyId: string): Promise<string> {
  const res = await testPool().query<{ id: string }>(
    `insert into assistant.documents (company_id, file_id, title, uploaded_by)
     values ($1, $2, 'Chính sách đổi trả', $3) returning id`,
    [companyId, randomUUID(), randomUUID()],
  );
  return res.rows[0]!.id;
}

const insertChunk = (c: pg.Pool | pg.PoolClient, companyId: string, documentId: string, embedding: string) =>
  c.query(
    `insert into assistant.document_chunks (company_id, document_id, chunk_index, content, embedding)
     values ($1, $2, 0, 'Đổi trả trong 7 ngày', $3::vector)`,
    [companyId, documentId, embedding],
  );

// Tài liệu nội bộ cho trợ lý AI (plan chuẩn bị A9, 4.3 phần CB-4; AC-9).
describe('ràng buộc bảng assistant (AC-9)', () => {
  it('đoạn tài liệu nhận vector 1536 chiều dưới role ứng dụng và đọc lại được', async () => {
    const company = randomUUID();
    const document = await insertDocument(company);
    const res = await asCompany(company, async (c) => {
      await insertChunk(c, company, document, vectorOf(1536));
      return c.query<{ dims: number }>('select vector_dims(embedding) as dims from assistant.document_chunks');
    });
    expect(res.rows).toEqual([{ dims: 1536 }]);
  });

  it('vector sai số chiều bị từ chối', async () => {
    const company = randomUUID();
    const document = await insertDocument(company);
    await expect(asCompany(company, (c) => insertChunk(c, company, document, vectorOf(3)))).rejects.toThrow(
      /expected 1536 dimensions/,
    );
  });

  it('một tài liệu không có hai đoạn cùng thứ tự', async () => {
    const company = randomUUID();
    const document = await insertDocument(company);
    await insertChunk(testPool(), company, document, vectorOf(1536));
    await expect(insertChunk(testPool(), company, document, vectorOf(1536))).rejects.toThrow(
      /document_chunks_document_id_chunk_index_unique/,
    );
  });
});
