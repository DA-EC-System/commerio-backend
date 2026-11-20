// ERD tương tác (npm run db:erd): dữ liệu lấy từ cùng mô hình với db/SCHEMA.md (buildSchemaModel), bố cục tính bằng ELK
// (elkjs, thuật toán layered), trang ở scripts/db/erd/page.html, dữ liệu nhúng thẳng vào trang nên mở file là xem được.
import elkModule from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { EXTERNAL_NOTE, MODULES, type DocColumn, type DocTable, type SchemaModel } from './schema-doc.ts';

/** Mô tả module lớn, module con cho thanh bên (src/modules/CLAUDE.md). */
const MODULE_DESC: Readonly<Record<string, string>> = {
  core: 'Công ty, tài khoản, nhân viên, vai trò và quyền, nhật ký, tệp, hàng sự kiện.',
  product: 'Danh mục, sản phẩm, biến thể, tồn kho, phiếu kho, mua hàng.',
  order: 'Đơn, khách hàng, kiện giao, yêu cầu trả.',
  finance: 'Thanh toán qua cổng, sổ tiền theo đơn, đối soát, cấu hình phí và thuế.',
  channel: 'Gian hàng sàn, listing kiêm ghép SKU, tính giá, đơn gốc sàn, hộp thư.',
  insight: 'Bảng số liệu dựng từ sự kiện, tài liệu nội bộ cho trợ lý.',
};
const SUB_DESC: Readonly<Record<string, string>> = {
  'core/platform': 'Công ty, phân hệ đang bật, outbox sự kiện, lịch sử chuyển trạng thái',
  'core/identity': 'Refresh token đăng nhập',
  'core/staff': 'Tài khoản, thành viên công ty, thư mời',
  'core/access': 'Vai trò có sẵn và tuỳ biến, quyền chi tiết',
  'core/audit': 'Nhật ký thao tác',
  'core/files': 'Thông tin tệp và tệp đính kèm',
  'product/catalog': 'Danh mục, thuộc tính, sản phẩm, biến thể, ảnh',
  'product/inventory': 'Số tồn, thẻ kho, phiếu kho. Nơi duy nhất đổi số tồn',
  'product/purchasing': 'Nhà cung cấp, đề nghị nhập, phiếu nhận, phiếu trả NCC',
  'order/sales': 'Đơn, hồ sơ khách hàng, yêu cầu trả',
  'order/fulfillment': 'Kiện: giữ hàng, đóng gói, bàn giao, giao, hoàn; hàng trả không khớp',
  'finance/payment': 'Mã thanh toán, giao dịch cổng, cấu hình cổng (chỉ sandbox)',
  'finance/finance': 'Sổ tiền theo đơn, đối soát quyết toán, phiếu thu, cấu hình phí và thuế',
  'channel/channel': 'Gian hàng sàn, token, listing kiêm ghép SKU, tính giá, đơn gốc sàn, category sàn',
  'channel/inbox': 'Hội thoại, tin nhắn, nhãn, ghi chú',
  'insight/report': 'Bảng dựng từ sự kiện',
  'insight/assistant': 'Tài liệu nội bộ, đoạn vector (pgvector)',
};
/** Bảng có `company_id` mà không bật RLS (test/integration/shared/rls-coverage.test.ts, RLS_EXCEPTIONS). */
const RLS_EXCEPTIONS = new Set(['core.refresh_tokens']);

// elkjs là CommonJS: dưới nodenext, kiểu của default import là cả module, lúc chạy là hàm dựng.
const ElkCtor = ((elkModule as unknown as { default?: unknown }).default ?? elkModule) as new () => ElkApi;

export interface ErdColumn {
  n: string;
  t: string;
  nn: boolean;
  pk: boolean;
  e?: string;
  d?: string;
  g?: string;
  cm?: string;
  ref?: { t: string; c: string; k: string };
  x?: { k: 'external' | 'poly'; note: string };
}
export interface ErdTable {
  id: string;
  schema: string;
  name: string;
  sub: string;
  desc: string;
  file: string;
  columns: ErdColumn[];
  pk: string[];
  uniques: { name: string; cols: string[]; nnd: boolean }[];
  indexes: DocTable['indexes'];
  checks: DocTable['checks'];
  extra: { k: string; name: string; def: string; migration: string }[];
  tenant: boolean;
  rls: boolean;
  legacy?: string;
}
export interface ErdData {
  source: { version: string; lastMigration: string; commit: string };
  modules: { id: string; label: string; layer: number; desc: string }[];
  subs: { mod: string; id: string; desc: string; tables: string[] }[];
  tables: ErdTable[];
  relations: { from: string; fromCols: string[]; to: string; toCols: string[]; kind: string; onDelete: string | null; migration: string | null }[];
  enums: Record<string, { values: string[]; desc: string; used: string[] }>;
}

