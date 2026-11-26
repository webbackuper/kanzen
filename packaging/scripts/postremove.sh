#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
# Les données (/var/lib/kanzen, /var/backups/kanzen), la configuration et le compte kanzen sont conservés.
