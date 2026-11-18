// Kiểm tĩnh bản build của một overlay, những điều kubeconform không bắt được (#36).
// Đầu vào: mảng JSON các object, từ  kubectl kustomize deploy/k8s/overlays/<nơi> | yq ea -o=json -I=0 '[.]'
// Thoát mã 1 và in từng lỗi nếu có.
import process from 'node:process';

// Đọc stdin bất đồng bộ: readFileSync(0) ném EAGAIN khi stdin là pipe non-blocking (runner Linux của CI).
let input = '';
for await (const chunk of process.stdin) input += chunk;
const docs = JSON.parse(input);
const errors = [];
const NS = 'commerio';
const APPS = ['api', 'worker', 'realtime'];

const has = (kind, name) => docs.some((d) => d.kind === kind && d.metadata.name === name);
const workloads = docs.filter((d) => ['Deployment', 'StatefulSet', 'Job', 'CronJob', 'DaemonSet'].includes(d.kind));

// Object cấp cụm không có namespace. ClusterRole chỉ dùng cho Dozzle đọc node (overlays/vps/dozzle.yaml).
const CLUSTER_SCOPED = ['Namespace', 'ClusterRole', 'ClusterRoleBinding'];
for (const d of docs) {
  if (!CLUSTER_SCOPED.includes(d.kind) && d.metadata.namespace !== NS) errors.push(`${d.kind}/${d.metadata.name}: namespace là ${d.metadata.namespace}, cần ${NS}`);
}

// Migration chạy từ runner CI (Documents/21 V36), không chạy trong cluster.
for (const d of workloads) {
  if (d.kind === 'Job' || d.kind === 'CronJob') errors.push(`${d.kind}/${d.metadata.name}: không chạy Job trong cluster (V36)`);
}

const images = new Set();
for (const d of workloads) {
  const spec = d.spec.template.spec;
  const where = `${d.kind}/${d.metadata.name}`;
  // Không để Kubernetes tiêm API_PORT=tcp://…, KAFKA_PORT=… đè biến của app và của ảnh Kafka.
  if (spec.enableServiceLinks !== false) errors.push(`${where}: thiếu enableServiceLinks: false`);
  if (spec.initContainers?.length) errors.push(`${where}: có initContainers`);

  for (const c of spec.containers) {
    const r = c.resources ?? {};
    if (!r.requests?.cpu || !r.requests?.memory || !r.limits?.memory) {
      errors.push(`${where}/${c.name}: thiếu requests.cpu, requests.memory hoặc limits.memory`);
    }
    // api, realtime có hai bản blue, green (base/bluegreen); so theo tên gốc.
    if (APPS.includes(d.metadata.name.replace(/-(blue|green)$/, ''))) images.add(c.image);

    // Mọi ConfigMap, Secret được tham chiếu phải có trong bản build (cùng namespace, đúng tên có hash).
    for (const e of c.envFrom ?? []) {
      if (e.configMapRef && !has('ConfigMap', e.configMapRef.name)) errors.push(`${where}/${c.name}: không có ConfigMap ${e.configMapRef.name}`);
      if (e.secretRef && !has('Secret', e.secretRef.name)) errors.push(`${where}/${c.name}: không có Secret ${e.secretRef.name}`);
    }
    for (const e of c.env ?? []) {
      const ref = e.valueFrom?.configMapKeyRef ?? e.valueFrom?.secretKeyRef;
      const kind = e.valueFrom?.configMapKeyRef ? 'ConfigMap' : 'Secret';
      if (ref && !has(kind, ref.name)) errors.push(`${where}/${c.name}: không có ${kind} ${ref.name}`);
    }
  }
  for (const v of spec.volumes ?? []) {
    if (v.configMap && !has('ConfigMap', v.configMap.name)) errors.push(`${where}: volume ${v.name} trỏ ConfigMap ${v.configMap.name} không có`);
    if (v.secret && !has('Secret', v.secret.secretName)) errors.push(`${where}: volume ${v.name} trỏ Secret ${v.secret.secretName} không có`);
    if (v.persistentVolumeClaim && !has('PersistentVolumeClaim', v.persistentVolumeClaim.claimName)) {
      errors.push(`${where}: volume ${v.name} trỏ PVC ${v.persistentVolumeClaim.claimName} không có`);
    }
  }
}

/**
 * Số pod cùng sống nhiều nhất của một Deployment lúc đổi image. Bản màu (`-blue`, `-green`): 1, vì commerio-deploy.sh
 * đặt image cho màu nghỉ khi nó đang 0 bản rồi mới scale lên 1, và cả hai màu đã được cộng riêng. Còn lại: `replicas`
 * cộng số pod dư của RollingUpdate (`maxSurge`, mặc định 25%, phần trăm làm tròn lên); `Recreate` không có pod dư.
 */
