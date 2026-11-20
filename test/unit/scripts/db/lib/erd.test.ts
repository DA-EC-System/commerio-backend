import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildErdData, layoutErd, renderErdPage, type ErdData, type ErdLayout } from '../../../../../scripts/db/lib/erd.ts';
import { buildSchemaModel } from '../../../../../scripts/db/lib/schema-doc.ts';

// Dựng ERD từ bộ migration thật của repo (như `npm run db:erd`), không mở trình duyệt.
describe('ERD dựng từ migration và schema.ts', () => {
  let data: ErdData;
  let layout: ErdLayout;
  beforeAll(async () => {
    const model = buildSchemaModel('db/migrations', '.');
    data = buildErdData(model, 'abc1234');
    layout = await layoutErd(data);
  }, 60_000);

  it('có đủ mọi bảng và quan hệ của tài liệu schema, kèm phiên bản V', () => {
    const model = buildSchemaModel('db/migrations', '.');
    expect(data.tables.map((t) => t.id)).toEqual(model.tables.map((t) => t.id));
    expect(data.relations).toHaveLength(model.relations.length);
    expect(data.source.version).toBe(model.version);
  });

  it('mọi bảng có vị trí ở tổng quan và ở sơ đồ module của nó', () => {
    for (const t of data.tables) {
      expect(layout.overview.nodes[t.id], t.id).toBeDefined();
      expect(layout.modules[t.schema]!.full.nodes[t.id], t.id).toBeDefined();
    }
  });

  it('khoá ngoại viết tay và trigger đi vào dữ liệu của trang', () => {
    expect(data.relations.some((r) => r.kind === 'fk-sql')).toBe(true);
    expect(data.tables.find((t) => t.id === 'order.package_lines')!.extra.map((x) => x.name)).toContain('package_lines_line_total');
  });

  it('trang nhúng dữ liệu, chuỗi </script> trong comment không đóng thẻ sớm', () => {
    const tampered: ErdData = { ...data, tables: [{ ...data.tables[0]!, desc: 'thử </script><script>alert(1)</script>' }] };
    const html = renderErdPage(readFileSync('scripts/db/erd/page.html', 'utf8'), tampered, layout);
    const payload = /<script type="application\/json" id="erd-payload">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(payload).data.tables[0].desc).toBe('thử </script><script>alert(1)</script>');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});
