#!/usr/bin/env bash
# Dance With Me — LAN test stack for phones on the same wifi.
#
#   ./dance-lan.sh            (--no-browser to skip opening the dance floor)
#   ./dance-lan.sh --home     home studio, see dance-home.sh (--no-music, --no-obs)
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
HOME_MODE=0
START_OBS=1
OPEN_MUSIC=1
# Home studio: the music page opened in the browser (OBS streams its sound).
MUSIC_URL=${DANCE_HOME_MUSIC:-https://music.youtube.com/watch?list=LM}
for arg in "$@"; do
  case "$arg" in
    --no-browser) OPEN_BROWSER=0 ;;
    --home) HOME_MODE=1; OPEN_BROWSER=0 ;;
    --no-obs) START_OBS=0 ;;
    --no-music) OPEN_MUSIC=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$LOGDIR"
HOME_ROOM_NAME=${DANCE_HOME_ROOM:-home}
OBS_PROFILE="Dance home"
OBS_STARTED=0
OBS_INI=""   # where OBS keeps its current profile
OBS_PREV=""  # "Name|Dir" of the profile OBS was on before we started it

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
  # OBS, if this script started it (SIGTERM: it stops the stream and quits).
  if [ "$OBS_STARTED" = 1 ]; then
    pkill -TERM -x obs 2>/dev/null
    # Hand OBS back on the profile it was on (your public stream key), so
    # the next time you open it yourself it doesn't stream to this laptop.
    if [ -n "$OBS_PREV" ] && [ -f "$OBS_INI" ]; then
      for _ in $(seq 1 40); do pgrep -x obs >/dev/null || break; sleep 0.25; done
      sed -i "s|^Profile=.*|Profile=${OBS_PREV%%|*}|; s|^ProfileDir=.*|ProfileDir=${OBS_PREV##*|}|" "$OBS_INI"
    fi
  fi
  # shellcheck disable=SC2046
  kill $(cat "$LOGDIR/pids" 2>/dev/null) 2>/dev/null || true
  rm -f "$LOGDIR/pids"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Home studio: sessions are recorded into the library, and the room "home"
# takes an OBS stream with a key of its own (made once, kept in server/data).
if [ "$HOME_MODE" = 1 ]; then
  mkdir -p server/data
  [ -s server/data/home-key ] || (umask 077; tr -d '-' < /proc/sys/kernel/random/uuid > server/data/home-key)
  export HOME_ROOM="$HOME_ROOM_NAME" HOME_KEY="$(cat server/data/home-key)" RECORD_DIR="${RECORD_DIR:-library/sessions}" RECORD_BUTTON=1
fi
# This laptop's address on the network (the phone link). OBS music goes to
# the phones over the same one.
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')
[ -n "$IP" ] || IP=$(hostname -I | awk '{print $1}')
export WHIP_LOCAL_IP="$IP"
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

