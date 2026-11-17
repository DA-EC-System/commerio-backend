// Ngữ cảnh lời gọi sàn cho hạn mức (#215): `asManual` cho lượt Tải lại SKU chạy nền vẫn tính như bấm tay (#361).
import { describe, expect, it } from 'vitest';
import { asManual, callScope, forCompany, inBackground } from '#src/modules/channel/channel/service/marketplaces/call-scope.ts';

const companyId = '00000000-0000-4000-8000-000000000001';

describe('asManual', () => {
  it('trong việc nền vẫn tính như bấm tay, giữ công ty', async () => {
    const scope = await forCompany(companyId, () => inBackground(() => asManual(async () => callScope())));
    expect(scope).toEqual({ companyId, background: false });
  });

  it('`forCompany` lồng bên trong giữ cờ bấm tay (phiên `shopSession` gắn công ty sau)', async () => {
    const scope = await inBackground(() => asManual(async () => forCompany(companyId, () => callScope())));
    expect(scope).toEqual({ companyId, background: false });
  });
});
