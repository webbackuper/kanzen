#!/bin/sh
set -e
install -d -m 0750 -o kanzen -g kanzen /var/lib/kanzen /var/lib/kanzen/uploads
install -d -m 0750 -o kanzen -g kanzen /var/backups/kanzen
install -d -m 0750 -o root -g kanzen /etc/kanzen /etc/kanzen/secrets /etc/kanzen/ca /etc/kanzen/tls
chown root:kanzen /etc/kanzen/kanzen.env && chmod 0640 /etc/kanzen/kanzen.env
# Restaurer les contextes SELinux (RHEL/Rocky)
if command -v restorecon >/dev/null 2>&1; then restorecon -R /opt/kanzen /etc/kanzen /var/lib/kanzen /var/backups/kanzen 2>/dev/null || true; fi
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  # Mise à jour : redémarrer si le service tournait (les migrations passent en ExecStartPre)
  if systemctl is-active --quiet kanzen; then systemctl restart kanzen; fi
fi
cat <<MSG
KanZen installé dans /opt/kanzen.
  1. Éditer /etc/kanzen/kanzen.env (PUBLIC_URL, DATABASE_URL, AD…)
  2. sudo kanzenctl check
  3. sudo systemctl enable --now kanzen kanzen-backup.timer
  4. sudo kanzenctl create-admin secours
  Reverse proxy : /usr/share/kanzen/nginx/kanzen.conf
MSG
