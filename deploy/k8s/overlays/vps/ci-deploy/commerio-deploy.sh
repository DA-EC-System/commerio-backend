#!/usr/bin/env bash
# Lệnh duy nhất mà khoá SSH của CI chạy được (forced command trong ~ci-deploy/.ssh/authorized_keys):
#   restrict,command="/usr/local/bin/commerio-deploy fe" ssh-ed25519 …        (khoá của repo FE)
#   restrict,command="/usr/local/bin/commerio-deploy backend" ssh-ed25519 …   (khoá của repo backend)
# CI gửi đúng một chuỗi là tag (ssh ci-deploy@host sha-abc1234). Đổi image rồi chờ rollout; pod mới không lên thì mã lỗi khác 0.
set -euo pipefail

tag=${SSH_ORIGINAL_COMMAND:-}
[[ $tag =~ ^sha-[0-9a-f]{7}$ ]] || { echo "Tag phải có dạng sha-<7 ký tự hex>, nhận: '$tag'" >&2; exit 2; }

case ${1:-} in
  fe) image=ghcr.io/da-ec-system/commerio-fe; deploys=(fe) ;;
  backend) image=ghcr.io/da-ec-system/commerio-backend; deploys=(api worker realtime) ;;
  *) echo "Không rõ thành phần: '${1:-}'" >&2; exit 2 ;;
esac

k() { kubectl --kubeconfig "$HOME/.kube/config" -n commerio "$@"; }
for d in "${deploys[@]}"; do k set image "deploy/$d" "$d=$image:$tag"; done
for d in "${deploys[@]}"; do k rollout status "deploy/$d" --timeout=180s; done
