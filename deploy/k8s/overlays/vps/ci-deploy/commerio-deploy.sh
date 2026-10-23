#!/usr/bin/env bash
# Lệnh duy nhất mà khoá SSH của CI chạy được (forced command trong ~ci-deploy/.ssh/authorized_keys):
#   restrict,command="/usr/local/bin/commerio-deploy fe" ssh-ed25519 …        (khoá của repo FE)
#   restrict,command="/usr/local/bin/commerio-deploy backend" ssh-ed25519 …   (khoá của repo backend)
# CI gửi đúng một chuỗi (ssh ci-deploy@host <chuỗi>):
#   sha-abc1234   deploy bản đó
#   rollback      quay về màu vừa nghỉ (image của lần deploy trước vẫn còn trên Deployment đó)
#
# Blue-green cho api, realtime, fe, fe-mock (base/bluegreen): mỗi ứng dụng có <tên>-blue và <tên>-green; Service <tên>
# chọn màu đang chạy qua nhãn color. Deploy: đổi image và bật màu nghỉ, chờ pod sẵn sàng (readinessProbe), chuyển Service
# sang màu đó, chờ kết nối cũ đóng, tắt màu cũ (replicas 0). Pod mới không lên thì dừng, Service vẫn ở màu cũ.
# worker không nhận yêu cầu từ ngoài nên đổi image kiểu rolling update.
set -euo pipefail

cmd=${SSH_ORIGINAL_COMMAND:-}
if [[ $cmd != rollback && ! $cmd =~ ^sha-[0-9a-f]{7}$ ]]; then
  echo "Cần 'sha-<7 ký tự hex>' hoặc 'rollback', nhận: '$cmd'" >&2; exit 2
fi

# Mỗi phần tử: <ứng dụng>=<image không kèm tag>. Container cùng tên với ứng dụng.
case ${1:-} in
  fe) apps=(fe=ghcr.io/da-ec-system/commerio-fe fe-mock=ghcr.io/da-ec-system/commerio-fe-mock); rolling=() ;;
  backend) apps=(api=ghcr.io/da-ec-system/commerio-backend realtime=ghcr.io/da-ec-system/commerio-backend)
           rolling=(worker=ghcr.io/da-ec-system/commerio-backend) ;;
  *) echo "Không rõ thành phần: '${1:-}'" >&2; exit 2 ;;
esac

k() { kubectl --kubeconfig "$HOME/.kube/config" -n commerio "$@"; }
other() { [ "$1" = blue ] && echo green || echo blue; }
# Màu đang nhận yêu cầu. Service chưa có nhãn color (lần đầu sau khi apply) thì coi blue là màu đang chạy.
active() { local c; c=$(k get svc "$1" -o jsonpath='{.spec.selector.color}'); echo "${c:-blue}"; }

declare -A from to
for a in "${apps[@]}"; do
  app=${a%%=*}; from[$app]=$(active "$app"); to[$app]=$(other "${from[$app]}")
  if [ "$cmd" != rollback ]; then
    k set image "deploy/$app-${to[$app]}" "$app=${a#*=}:$cmd"
  fi
  k scale "deploy/$app-${to[$app]}" --replicas=1
  echo "$app: ${from[$app]} → ${to[$app]}"
done
if [ "$cmd" != rollback ]; then
  for a in "${rolling[@]}"; do k set image "deploy/${a%%=*}" "${a%%=*}=${a#*=}:$cmd"; done
fi

# Chờ mọi màu mới sẵn sàng rồi mới chuyển, để api và realtime đổi gần như cùng lúc.
for a in "${apps[@]}"; do app=${a%%=*}; k rollout status "deploy/$app-${to[$app]}" --timeout=180s; done
for a in "${apps[@]}"; do
  app=${a%%=*}
  k patch svc "$app" --type=merge -p "{\"spec\":{\"selector\":{\"color\":\"${to[$app]}\"}}}" >/dev/null
  echo "$app: Service đã chuyển sang ${to[$app]}"
done
for a in "${rolling[@]}"; do k rollout status "deploy/${a%%=*}" --timeout=180s; done

# Endpoints và Caddy cần vài giây để thôi gửi vào pod cũ (preStop của pod cũng chờ 5 s).
sleep 10
for a in "${apps[@]}"; do app=${a%%=*}; k scale "deploy/$app-${from[$app]}" --replicas=0; done
echo "Xong."
