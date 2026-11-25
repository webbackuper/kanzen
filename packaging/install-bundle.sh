#!/usr/bin/env bash
# Installation de KanZen depuis le bundle tar.gz (alternative aux paquets RPM/DEB).
# Usage (root) : ./install.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "à lancer en root" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

sh "$HERE/scripts/preinstall.sh"
if [[ -d /opt/kanzen/app ]]; then
  echo "Mise à jour : sauvegarde de l'ancienne version dans /opt/kanzen.prev"
  rm -rf /opt/kanzen.prev && cp -a /opt/kanzen /opt/kanzen.prev
  rm -rf /opt/kanzen/app /opt/kanzen/node
fi
mkdir -p /opt/kanzen
cp -a "$HERE/opt/kanzen/." /opt/kanzen/
chown -R root:root /opt/kanzen
install -m 0755 "$HERE/files/kanzenctl" /usr/sbin/kanzenctl
install -m 0644 "$HERE/files/systemd/"kanzen*.service "$HERE/files/systemd/"kanzen*.timer /usr/lib/systemd/system/
install -d /usr/share/kanzen/nginx && install -m 0644 "$HERE/files/nginx/kanzen.conf" /usr/share/kanzen/nginx/
install -d -m 0750 /etc/kanzen
[[ -f /etc/kanzen/kanzen.env ]] || install -m 0640 "$HERE/files/kanzen.env" /etc/kanzen/kanzen.env
sh "$HERE/scripts/postinstall.sh"