function peakPods(d) {
  if (/-(blue|green)$/.test(d.metadata.name)) return 1;
  const replicas = d.spec.replicas ?? 1;
  if (d.spec.strategy?.type === 'Recreate') return replicas;
  const surge = d.spec.strategy?.rollingUpdate?.maxSurge ?? '25%';
  const extra = typeof surge === 'string' && surge.endsWith('%') ? Math.ceil((replicas * Number.parseFloat(surge)) / 100) : Number(surge);
  return replicas + extra;
}

// Ngân sách kết nối DB (#335): cộng DB_POOL_MAX × số pod cùng sống nhiều nhất (`peakPods`) của mọi Deployment api,
// worker, realtime trong bản build (blue và green đều tính vì lúc đổi màu cả hai cùng sống), thêm 1 cho db:migrate,
// không vượt pool size của Session pooler. CI truyền DB_POOL_SIZE (biến STAGING_DB_POOL_SIZE) khi kiểm overlay vps;
// không truyền thì bỏ qua.
const poolSize = Number(process.env.DB_POOL_SIZE ?? 0);
if (poolSize > 0) {
  const parts = workloads
    .filter((d) => d.kind === 'Deployment' && APPS.includes(d.metadata.name.replace(/-(blue|green)$/, '')))
    .map((d) => {
      const value = d.spec.template.spec.containers.flatMap((c) => c.env ?? []).find((e) => e.name === 'DB_POOL_MAX')?.value;
      // Không đặt thì app dùng mặc định 10 (src/shared/config/env.ts).
      return { name: d.metadata.name, max: value === undefined ? 10 : Number(value), pods: peakPods(d) };
    });
  const total = parts.reduce((sum, p) => sum + p.max * p.pods, 0) + 1;
  const detail = parts.map((p) => (p.pods === 1 ? `${p.name} ${p.max}` : `${p.name} ${p.max} × ${p.pods}`)).join(' + ');
  if (total > poolSize) errors.push(`kết nối DB: ${detail} + 1 (migrate) = ${total}, vượt pool size ${poolSize} của Session pooler`);
  else process.stdout.write(`kết nối DB: ${detail} + 1 (migrate) = ${total} ≤ ${poolSize}\n`);
}

if (images.size !== 1) errors.push(`api, worker, realtime phải cùng một image, đang có: ${[...images].join(', ')}`);

// Kafka phải ghi vào ổ của StatefulSet, không vào /tmp của container.
const kafka = docs.find((d) => d.kind === 'StatefulSet' && d.metadata.name === 'kafka');
const kc = kafka?.spec.template.spec.containers[0];
const logDirs = kc?.env?.find((e) => e.name === 'KAFKA_LOG_DIRS')?.value;
const mounts = (kc?.volumeMounts ?? []).filter((m) => kafka.spec.volumeClaimTemplates?.some((t) => t.metadata.name === m.name));
if (!kafka) errors.push('không có StatefulSet kafka');
else if (!mounts.some((m) => m.mountPath === logDirs)) errors.push(`kafka: KAFKA_LOG_DIRS=${logDirs} không trùng mountPath của PVC`);

// /metrics, Prometheus, Grafana không mở ra ngoài: chỉ caddy được là LoadBalancer/NodePort.
for (const d of docs.filter((x) => x.kind === 'Service')) {
  if (['LoadBalancer', 'NodePort'].includes(d.spec.type) && d.metadata.name !== 'caddy') errors.push(`Service/${d.metadata.name}: chỉ caddy được mở ra ngoài`);
  // targetPort theo tên phải có trên pod được chọn, không thì Service không có đích (vd đổi tên cổng realtime).
  const pods = workloads.filter((w) => Object.entries(d.spec.selector ?? {}).every(([k, v]) => w.spec.template.metadata.labels?.[k] === v));
  for (const p of d.spec.ports ?? []) {
    if (typeof p.targetPort !== 'string') continue;
    const ok = pods.some((w) => w.spec.template.spec.containers.some((c) => c.ports?.some((cp) => cp.name === p.targetPort)));
    if (!ok) errors.push(`Service/${d.metadata.name}: targetPort ${p.targetPort} không có trên pod nào được chọn`);
  }
}

// Panel stat hiện giá trị hiện tại: truy vấn range + lastNotNull giữ cả pod đã bị thay (đo ở lát 7).
for (const cm of docs.filter((x) => x.kind === 'ConfigMap' && x.metadata.name.startsWith('grafana-dashboards'))) {
  for (const [file, text] of Object.entries(cm.data ?? {})) {
    const panels = JSON.parse(text).panels.flatMap((p) => [p, ...(p.panels ?? [])]);
    for (const p of panels.filter((x) => x.type === 'stat')) {
      if (p.targets?.some((t) => t.instant !== true || t.range === true)) errors.push(`${file}: panel stat "${p.title}" cần truy vấn instant`);
    }
  }
}

if (errors.length) {
  for (const e of errors) process.stderr.write(`LỖI ${e}
`);
  process.exit(1);
}
process.stdout.write(`OK: ${docs.length} object, ${workloads.length} workload, image ${[...images][0]}
`);