function column(col: DocColumn): ErdColumn {
  const out: ErdColumn = { n: col.name, t: col.type, nn: col.notNull, pk: col.primaryKey };
  if (col.enumId) out.e = col.enumId;
  if (col.default !== null) out.d = col.default;
  if (col.generated !== null) out.g = col.generated;
  const cm = [col.doc.text, col.doc.deprecated !== null ? `Đã bỏ: ${col.doc.deprecated || 'không ghi lý do'}` : ''].filter(Boolean).join(' ');
  if (cm) out.cm = cm;
  if (col.ref) {
    const i = col.ref.fromCols.indexOf(col.name);
    out.ref = { t: col.ref.to, c: col.ref.toCols[i] ?? col.ref.toCols[0] ?? 'id', k: col.ref.kind };
  } else if (col.note) {
    out.x = { k: col.note === EXTERNAL_NOTE ? 'external' : 'poly', note: col.note };
  }
  return out;
}

export function buildErdData(model: SchemaModel, commit: string): ErdData {
  const tables: ErdTable[] = model.tables.map((t) => {
    const tenant = t.columns.some((c) => c.name === 'company_id');
    return {
      id: t.id,
      schema: t.schema,
      name: t.name,
      sub: t.sub,
      desc: t.doc.text,
      file: t.file,
      columns: t.columns.map(column),
      pk: t.pk,
      uniques: t.uniques.map((u) => ({ name: u.name, cols: u.cols, nnd: u.nullsNotDistinct })),
      indexes: t.indexes,
      checks: t.checks,
      extra: [
        ...t.manualIndexes.map((x) => ({ k: x.unique ? 'unique index viết tay' : 'index viết tay', name: x.name, def: x.definition, migration: x.migration })),
        ...t.excludes.map((x) => ({ k: 'EXCLUDE', name: x.name, def: x.definition, migration: x.migration })),
        ...t.triggers.map((x) => ({ k: 'trigger', name: x.name, def: x.definition, migration: x.migration })),
      ],
      tenant,
      rls: tenant && !RLS_EXCEPTIONS.has(t.id),
      ...(t.doc.deprecated !== null ? { legacy: t.doc.deprecated || 'Đã bỏ (thẻ @deprecated trong schema.ts).' } : {}),
    };
  });
  const enums: ErdData['enums'] = {};
  for (const [id, e] of model.enums) enums[id] = { values: e.values, desc: e.doc.text, used: [] };
  for (const t of tables) for (const c of t.columns) if (c.e) enums[c.e]?.used.push(`${t.id}.${c.n}`);
  const subs = new Map<string, ErdData['subs'][number]>();
  for (const t of tables) {
    const key = `${t.schema}/${t.sub}`;
    if (!subs.has(key)) subs.set(key, { mod: t.schema, id: t.sub, desc: SUB_DESC[key] ?? '', tables: [] });
    subs.get(key)!.tables.push(t.id);
  }
  return {
    source: { version: model.version, lastMigration: model.tag, commit },
    modules: model.schemas.map((id) => ({ id, label: MODULES[id]?.label ?? id, layer: MODULES[id]?.layer ?? 9, desc: MODULE_DESC[id] ?? '' })),
    subs: [...subs.values()],
    tables,
    relations: model.relations.map((r) => ({ from: r.from, fromCols: r.fromCols, to: r.to, toCols: r.toCols, kind: r.kind, onDelete: r.onDelete, migration: r.migration })),
    enums,
  };
}

// ---------------------------------------------------------------- bố cục
// Kích thước phải khớp CSS và hàm đo trong page.html (font mono 0.6em).

const RH = 22;
const HH = 42;
const cw = (px: number): number => px * 0.6;
const DRAWN = new Set(['fk', 'fk-sql', 'logical']);
const r1 = (v: number): number => Math.round(v * 10) / 10;

