#!/usr/bin/env bash
# Push the dance server to the Oracle VM and (re)start it.
#   server/deploy/deploy.sh setup   # first time: install Node, Caddy, firewall, systemd
#   server/deploy/deploy.sh         # code (the `release` branch) + dance library, restart
#   server/deploy/deploy.sh pull    # fetch sessions recorded on the VM
#   server/deploy/deploy.sh logs    # follow the server log
#   server/deploy/deploy.sh admin   # print the link that approves DJ bookings (secret!)
# Settings (env or server/deploy/.env): DANCE_HOST (ssh target, e.g.
# ubuntu@1.2.3.4), DANCE_DOMAIN (e.g. ws.wilkinscoffee.be).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
[ -f "$HERE/.env" ] && . "$HERE/.env"
: "${DANCE_HOST:?set DANCE_HOST, e.g. ubuntu@1.2.3.4 (or put it in server/deploy/.env)}"
DANCE_DOMAIN=${DANCE_DOMAIN:-ws.wilkinscoffee.be}
APP=/opt/dance

case "${1:-deploy}" in
  setup)
    scp "$HERE/setup-vm.sh" "$DANCE_HOST:/tmp/setup-vm.sh"
    ssh -t "$DANCE_HOST" "DANCE_DOMAIN=$DANCE_DOMAIN bash /tmp/setup-vm.sh"
    ;;
  deploy)
    # Code comes from the `release` branch, not the working tree, so the VM
    # runs the same version as the public site. DANCE_REF overrides it.
    REF=${DANCE_REF:-release}
    echo "== code ($REF @ $(git -C "$ROOT" rev-parse --short "$REF"))"
    TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
    # The server imports shared modules from src/, so both go up.
    git -C "$ROOT" archive "$REF" server src | tar -x -C "$TMP"
    rsync -az --delete --exclude node_modules --exclude lab/out \
      --exclude recordings --exclude recordings_web --exclude library --exclude data \
      "$TMP/server" "$TMP/src" "$DANCE_HOST:$APP/"
    echo "== dance library (add-only: sessions recorded on the VM are kept)"
    for d in recordings recordings_web library; do
      [ -d "$ROOT/server/$d" ] && rsync -az --exclude index.json "$ROOT/server/$d" "$DANCE_HOST:$APP/server/"
    done
    echo "== install + restart"
    ssh "$DANCE_HOST" "cd $APP/server && npm ci --omit=dev --no-audit --no-fund && sudo systemctl restart dance && sleep 2 && systemctl is-active dance"
    echo "== check: https://$DANCE_DOMAIN/"
    curl -fsS --max-time 10 "https://$DANCE_DOMAIN/" && echo
    ;;
  pull)
    rsync -az "$DANCE_HOST:$APP/server/library/sessions/" "$ROOT/server/library/sessions/"
    ;;
  admin)
    # The key is made by the server on first start (server/data/admin-key).
    KEY=$(ssh "$DANCE_HOST" "cat $APP/server/data/admin-key") || { echo "no admin key yet — deploy and start the server first" >&2; exit 1; }
    echo "Approve DJ bookings at (keep this link private):"
    echo "  https://${DANCE_SITE:-dance.wilkinscoffee.be}/schedule/#admin=$KEY"
    ;;
  logs)
    ssh -t "$DANCE_HOST" "journalctl -u dance -f -n 50"
    ;;
  *) echo "usage: $0 [setup|deploy|pull|logs|admin]" >&2; exit 2 ;;
esac
