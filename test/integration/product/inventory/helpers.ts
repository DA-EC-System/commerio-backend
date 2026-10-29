import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createVariant } from '../../helpers/catalog.ts';
import { registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

/** Công ty mới qua API đăng ký (không cần token) và `n` biến thể của nó. */
export async function companyWithVariants(n = 1) {
  const { companyId } = await registerCompany();
  const variants: string[] = [];
  for (let i = 0; i < n; i++) variants.push((await createVariant(companyId)).variantId);
  return { companyId, variants };
}

/**
 * Nhập `quantity` hàng vào tồn thực bằng một phiếu kiểm kê đã ghi sổ, ghi thẳng bằng role chủ bảng: luồng ghi sổ
 * qua API làm ở issue phiếu kho (Documents/21 mục 15). Giá vốn bình quân tính lại như lúc nhận hàng.
 */
export async function receive(companyId: string, variantId: string, quantity: number, unitCost: number | string, doneBy?: string) {
  const db = await testPool().connect();
  try {
    await db.query('begin');
    const doc = await db.query<{ id: string }>(
      `insert into product.stock_documents (company_id, number, kind, status, counted_at, posted_at)
       values ($1, $2, 'stocktake', 'posted', now(), now()) returning id`,
      [companyId, `KK-T${randomUUID().slice(0, 8)}`],
    );
    const level = await db.query<{ on_hand: number }>(
      `insert into product.stock_levels (company_id, variant_id, on_hand, avg_cost) values ($1, $2, $3, $4)
       on conflict (company_id, variant_id) do update set
         avg_cost = round((stock_levels.on_hand * stock_levels.avg_cost + excluded.on_hand * excluded.avg_cost)
                          / (stock_levels.on_hand + excluded.on_hand), 2),
         on_hand = stock_levels.on_hand + excluded.on_hand,
         version = stock_levels.version + 1
       returning on_hand`,
      [companyId, variantId, quantity, String(unitCost)],
    );
    await db.query(
      `insert into product.stock_moves
         (company_id, variant_id, bucket, qty_change, balance_after, unit_cost, source_type, source_id, done_by)
       values ($1, $2, 'on_hand', $3, $4, $5, 'stock_document', $6, $7)`,
      [companyId, variantId, quantity, level.rows[0]!.on_hand, String(unitCost), doc.rows[0]!.id, doneBy ?? null],
    );
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  } finally {
    db.release();
  }
}

/**
 * Đặt số của dòng tồn (nguồn thật là kiện, phiếu kiểm hàng về, bàn giao bắt buộc, kiểm kê CEO duyệt: issue vòng đời).
 * Tồn âm cần bật `invariantBroken` cùng lúc (CHECK `stock_levels_invariant`).
 */
export async function setBuckets(
  companyId: string,
  variantId: string,
  b: { onHand?: number; reserved?: number; quarantine?: number; invariantBroken?: boolean },
) {
  await testPool().query(
    `update product.stock_levels set on_hand = coalesce($3, on_hand), reserved = coalesce($4, reserved),
       quarantine = coalesce($5, quarantine), invariant_broken = coalesce($6, invariant_broken)
     where company_id = $1 and variant_id = $2`,
    [companyId, variantId, b.onHand ?? null, b.reserved ?? null, b.quarantine ?? null, b.invariantBroken ?? null],
  );
}

/** Lưu trữ biến thể như thao tác `archive` của catalog (Documents/21 mục 17.3). */
export async function archiveVariant(variantId: string) {
  await testPool().query(
    "update product.product_variants set business_status = 'archived', archived_at = now() where id = $1",
    [variantId],
  );
}

/** Gọi /api/v1/inventory bằng token đã chọn công ty. */
export function inv(token: string) {
  const app = testApp();
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const base = '/api/v1/inventory';
  return {
    get: (path: string) => auth(request(app).get(base + path)),
    post: (path: string, body: object) => auth(request(app).post(base + path).send(body)),
    put: (path: string, body: object) => auth(request(app).put(base + path).send(body)),
  };
}
