#!/usr/bin/env bash
# Mở Grafana và Prometheus của staging trên máy mình qua một đường hầm SSH (cả hai chỉ có ClusterIP, không ra internet).
#   bash deploy/k8s/overlays/vps/monitor.sh [ssh-host]      # mặc định commerio_vps (Host trong ~/.ssh/config)
# Grafana: http://localhost:3031 (admin, mật khẩu được chép vào clipboard). Prometheus: http://localhost:9091/alerts
# Ctrl+C để đóng; port-forward trên VPS tắt theo.
# Cổng 3031, 9091 để không đụng Grafana 3030, Prometheus 9090 của máy dev (deploy/compose.yaml).
set -euo pipefail

HOST=${1:-${VPS_SSH:-commerio_vps}}
GRAFANA=3031
PROM=9091

pw=$(ssh "$HOST" "grep '^GF_SECURITY_ADMIN_PASSWORD=' /opt/commerio/repo/deploy/k8s/overlays/vps/grafana/.env | cut -d= -f2-")
if command -v clip >/dev/null; then printf '%s' "$pw" | clip; where="clipboard"
elif command -v pbcopy >/dev/null; then printf '%s' "$pw" | pbcopy; where="clipboard"
elif command -v xclip >/dev/null; then printf '%s' "$pw" | xclip -selection clipboard; where="clipboard"
else where=""; fi
unset pw
if [ -n "$where" ]; then echo "Mật khẩu admin Grafana đã chép vào clipboard."
else echo "Không có clip/pbcopy/xclip: lấy mật khẩu bằng ssh $HOST \"grep GF_SECURITY_ADMIN_PASSWORD /opt/commerio/repo/deploy/k8s/overlays/vps/grafana/.env\""; fi

open_url() { (start "$1" || open "$1" || xdg-open "$1") >/dev/null 2>&1 & }
( sleep 4; open_url "http://localhost:$GRAFANA/dashboards"; ) &

echo "Grafana     http://localhost:$GRAFANA   (user admin)"
echo "Prometheus  http://localhost:$PROM/alerts"
echo "Ctrl+C để đóng."
# Trên VPS, cat chờ tới khi kết nối đóng (Ctrl+C, đóng cửa sổ, mất mạng: stdin hết hoặc SIGHUP), rồi trap tắt
# cả hai port-forward. Không dựa riêng vào SIGHUP: chạy không có terminal thì sshd không gửi tín hiệu đó.
ssh -t -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L "$GRAFANA:localhost:$GRAFANA" -L "$PROM:localhost:$PROM" "$HOST" \
  "trap 'kill 0' EXIT HUP INT TERM
   kubectl -n commerio port-forward svc/grafana $GRAFANA:3000 >/dev/null &
   kubectl -n commerio port-forward svc/prometheus $PROM:9090 >/dev/null &
   cat >/dev/null"
