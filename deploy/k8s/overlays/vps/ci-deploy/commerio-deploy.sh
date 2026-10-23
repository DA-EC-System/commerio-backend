#!/usr/bin/env bash
# Lệnh duy nhất mà khoá SSH của CI chạy được (forced command trong ~ci-deploy/.ssh/authorized_keys):
#   restrict,command="/usr/local/bin/commerio-deploy fe" ssh-ed25519 …        (khoá của repo FE)
#   restrict,command="/usr/local/bin/commerio-deploy backend" ssh-ed25519 …   (khoá của repo backend)
# CI gửi đúng một chuỗi là tag (ssh ci-deploy@host sha-abc1234). Đổi image rồi chờ rollout; pod mới không lên thì mã lỗi khác 0.
set -euo pipefail

tag=${SSH_ORIGINAL_COMMAND:-}
[[ $tag =~ ^sha-[0-9a-f]{7}$ ]] || { echo "Tag phải có dạng sha-<7 ký tự hex>, nhận: '$tag'" >&2; exit 2; }

# Mỗi phần tử: <Deployment>=<image không kèm tag>. Container cùng tên với Deployment.
case ${1:-} in
  fe) targets=(fe=ghcr.io/da-ec-system/commerio-fe fe-mock=ghcr.io/da-ec-system/commerio-fe-mock) ;;
  backend) targets=(api=ghcr.io/da-ec-system/commerio-backend worker=ghcr.io/da-ec-system/commerio-backend realtime=ghcr.io/da-ec-system/commerio-backend) ;;
  *) echo "Không rõ thành phần: '${1:-}'" >&2; exit 2 ;;
esac

k() { kubectl --kubeconfig "$HOME/.kube/config" -n commerio "$@"; }
for t in "${targets[@]}"; do d=${t%%=*}; k set image "deploy/$d" "$d=${t#*=}:$tag"; done
for t in "${targets[@]}"; do k rollout status "deploy/${t%%=*}" --timeout=180s; done
