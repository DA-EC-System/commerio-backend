// Kiểm response theo hợp đồng (Documents/21 §1, §1.1 R1–R5) mà không cần biết server chạy code nào.
import { expect, inject } from 'vitest';
import { z } from 'zod';
import type { Res } from './client.ts';

/** Lỗi dạng Problem Details (C1): đúng mã HTTP, `code`, `type`, content type. */
export function expectProblem(res: Res, status: number, code: string) {
  expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([status, code]);
  expect(res.contentType).toContain('application/problem+json');
  expect(res.body).toMatchObject({ type: `/problems/${code}`, status });
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ENUM = /^[a-z][a-z0-9_]*$/;
/** Trường tiền theo tên (R2). Số lượng, phần trăm không khớp mẫu này. */
const MONEY = /^(amount|total|diff|net|gross|cogs|receivable|withdrawn|price|[a-z]+(Amount|Total|Cost|Price|Fee|Balance|Purchase))$/;
const DATE_FIELD = /^(effectiveFrom|effectiveTo|retroactiveFrom|occurredOn|[a-z]+On)$/;

/** Lỗi R2 (tiền số nguyên), R3 (thời điểm ISO UTC, ngày yyyy-mm-dd), R5 (enum chữ thường) trong cả cây body. */
export function ruleViolations(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => ruleViolations(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => {
    const at = `${path}.${key}`;
    const own: string[] = [];
    if (MONEY.test(key) && v !== null && !Number.isInteger(v)) own.push(`${at}: tiền phải là số nguyên đồng, nhận ${JSON.stringify(v)}`);
    if (key.endsWith('At') && v !== null && !(typeof v === 'string' && ISO_UTC.test(v))) {
      own.push(`${at}: thời điểm phải là ISO UTC có Z, nhận ${JSON.stringify(v)}`);
    }
    if (DATE_FIELD.test(key) && v !== null && !(typeof v === 'string' && DAY.test(v))) own.push(`${at}: ngày phải là yyyy-mm-dd`);
    if (key === 'status' && typeof v === 'string' && !ENUM.test(v)) own.push(`${at}: enum phải chữ thường, gạch dưới`);
    return [...own, ...ruleViolations(v, at)];
  });
}

/**
 * Body khớp schema Zod của response (R4: đủ trường, không thừa trường) và các luật R2, R3, R5.
 * Schema là bản khai trong code của chính commit đang test; server staging phải chạy cùng commit.
 */
export function expectContract(schema: z.ZodType, body: unknown) {
  const parsed = schema.safeParse(body);
  expect(parsed.success ? null : z.prettifyError(parsed.error), 'body lệch schema').toBeNull();
  // Zod bỏ trường không khai: so lại để bắt trường thừa.
  expect(parsed.data, 'body có trường không khai trong schema').toEqual(body);
  expect(ruleViolations(body)).toEqual([]);
}

/** Server có khai route này không (`GET /finance/configs`). Tắt tài liệu API thì coi như có. */
export function declared(route: string): boolean {
  const routes = inject('routes');
  if (!routes) return true;
  const [method, path] = route.split(' ');
  return routes.includes(`${method} /api/v1${path!.replace(/:(\w+)/g, '{$1}')}`);
}
