// Luật ranh giới module (docs/17 mục 2). Chạy: npm run depcruise
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
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
      to: { path: '^src/(modules|entrypoints)/|^src/app\\.ts$' },
    },
    {
      name: 'module-khong-phu-thuoc-entrypoint',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/entrypoints/|^src/app\\.ts$' },
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
    exclude: { path: '\\.test\\.ts$' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js'] },
  },
};
