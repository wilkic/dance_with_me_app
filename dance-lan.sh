#!/usr/bin/env bash
# Dance With Me — LAN test stack for phones on the same wifi.
#
#   ./dance-lan.sh            (--no-browser to skip opening the dance floor)
#
# Starts the dance server (rooms, tempo) and the Vite dev server (HTTPS,
# proxies /ws to the dance server), prints the phone URL as a QR code and
# opens the big-screen dance floor (floor.html: every dancer as a stick
# figure, grouped by room, with a music selector) in the default browser.
# Each phone must accept the self-signed certificate once. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")"

PORT=5173
LOGDIR=/tmp/dance-lan
OPEN_BROWSER=1
[ "${1:-}" = "--no-browser" ] && OPEN_BROWSER=0
mkdir -p "$LOGDIR"

# --- clean up a previous run of this script -------------------------------
if [ -f "$LOGDIR/pids" ]; then
  # shellcheck disable=SC2046
  kill $(cat "$LOGDIR/pids") 2>/dev/null || true
  rm -f "$LOGDIR/pids"
  sleep 1
fi
for p in 8901 $PORT; do
  if ss -ltn 2>/dev/null | grep -q ":$p "; then
    echo "port $p is already in use — stop whatever is on it, e.g.:  fuser -k $p/tcp" >&2
    exit 1
  fi
done

# --- dependencies ----------------------------------------------------------
[ -d node_modules ] || npm install
[ -d server/node_modules ] || (cd server && npm install)

# --- start both servers ----------------------------------------------------
cleanup() {
  echo; echo "stopping…"
  # shellcheck disable=SC2046
  kill $(cat "$LOGDIR/pids" 2>/dev/null) 2>/dev/null || true
  rm -f "$LOGDIR/pids"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

(cd server && exec node index.js) > "$LOGDIR/server.log" 2>&1 &
SERVER_PID=$!
node_modules/.bin/vite --host --strictPort --port "$PORT" > "$LOGDIR/vite.log" 2>&1 &
VITE_PID=$!
echo "$SERVER_PID $VITE_PID" > "$LOGDIR/pids"

for _ in $(seq 1 30); do
  curl -sk "https://localhost:$PORT/" >/dev/null 2>&1 && break
  if ! kill -0 "$VITE_PID" 2>/dev/null; then cat "$LOGDIR/vite.log"; exit 1; fi
  sleep 0.5
done

# --- URL + QR code ---------------------------------------------------------
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
[ -n "$IP" ] || IP=$(hostname -I | awk '{print $1}')
URL="https://$IP:$PORT/"

FLOOR="${URL}floor.html"
if [ "$OPEN_BROWSER" = 1 ] && command -v xdg-open >/dev/null; then
  (xdg-open "$FLOOR" >/dev/null 2>&1 &)
fi

clear
echo
if command -v qrencode >/dev/null; then
  qrencode -t ANSIUTF8 -m 2 "$URL"
elif [ -x "$HOME/venv/bin/python" ] && "$HOME/venv/bin/python" -c 'import qrcode' 2>/dev/null; then
  "$HOME/venv/bin/python" -c 'import sys,qrcode; q=qrcode.QRCode(border=2); q.add_data(sys.argv[1]); q.make(); q.print_ascii(invert=True)' "$URL"
else
  echo "(no QR generator found — install one with:  sudo apt install qrencode)"
fi
echo
echo "  Serving: branch $(git branch --show-current) @ $(git rev-parse --short HEAD) — $(git log -1 --format=%s | cut -c1-60)"
echo
echo "  Phones on this wifi:  $URL"
echo "  Accept the certificate warning once per phone, then Dance in room."
echo
echo "  Dance floor (this screen):  $FLOOR"
echo
echo "  DJ booking:  ${URL}schedule/"
# The server makes its admin key on first start (server/data/admin-key).
for _ in $(seq 1 20); do [ -s server/data/admin-key ] && break; sleep 0.25; done
[ -s server/data/admin-key ] && echo "  Approve bookings (local admin link):  ${URL}schedule/#admin=$(cat server/data/admin-key)"
echo
echo "  logs: $LOGDIR/server.log  $LOGDIR/vite.log      Ctrl+C stops everything"
echo "------------------------------------------------------------------------"
tail -f "$LOGDIR/server.log" &
TAIL_PID=$!
echo "$SERVER_PID $VITE_PID $TAIL_PID" > "$LOGDIR/pids"
wait "$SERVER_PID" "$VITE_PID"
