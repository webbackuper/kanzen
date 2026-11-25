#!/bin/sh
set -e
# Compte système dédié, sans shell ni répertoire personnel exploitable
if ! getent group kanzen >/dev/null; then groupadd --system kanzen; fi
if ! getent passwd kanzen >/dev/null; then
  useradd --system --gid kanzen --home-dir /var/lib/kanzen --no-create-home --shell /usr/sbin/nologin --comment "KanZen" kanzen
fi
