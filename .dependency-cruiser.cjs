// Luật ranh giới module (docs/17 mục 2). Chạy: npm run depcruise

// Lớp module lớn (src/modules/CLAUDE.md): module lớn chỉ được import index.ts của module lớn cùng lớp hoặc lớp thấp hơn.
// Cùng lớp thì không luật nào chặn, vòng tròn do luật khong-vong-tron bắt.
const LAYERS = [['core'], ['product'], ['order'], ['finance'], ['channel', 'insight']];
const group = (names) => `^src/modules/(${names.join('|')})/`;
const layerRules = LAYERS.slice(0, -1).map((layer, i) => ({
  name: `lop-${layer.join('-')}`,
  comment: 'Module lớn lớp dưới không gọi module lớn lớp trên (bảng lớp ở src/modules/CLAUDE.md).',
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
      comment: 'Trong core, chiều gọi là staff → access (Documents/21 D15).',
      severity: 'error',
      from: { path: '^src/modules/core/access/' },
      to: { path: '^src/modules/core/staff/' },
    },
    {
      name: 'module-chi-qua-index',
      comment: 'Module lớn khác chỉ được import từ modules/<lớn>/index.ts, không import thẳng module con bên trong.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'module-con-chi-qua-index',
      comment: 'Trong một module lớn, module con khác chỉ được import từ index.ts của module con đó.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/([^/]+)/' },
      to: {
        path: '^src/modules/$1/[^/]+/',
        pathNot: ['^src/modules/$1/$2/', '^src/modules/$1/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'module-con-khong-goi-index-lon',
      comment: 'index.ts của module lớn re-export module con; module con gọi lại nó sẽ thành vòng.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/[^/]+/' },
      to: { path: '^src/modules/$1/index\\.ts$' },
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
      comment: 'Client Kafka chỉ dùng trong hạ tầng outbox của platform (#38); module khác phát và nghe qua core/index.ts.',
      severity: 'error',
      from: { pathNot: '^src/modules/core/platform/service/outbox/' },
      to: { path: 'node_modules/@confluentinc/kafka-javascript/' },
    },
    {
      name: 'wiring-chi-qua-index',
      comment: 'src/wiring.ts nối module bằng API công khai, chỉ import modules/<lớn>/index.ts.',
      severity: 'error',
      from: { path: '^src/wiring\\.ts$' },
      to: { path: '^src/modules/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'domain-thuan',
      comment: 'domain chỉ chứa luật nghiệp vụ, không gọi lớp nào khác của module.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/[^/]+/domain/' },
      to: { path: '^src/modules/[^/]+/[^/]+/(api|service|repository)/' },
    },
    {
      name: 'service-khong-biet-http',
      comment: 'service không biết req/res; HTTP chỉ nằm ở lớp api.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/[^/]+/service/' },
      to: { path: ['^src/modules/[^/]+/[^/]+/api/', 'node_modules/express/'] },
    },
    {
      name: 'repository-khong-goi-len',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/[^/]+/repository/' },
      to: { path: '^src/modules/[^/]+/[^/]+/(api|service)/' },
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
