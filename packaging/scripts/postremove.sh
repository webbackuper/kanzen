#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
# Les données (/var/lib/kanzen, /var/backups/kanzen), la configuration et le compte kanzen sont conservés.
# Désinstallation complète (pas une mise à jour) : retrait de la règle SELinux ajoutée à l'installation
case "${1:-}" in
  0|remove|purge)
    if command -v semanage >/dev/null 2>&1; then semanage fcontext -d '/opt/kanzen/app/public(/.*)?' 2>/dev/null || true; fi ;;
esac