const rowWidth = (c: ErdColumn): number => 10 + 18 + c.n.length * cw(12) + 18 + (c.t.length + 1) * cw(11) + 12;
const subLine = (t: ErdTable): string => `${t.sub} · ${t.columns.length} cột${t.legacy ? ' · không còn ghi' : ''}`;
const headerWidth = (t: ErdTable): number => Math.max(16 + t.name.length * cw(13.5) + 16, 16 + subLine(t).length * 6.2 + 16);
const keyRows = (t: ErdTable): string[] => t.columns.filter((c) => c.pk || (c.ref && DRAWN.has(c.ref.k)) || c.n === 'status').map((c) => c.n);

type Box = [number, number, number, number];
interface ModuleLayout {
  w: number;
  h: number;
  nodes: Record<string, { b: Box; rows: string[]; more: number }>;
  ghosts: Record<string, Box>;
  edges: { r: number; pts: [number, number][] }[];
}
export interface ErdLayout {
  overview: { w: number; h: number; nodes: Record<string, Box>; groups: Record<string, Box>; edges: { r: number; pts: [number, number][] }[] };
  modules: Record<string, { keys: ModuleLayout; full: ModuleLayout }>;
}

const points = (e: ElkExtendedEdge, dx = 0, dy = 0): [number, number][] => {
  const s = e.sections?.[0];
  if (!s) return [];
  return [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => [r1(p.x + dx), r1(p.y + dy)]);
};

async function moduleLayout(elk: ElkApi, data: ErdData, mod: string, mode: 'keys' | 'full'): Promise<ModuleLayout> {
  const T = new Map(data.tables.map((t) => [t.id, t]));
  const tabs = data.tables.filter((t) => t.schema === mod);
  const rels = data.relations.map((r, i) => ({ ...r, i })).filter((r) => DRAWN.has(r.kind) && T.get(r.from)!.schema === mod);
  const ghostIds = [...new Set(rels.filter((r) => T.get(r.to)!.schema !== mod).map((r) => r.to))];
  const info = new Map<string, { rows: string[]; more: number }>();
  const children: ElkNode[] = [];
  for (const t of tabs) {
    const rows = mode === 'full' ? t.columns.map((c) => c.n) : keyRows(t);
    const cols = rows.map((n) => t.columns.find((c) => c.n === n)!);
    const w = Math.ceil(Math.max(200, headerWidth(t), ...cols.map(rowWidth)));
    const more = t.columns.length - rows.length;
    const h = HH + rows.length * RH + (more > 0 ? RH : 0) + 4;
    const ports = rows.flatMap((n, i) => {
      const y = HH + i * RH + RH / 2;
      return [
        { id: `${t.id}|${n}|W`, x: 0, y, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
        { id: `${t.id}|${n}|E`, x: w, y, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } },
      ];
    });
    ports.push(
      { id: `${t.id}|@|W`, x: 0, y: HH / 2, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
      { id: `${t.id}|@|E`, x: w, y: HH / 2, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } },
    );
    children.push({ id: t.id, width: w, height: h, ports, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } });
    info.set(t.id, { rows, more });
  }
  for (const g of ghostIds) {
    const w = Math.ceil(44 + g.length * cw(12));
    children.push({
      id: `ghost:${g}`,
      width: w,
      height: 30,
      ports: [{ id: `ghost:${g}|E`, x: w, y: 15, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } }],
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    });
  }
  const portOf = (tid: string, col: string | undefined, side: 'W' | 'E'): string =>
    col !== undefined && info.get(tid)!.rows.includes(col) ? `${tid}|${col}|${side}` : `${tid}|@|${side}`;
  const edges: ElkExtendedEdge[] = rels.map((r) => ({
    id: `e${r.i}`,
    sources: [T.get(r.to)!.schema !== mod ? `ghost:${r.to}|E` : portOf(r.to, r.toCols.find((c) => info.get(r.to)!.rows.includes(c)) ?? r.toCols[0], 'E')],
    targets: [portOf(r.from, r.fromCols[0], 'W')],
  }));
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '34',
      'elk.spacing.edgeNode': '18',
      'elk.spacing.edgeEdge': '9',
      'elk.layered.spacing.edgeNodeBetweenLayers': '22',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '9',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '70',
      'elk.aspectRatio': '1.7',
      'elk.padding': '[top=40,left=40,bottom=40,right=40]',
    },
    children,
    edges,
  });
  const out: ModuleLayout = { w: Math.ceil(res.width ?? 0), h: Math.ceil(res.height ?? 0), nodes: {}, ghosts: {}, edges: [] };
  for (const n of res.children ?? []) {
    const box: Box = [r1(n.x ?? 0), r1(n.y ?? 0), n.width ?? 0, n.height ?? 0];
    if (n.id.startsWith('ghost:')) out.ghosts[n.id.slice(6)] = box;
    else out.nodes[n.id] = { b: box, ...info.get(n.id)! };
  }
  for (const e of (res.edges ?? []) as ElkExtendedEdge[]) {
    const pts = points(e);
    if (pts.length) out.edges.push({ r: Number(e.id.slice(1)), pts });
  }
  return out;
}

