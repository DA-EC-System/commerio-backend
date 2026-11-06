import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { receiveBack } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { companyWithVariants, receive } from './helpers.ts';

// Hàng quay về kho (spec #206 mục 5.5, Q19, AC 9): lập phiếu kiểm hàng hoàn nháp, tồn chưa đổi.

async function levelOf(companyId: string, variantId: string) {
  const { rows } = await testPool().query(
    'select on_hand, reserved, quarantine, avg_cost, version from product.stock_levels where company_id = $1 and variant_id = $2',
    [companyId, variantId],
  );
  return rows[0];
}

async function docOf(documentId: string) {
  const { rows } = await testPool().query(
    'select kind, status, source_type, source_id, created_by, posted_at from product.stock_documents where id = $1',
    [documentId],
  );
  return rows[0];
}

async function docLines(documentId: string) {
  const { rows } = await testPool().query(
    'select variant_id, quantity, expected_qty, unit_cost from product.stock_document_lines where document_id = $1',
    [documentId],
  );
  return rows;
}

async function docsOfSource(sourceId: string) {
  const { rows } = await testPool().query('select number from product.stock_documents where source_id = $1', [sourceId]);
  return rows;
}

async function outboxOf(variantId: string) {
  const { rows } = await testPool().query('select type from core.outbox_messages where key = $1', [variantId]);
  return rows;
}

async function transitionsOf(entityId: string) {
  const { rows } = await testPool().query('select to_state, actor_id, source from core.state_transitions where entity_id = $1', [entityId]);
  return rows;
}

const line = (variantId: string, quantity: number) => ({ variantId, quantity });

describe('receiveBack', () => {
  it('AC9: lập phiếu KT-000001 nháp, một dòng gộp theo SKU, tồn và outbox không đổi; gọi lại cùng nguồn trả phiếu cũ', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    await receive(companyId, a, 5, 1000);
    const before = await levelOf(companyId, a);
    const k5 = randomUUID();

    const kt1 = await withCompany(companyId, () => receiveBack({ type: 'package', id: k5 }, [line(a, 2), line(a, 1)]));

    expect(kt1).toEqual({ documentId: expect.any(String), number: 'KT-000001' });
    expect(await docOf(kt1.documentId)).toEqual({
      kind: 'return_inspection',
      status: 'draft',
      source_type: 'package',
      source_id: k5,
      created_by: null,
      posted_at: null,
    });
    expect(await docLines(kt1.documentId)).toEqual([{ variant_id: a, quantity: null, expected_qty: 3, unit_cost: null }]);
    expect(await levelOf(companyId, a)).toEqual(before);
    expect(await outboxOf(a)).toEqual([]);
    expect(await transitionsOf(kt1.documentId)).toEqual([{ to_state: 'draft', actor_id: null, source: 'system' }]);

    expect(await withCompany(companyId, () => receiveBack({ type: 'package', id: k5 }, [line(a, 3)]))).toEqual(kt1);
    expect(await docsOfSource(k5)).toHaveLength(1);
  });

  it('AC9: nguồn là yêu cầu trả khác → phiếu mới KT-000002', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;
    await withCompany(companyId, () => receiveBack({ type: 'package', id: randomUUID() }, [line(a, 1)]));

    const kt2 = await withCompany(companyId, () => receiveBack({ type: 'return_request', id: randomUUID() }, [line(a, 1)]));

    expect(kt2.number).toBe('KT-000002');
    expect(await docOf(kt2.documentId)).toMatchObject({ source_type: 'return_request' });
  });

  it('SKU của công ty khác → lỗi, không lập phiếu', async () => {
    const A = await companyWithVariants(0);
    const B = await companyWithVariants(1);
    const k = randomUUID();

    await expect(withCompany(A.companyId, () => receiveBack({ type: 'package', id: k }, [line(B.variants[0]!, 1)]))).rejects.toThrow(
      /không thuộc công ty/,
    );
    expect(await docsOfSource(k)).toEqual([]);
  });

  it('không có dòng nào, hoặc loại nguồn lạ → lỗi lập trình', async () => {
    const { companyId, variants } = await companyWithVariants();
    const a = variants[0]!;

    await expect(withCompany(companyId, () => receiveBack({ type: 'package', id: randomUUID() }, []))).rejects.toThrow(/không có dòng/);
    await expect(
      withCompany(companyId, () => receiveBack({ type: 'order' as 'package', id: randomUUID() }, [line(a, 1)])),
    ).rejects.toThrow(/không hợp lệ/);
  });
});
