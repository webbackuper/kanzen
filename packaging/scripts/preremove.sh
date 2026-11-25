#!/bin/sh
set -e
# Suppression définitive uniquement (pas lors d'une mise à jour) :
#   deb : $1 = remove | purge ; rpm : $1 = 0
case "$1" in
  remove|purge|0)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now kanzen.service kanzen-backup.timer >/dev/null 2>&1 || true
    fi ;;
esac
