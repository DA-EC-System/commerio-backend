#!/usr/bin/env bash
# Dựng Dozzle (/logs/) trên staging, chạy trên VPS bằng root từ bất kỳ thư mục nào:
#   bash /opt/commerio/repo/deploy/k8s/overlays/vps/dozzle/setup.sh               # lần đầu: tạo tài khoản + apply
#   bash /opt/commerio/repo/deploy/k8s/overlays/vps/dozzle/setup.sh --doi-mat-khau # đổi mật khẩu tài khoản chung
# Một tài khoản dùng chung cả nhóm, tên "commerio". Mật khẩu sinh ngẫu nhiên, in ra MỘT lần ở cuối; file users.yml
# chỉ giữ bản băm bcrypt (băm bằng `caddy hash-password` trong pod caddy, mật khẩu đi qua stdin, không lên dòng lệnh).
# Chỉ apply các object của Dozzle, ConfigMap Caddyfile và Deployment caddy, không apply cả overlay: apply -k đặt lại
# image app về tag develop (deploy/k8s/README.md). Caddy khởi động lại vài giây vì Caddyfile đổi.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OVERLAY=$(dirname "$HERE")
USERS="$HERE/users.yml"
USERNAME=commerio
K="kubectl -n commerio"

new_password=""
if [ ! -f "$USERS" ] || [ "${1:-}" = "--doi-mat-khau" ]; then
  new_password=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
  hash=$(printf '%s\n' "$new_password" | $K exec -i deploy/caddy -- caddy hash-password | tail -n1)
  case "$hash" in
    '$2'*) ;;
    *) echo "Không băm được mật khẩu (kết quả: $hash)" >&2; exit 1 ;;
  esac
  umask 077
  cat >"$USERS" <<EOF
users:
  $USERNAME:
    name: Nhóm Commerio
    password: '$hash'
EOF
  echo "Đã ghi $USERS"
fi

python3 - "$OVERLAY" >/tmp/dozzle-apply.yaml <<'PY'
import subprocess, sys, yaml
out = subprocess.run(["kubectl", "kustomize", sys.argv[1]], check=True, capture_output=True, text=True).stdout
keep = []
for doc in yaml.safe_load_all(out):
    if not doc:
        continue
    kind, name = doc["kind"], doc["metadata"]["name"]
    if ("dozzle" in name
            or (kind == "ConfigMap" and name.startswith("caddyfile-"))
            or (kind == "Deployment" and name == "caddy")):
        keep.append(doc)
print(yaml.safe_dump_all(keep, sort_keys=False))
PY

echo "Sẽ apply:"
grep -E '^(kind|  name):' /tmp/dozzle-apply.yaml | paste - - | sed 's/^/  /'
kubectl apply -f /tmp/dozzle-apply.yaml
rm -f /tmp/dozzle-apply.yaml

# Secret đổi tên theo hash nên Deployment dozzle tự thay pod; chờ cả hai lên.
$K rollout status deploy/dozzle --timeout=120s
$K rollout status deploy/caddy --timeout=120s

domain=$(grep '^SITE_ADDRESS=' "$OVERLAY/caddy/.env" | cut -d= -f2- || true)
echo
echo "Dozzle: https://$domain/logs/   tài khoản: $USERNAME"
if [ -n "$new_password" ]; then
  echo "Mật khẩu (chỉ in lần này, gửi cho nhóm rồi xoá khỏi màn hình): $new_password"
else
  echo "Mật khẩu giữ như cũ. Quên thì chạy lại với --doi-mat-khau."
fi