async function overviewLayout(elk: ElkApi, data: ErdData): Promise<ErdLayout['overview']> {
  const T = new Map(data.tables.map((t) => [t.id, t]));
  const groups = new Map<string, ElkNode>();
  for (const m of data.modules) {
    const seen = new Set<string>();
    const edges: ElkExtendedEdge[] = [];
    data.relations.forEach((r, i) => {
      if (!DRAWN.has(r.kind) || r.from === r.to || T.get(r.from)!.schema !== m.id || T.get(r.to)!.schema !== m.id) return;
      const k = `${r.to}>${r.from}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ id: `e${i}`, sources: [r.to], targets: [r.from] });
    });
    groups.set(
      m.id,
      await elk.layout({
        id: m.id,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'DOWN',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.spacing.nodeNodeBetweenLayers': '34',
          'elk.spacing.nodeNode': '14',
          'elk.spacing.edgeNode': '10',
          'elk.spacing.edgeEdge': '6',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.separateConnectedComponents': 'true',
          'elk.spacing.componentComponent': '26',
          'elk.aspectRatio': '1.0',
          'elk.padding': '[top=56,left=22,bottom=22,right=22]',
        },
        children: data.tables.filter((t) => t.schema === m.id).map((t) => ({ id: t.id, width: Math.ceil(44 + t.name.length * cw(12.5)), height: 30 })),
        edges,
      }),
    );
  }
  // Hai hàng theo thứ tự lớp module: lớp thấp ở hàng trên bên trái.
  const order = data.modules.map((m) => m.id);
  const rows = [order.slice(0, 3), order.slice(3)];
  const out: ErdLayout['overview'] = { w: 0, h: 0, nodes: {}, groups: {}, edges: [] };
  let y = 40;
  let maxW = 0;
  for (const row of rows) {
    let x = 40;
    let rowH = 0;
    for (const id of row) {
      const g = groups.get(id)!;
      const gw = g.width ?? 0;
      const gh = g.height ?? 0;
      out.groups[id] = [r1(x), r1(y), Math.ceil(gw), Math.ceil(gh)];
      for (const n of g.children ?? []) out.nodes[n.id] = [r1(x + (n.x ?? 0)), r1(y + (n.y ?? 0)), n.width ?? 0, n.height ?? 0];
      for (const e of (g.edges ?? []) as ElkExtendedEdge[]) {
        const pts = points(e, x, y);
        if (pts.length) out.edges.push({ r: Number(e.id.slice(1)), pts });
      }
      x += gw + 130;
      rowH = Math.max(rowH, gh);
    }
    maxW = Math.max(maxW, x - 130);
    y += rowH + 120;
  }
  out.w = Math.ceil(maxW + 40);
  out.h = Math.ceil(y - 120 + 40);
  return out;
}

export async function layoutErd(data: ErdData): Promise<ErdLayout> {
  const elk = new ElkCtor();
  const layout: ErdLayout = { overview: await overviewLayout(elk, data), modules: {} };
  for (const m of data.modules) {
    layout.modules[m.id] = { keys: await moduleLayout(elk, data, m.id, 'keys'), full: await moduleLayout(elk, data, m.id, 'full') };
  }
  return layout;
}

// ---------------------------------------------------------------- trang

/** Trang hoàn chỉnh: khung HTML, nội dung page.html, dữ liệu nhúng trong thẻ script JSON. */
export function renderErdPage(template: string, data: ErdData, layout: ErdLayout): string {
  // `<` trong JSON đổi thành < để chuỗi `</script>` trong comment không đóng thẻ sớm.
  const payload = JSON.stringify({ data, layout }).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    '<html lang="vi">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0}[hidden]{display:none!important}</style>',
    '</head>',
    '<body>',
    `<script type="application/json" id="erd-payload">${payload}</script>`,
    template,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