# --- home studio: OBS streams this laptop's sound into the room -------------
# A profile of its own ("Dance home": WHIP to this laptop's dance server,
# small throwaway video, Opus audio) next to your other profiles; scenes
# and sound sources are whatever OBS already has.
OBS_NOTE=""
start_obs() {
  local cfg run
  if command -v flatpak >/dev/null && flatpak info com.obsproject.Studio >/dev/null 2>&1; then
    cfg="$HOME/.var/app/com.obsproject.Studio/config/obs-studio"; run="flatpak run com.obsproject.Studio"
  elif command -v obs >/dev/null; then
    cfg="${XDG_CONFIG_HOME:-$HOME/.config}/obs-studio"; run="obs"
  else
    OBS_NOTE="OBS not found. Stream by hand: WHIP, server http://localhost:8901/whip, bearer token in server/data/home-key"; return
  fi
  local dir="$cfg/basic/profiles/Dance_home"
  mkdir -p "$dir"
  [ -f "$dir/basic.ini" ] || cat > "$dir/basic.ini" <<EOF
[General]
Name=$OBS_PROFILE

[Output]
Mode=Simple
Reconnect=true
RetryDelay=2
MaxRetries=25

[SimpleOutput]
VBitrate=300
ABitrate=160
StreamEncoder=x264
Preset=veryfast
StreamAudioEncoder=opus

[Video]
BaseCX=1280
BaseCY=720
OutputCX=640
OutputCY=360
FPSType=0
FPSCommon=30

[Audio]
SampleRate=48000
ChannelSetup=Stereo
EOF
  (umask 077; printf '{"type":"whip_custom","settings":{"server":"http://localhost:8901/whip","use_auth":false,"bwtest":false,"service":"WHIP","bearer_token":"%s"}}\n' "$HOME_KEY" > "$dir/service.json")
  if pgrep -x obs >/dev/null; then
    OBS_NOTE="OBS is already open: pick Profile → $OBS_PROFILE there and press Start Streaming."
    return
  fi
  OBS_INI="$cfg/user.ini"; [ -f "$OBS_INI" ] || OBS_INI="$cfg/global.ini"
  local pn pd
  pn=$(sed -n 's/^Profile=//p' "$OBS_INI" 2>/dev/null | head -1); pd=$(sed -n 's/^ProfileDir=//p' "$OBS_INI" 2>/dev/null | head -1)
  [ -n "$pn" ] && [ -n "$pd" ] && [ "$pn" != "$OBS_PROFILE" ] && OBS_PREV="$pn|$pd"
  $run --profile "$OBS_PROFILE" --startstreaming --disable-shutdown-check > "$LOGDIR/obs.log" 2>&1 &
  OBS_STARTED=1
  OBS_NOTE="OBS started, streaming this laptop's sound into the room (profile \"$OBS_PROFILE\")."
}
if [ "$HOME_MODE" = 1 ] && [ "$START_OBS" = 1 ]; then
  for _ in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":8901 " && break; sleep 0.25; done
  start_obs
fi

# --- URL + QR code ---------------------------------------------------------
URL="https://$IP:$PORT/"
PHONE_URL="$URL"
[ "$HOME_MODE" = 1 ] && PHONE_URL="$URL?room=$HOME_ROOM_NAME"

FLOOR="${URL}floor.html"
if [ "$OPEN_BROWSER" = 1 ] && command -v xdg-open >/dev/null; then
  (xdg-open "$FLOOR" >/dev/null 2>&1 &)
fi

MUSIC_NOTE="play it in a browser here."
if [ "$HOME_MODE" = 1 ] && [ "$OPEN_MUSIC" = 1 ] && command -v xdg-open >/dev/null; then
  (xdg-open "$MUSIC_URL" >/dev/null 2>&1 &)
  MUSIC_NOTE="opened $MUSIC_URL in your browser; press play there if it didn't start."
fi

clear
echo
if command -v qrencode >/dev/null; then
  qrencode -t ANSIUTF8 -m 2 "$PHONE_URL"
elif [ -x "$HOME/venv/bin/python" ] && "$HOME/venv/bin/python" -c 'import qrcode' 2>/dev/null; then
  "$HOME/venv/bin/python" -c 'import sys,qrcode; q=qrcode.QRCode(border=2); q.add_data(sys.argv[1]); q.make(); q.print_ascii(invert=True)' "$PHONE_URL"
else
  echo "(no QR generator found — install one with:  sudo apt install qrencode)"
fi
echo
echo "  Serving: branch $(git branch --show-current) @ $(git rev-parse --short HEAD) — $(git log -1 --format=%s | cut -c1-60)"
echo
if [ "$HOME_MODE" = 1 ]; then
  echo "  HOME STUDIO  ·  room \"$HOME_ROOM_NAME\"  ·  clips go to server/$RECORD_DIR"
  echo
  echo "  Phone:  $PHONE_URL"
  echo "  Save that link on the phone (Add to Home screen). It opens the camera in the"
  echo "  room; tap Capture Room. Press ● Record when ready (5 s countdown), ■ Stop to save the clip."
  echo
  echo "  Music:  $MUSIC_NOTE"
  echo "          ${OBS_NOTE:-OBS not started (--no-obs).}"
else
  echo "  Phones on this wifi:  $URL"
  echo "  Accept the certificate warning once per phone, then Dance in room."
fi
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
