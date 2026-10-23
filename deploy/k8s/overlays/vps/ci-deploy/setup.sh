#!/usr/bin/env bash
# Chạy một lần bằng root trên VPS, sau kubectl apply -k deploy/k8s/overlays/vps (cần Secret ci-deployer-token).
# Tạo tài khoản ci-deploy (không mật khẩu, chỉ đăng nhập bằng khoá có forced command), cài commerio-deploy,
# viết kubeconfig từ token của ServiceAccount ci-deployer, sinh khoá cho repo nào chưa có.
# Khoá riêng để ở /root/ci-deploy-<fe|backend|test-ui>.key: đưa vào secret STAGING_SSH_KEY của repo tương ứng rồi xoá (README).
# Chạy lại không sao: giữ khoá đã cài, viết lại kubeconfig và script.
set -euo pipefail
cd "$(dirname "$0")"
umask 077

id ci-deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh ci-deploy
install -m 755 commerio-deploy.sh /usr/local/bin/commerio-deploy

token=""
for _ in $(seq 1 30); do
  token=$(kubectl -n commerio get secret ci-deployer-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)
  [ -n "$token" ] && break
  sleep 1
done
[ -n "$token" ] || { echo "Chưa có token trong Secret ci-deployer-token: apply overlay vps trước" >&2; exit 1; }
ca=$(kubectl -n commerio get secret ci-deployer-token -o jsonpath='{.data.ca\.crt}')

home=/home/ci-deploy
install -d -m 700 -o ci-deploy -g ci-deploy "$home/.kube" "$home/.ssh"
cat > "$home/.kube/config" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: k3s
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: $ca
users:
  - name: ci-deployer
    user:
      token: $token
contexts:
  - name: ci-deployer
    context: { cluster: k3s, user: ci-deployer, namespace: commerio }
current-context: ci-deployer
EOF
unset token

keys=$home/.ssh/authorized_keys
touch "$keys"
for t in fe backend test-ui; do
  grep -q "commerio-deploy $t\"" "$keys" && continue
  rm -f "/root/ci-deploy-$t.key" "/root/ci-deploy-$t.key.pub"
  ssh-keygen -q -t ed25519 -N '' -C "github-actions commerio-deploy $t" -f "/root/ci-deploy-$t.key"
  printf 'restrict,command="/usr/local/bin/commerio-deploy %s" %s\n' "$t" "$(cat "/root/ci-deploy-$t.key.pub")" >> "$keys"
  rm -f "/root/ci-deploy-$t.key.pub"
  echo "Khoá mới cho $t: /root/ci-deploy-$t.key"
done
chown -R ci-deploy:ci-deploy "$home/.kube" "$home/.ssh"
chmod 600 "$home/.kube/config" "$keys"
echo "authorized_keys: $(wc -l < "$keys") dòng"
