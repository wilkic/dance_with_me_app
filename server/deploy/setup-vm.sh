#!/usr/bin/env bash
# One-time setup of a fresh Oracle Cloud Ubuntu VM for the dance server.
# Run ON the VM as the default `ubuntu` user (deploy.sh copies and runs it):
#   DANCE_DOMAIN=ws.wilkinscoffee.be bash setup-vm.sh
# Installs Node 22 + Caddy, opens 80/443 in the VM's own iptables (Oracle's
# image rejects everything but SSH), sets up the
# systemd unit. Safe to re-run.
set -euo pipefail
: "${DANCE_DOMAIN:?set DANCE_DOMAIN, e.g. ws.wilkinscoffee.be}"
APP=/opt/dance

echo "== packages"
sudo apt-get update -q
sudo apt-get install -yq curl rsync debian-keyring debian-archive-keyring apt-transport-https gnupg iptables-persistent

if ! command -v node >/dev/null || ! node --version | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -yq nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -q
  sudo apt-get install -yq caddy
fi

echo "== firewall (VM side; the VCN security list must allow 80/443 too)"
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
sudo netfilter-persistent save

echo "== app dir (the server runs as ubuntu: one-purpose VM, and deploys own the files)"
sudo mkdir -p "$APP"
sudo chown ubuntu:ubuntu "$APP"

echo "== systemd unit"
sudo tee /etc/systemd/system/dance.service >/dev/null <<UNIT
[Unit]
Description=Dance With Me server (rooms, guests, AI dancers)
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=$APP/server
ExecStart=/usr/bin/node index.js 8901
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable dance.service

echo "== caddy (automatic TLS for $DANCE_DOMAIN)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DANCE_DOMAIN {
	# No log directive on purpose: no access log, no IPs kept (see /privacy/).
	reverse_proxy /ws* 127.0.0.1:8901
	respond / "dance server" 200
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "== done. Next: deploy.sh pushes the code and starts the service."
