import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const db = () => testPool();

const insertEntry = (q: (s: string, v: unknown[]) => Promise<unknown>, c: string, cols: Record<string, unknown>) => {
  const all = { company_id: c, kind: 'revenue', amount: '100000', is_estimate: true, occurred_on: '2026-10-28', ...cols };
  const keys = Object.keys(all);
  return q(
    `insert into finance.ledger_entries (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  ) as Promise<{ rows: { id: string }[] }>;
};
const asOwner = (s: string, v: unknown[]) => db().query(s, v);

// Sổ tiền và phiên bản cấu hình (Documents/19 mục 3.5; 25 §10, T1, T5).
describe('sổ tiền', () => {
  it('chỉ thêm: role ứng dụng ghi được, không sửa, không xoá', async () => {
    const c = randomUUID();
    await expect(asCompany(c, (x) => insertEntry((s, v) => x.query(s, v), c, {}))).resolves.toBeDefined();
    await expect(
      asCompany(c, async (x) => {
        await insertEntry((s, v) => x.query(s, v), c, {});
        await x.query("update finance.ledger_entries set amount = '1'");
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asCompany(c, async (x) => {
        await insertEntry((s, v) => x.query(s, v), c, {});
        await x.query('delete from finance.ledger_entries');
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('dòng thực tế thay đúng một dòng ước tính; dòng thay không được là ước tính', async () => {
    const c = randomUUID();
    const est = (await insertEntry(asOwner, c, {})).rows[0]!.id;
    await expect(insertEntry(asOwner, c, { is_estimate: true, replaces_entry_id: est })).rejects.toThrow(
      /"ledger_entries_actual_replaces"/,
    );
    await expect(insertEntry(asOwner, c, { is_estimate: false, replaces_entry_id: est })).resolves.toBeDefined();
    await expect(insertEntry(asOwner, c, { is_estimate: false, replaces_entry_id: est })).rejects.toThrow(/ledger_entries_replaces_uq/);
  });

  it('khoản 0 đồng bị từ chối; dòng điều chỉnh bắt buộc lý do', async () => {
    const c = randomUUID();
    await expect(insertEntry(asOwner, c, { amount: '0' })).rejects.toThrow(/"ledger_entries_amount"/);
    await expect(insertEntry(asOwner, c, { kind: 'adjustment' })).rejects.toThrow(/"ledger_entries_adjustment_reason"/);
  });
});

describe('trạng thái tiền của đơn', () => {
  it('đã xử lý lệch phải có người chốt và lý do; người duyệt khác người chốt', async () => {
    const c = randomUUID();
    const insert = (cols: Record<string, unknown>) => {
      const all = { order_id: randomUUID(), company_id: c, ...cols };
      const keys = Object.keys(all);
      return db().query(
        `insert into finance.order_settlements (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    await expect(insert({ status: 'resolved', settled_total: '1' })).rejects.toThrow(/"order_settlements_resolved"/);
    const u = randomUUID();
    await expect(
      insert({ status: 'resolved', settled_total: '1', resolved_by: u, resolved_reason: 'sàn trừ thêm phí', approved_by: u }),
    ).rejects.toThrow(/"order_settlements_approver"/);
    await expect(insert({ status: 'settled' })).rejects.toThrow(/"order_settlements_settled"/);
  });
});

describe('phiên bản cấu hình', () => {
  const insertVersion = (c: string, cols: Record<string, unknown>) => {
    const all = { company_id: c, kind: 'tax_regime', payload: '{}', ...cols };
    const keys = Object.keys(all);
    return db().query(
      `insert into finance.config_versions (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(all),
    );
  };

  it('cấu hình phí phải gắn gian hàng; cấu hình khác không gắn', async () => {
    const c = randomUUID();
    await expect(insertVersion(c, { kind: 'fee' })).rejects.toThrow(/"config_versions_fee_shop"/);
    await expect(insertVersion(c, { kind: 'fee', shop_id: randomUUID() })).resolves.toBeDefined();
    await expect(insertVersion(c, { shop_id: randomUUID() })).rejects.toThrow(/"config_versions_fee_shop"/);
  });

  it('bản hiệu lực phải có ngày và người duyệt khác người soạn', async () => {
    const c = randomUUID();
    const u = randomUUID();
    await expect(insertVersion(c, { status: 'active', approved_by: u })).rejects.toThrow(/"config_versions_effective"/);
    await expect(insertVersion(c, { status: 'active', effective_from: '2026-11-01' })).rejects.toThrow(/"config_versions_approved"/);
    await expect(
      insertVersion(c, { status: 'active', effective_from: '2026-11-01', created_by: u, approved_by: u }),
    ).rejects.toThrow(/"config_versions_second_person"/);
  });

  it('hai bản cùng loại, cùng gian hàng không được hiệu lực chồng ngày; bản nháp không bị chặn', async () => {
    const c = randomUUID();
    const shop = randomUUID();
    const active = (from: string, to: string | null) =>
      insertVersion(c, { kind: 'fee', shop_id: shop, status: 'active', effective_from: from, effective_to: to, approved_by: randomUUID() });
    await active('2026-10-01', '2026-11-30');
    await expect(active('2026-11-15', null)).rejects.toThrow(/config_versions_no_overlap/);
    await expect(active('2026-12-01', null)).resolves.toBeDefined();
    await expect(insertVersion(c, { kind: 'fee', shop_id: shop, effective_from: '2026-11-15' })).resolves.toBeDefined();
    await expect(
      insertVersion(c, { kind: 'fee', shop_id: randomUUID(), status: 'active', effective_from: '2026-11-15', approved_by: randomUUID() }),
    ).resolves.toBeDefined();
  });
});
