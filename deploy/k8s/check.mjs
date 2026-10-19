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

for (const d of docs) {
  if (d.kind !== 'Namespace' && d.metadata.namespace !== NS) errors.push(`${d.kind}/${d.metadata.name}: namespace là ${d.metadata.namespace}, cần ${NS}`);
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
    if (APPS.includes(d.metadata.name)) images.add(c.image);

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
