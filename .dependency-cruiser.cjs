// Luật ranh giới module (docs/17 mục 2). Chạy: npm run depcruise

// Lớp module (src/modules/CLAUDE.md): module chỉ được import index.ts của module cùng lớp hoặc lớp thấp hơn.
// Cùng lớp thì không luật nào chặn, vòng tròn do luật khong-vong-tron bắt.
const LAYERS = [
  ['platform', 'staff', 'access', 'audit', 'files'],
  ['catalog'],
  ['pricing'],
  ['identity'],
  ['inventory'],
  ['sales'],
  ['payment'],
  ['finance'],
  ['fulfillment'],
  ['channel', 'report', 'notification', 'purchasing', 'inbox', 'assistant'],
];
const group = (names) => `^src/modules/(${names.join('|')})/`;
const layerRules = LAYERS.slice(0, -1).map((layer, i) => ({
  name: `lop-${layer.join('-')}`,
  comment: 'Module lớp dưới không gọi module lớp trên (bảng lớp ở src/modules/CLAUDE.md).',
  severity: 'error',
  from: { path: group(layer) },
  to: { path: group(LAYERS.slice(i + 1).flat()) },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...layerRules,
    {
      name: 'access-khong-goi-staff',
      comment: 'Trong lớp nền, chiều gọi là staff → access (Documents/21 D15).',
      severity: 'error',
      from: { path: '^src/modules/access/' },
      to: { path: '^src/modules/staff/' },
    },
    {
      name: 'module-chi-qua-index',
      comment: 'Module khác chỉ được import từ modules/<tên>/index.ts, không import thẳng api/service/domain/repository.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'shared-khong-phu-thuoc-module',
      comment: 'shared là nền chung, không được biết module, app hay entrypoint nào.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|entrypoints)/|^src/(app|wiring)\\.ts$' },
    },
    {
      name: 'module-khong-phu-thuoc-entrypoint',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/entrypoints/|^src/(app|wiring)\\.ts$' },
    },
    {
      name: 'kafka-chi-o-outbox',
      comment: 'Client Kafka chỉ dùng trong hạ tầng outbox của platform (#38); module khác phát và nghe qua platform/index.ts.',
      severity: 'error',
      from: { pathNot: '^src/modules/platform/service/outbox/' },
      to: { path: 'node_modules/@confluentinc/kafka-javascript/' },
    },
    {
      name: 'wiring-chi-qua-index',
      comment: 'src/wiring.ts nối module bằng API công khai, chỉ import modules/<tên>/index.ts.',
      severity: 'error',
      from: { path: '^src/wiring\\.ts$' },
      to: { path: '^src/modules/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'domain-thuan',
      comment: 'domain chỉ chứa luật nghiệp vụ, không gọi lớp nào khác của module.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { path: '^src/modules/[^/]+/(api|service|repository)/' },
    },
    {
      name: 'service-khong-biet-http',
      comment: 'service không biết req/res; HTTP chỉ nằm ở lớp api.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/service/' },
      to: { path: ['^src/modules/[^/]+/api/', 'node_modules/express/'] },
    },
    {
      name: 'repository-khong-goi-len',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/repository/' },
      to: { path: '^src/modules/[^/]+/(api|service)/' },
    },
    {
      name: 'khong-vong-tron',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Tính cả `import type`: khung export chỉ chia kiểu vẫn phải đi đúng chiều lớp.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js'] },
  },
};
