import { describe, expect, inject, it } from 'vitest';
import { GoodsReceipt } from '#src/modules/product/purchasing/api/schemas.ts';
import { api } from './lib/client.ts';
import { expectContract, expectProblem, served } from './lib/contract.ts';
import { countedReceipt, newSupplier, newVariant, orderedRequest } from './lib/fixtures.ts';

// Ca theo sơ đồ A2 Phiếu nhận (Documents/kiem-thu/ca-theo-so-do.md, mục A2) gọi qua HTTP vào server đang chạy.
// Hiện có ca tách nhiệm người ghi sổ (Documents/25 §11, US-NH-07): Nhân viên kho vừa lập đề nghị vừa ghi sổ thì bị chặn.

const tokens = inject('tokens');

describe.runIf(await served('POST /purchasing/goods-receipts'))('A2 Phiếu nhận: tách nhiệm người ghi sổ', () => {
  it('A2-01p: Kho A lập đề nghị rồi tự ghi sổ nhận 409 second_person_required; Kho B ghi sổ được', async () => {
    const variantId = await newVariant(tokens.ceo);
    const supplierId = await newSupplier(tokens.kho);
    const request = await orderedRequest(tokens.kho, tokens.ceo, supplierId, variantId);
    const receipt = await countedReceipt(tokens.kho, request.id);

    const self = await api(tokens.kho).post(`/purchasing/goods-receipts/${receipt.id}/post`, { version: receipt.version });
    expectProblem(self, 409, 'second_person_required');

    // Kho B (tài khoản kho thứ hai của công ty QA A) ghi sổ cùng phiếu, cùng version thì được.
    const other = await api(tokens.lead).post(`/purchasing/goods-receipts/${receipt.id}/post`, { version: receipt.version });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expectContract(GoodsReceipt, other.body);
  });
});
