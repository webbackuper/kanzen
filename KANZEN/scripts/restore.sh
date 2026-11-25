#!/usr/bin/env bash
# Restauration KanZen depuis une archive produite par backup.sh.
# Usage : restore.sh /var/backups/kanzen/kanzen-AAAAMMJJTHHMMSSZ.tar[.gpg]
# ATTENTION : remplace le contenu de la base et des pièces jointes. Arrêter le service avant.
set -euo pipefail
umask 077
ARCHIVE="${1:?Usage : restore.sh <archive>}"
: "${DATABASE_URL:?DATABASE_URL manquante}"
UPLOAD_DIR="${UPLOAD_DIR:-/var/lib/kanzen/uploads}"
PGURL="${DATABASE_URL%%\?*}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -f "$ARCHIVE.sha256" ]] && sha256sum -c "$ARCHIVE.sha256"
if [[ "$ARCHIVE" == *.gpg ]]; then
  gpg --batch --decrypt --output "$WORK/backup.tar" "$ARCHIVE"
else
  cp "$ARCHIVE" "$WORK/backup.tar"
fi
tar -C "$WORK" -xf "$WORK/backup.tar"
( cd "$WORK" && sha256sum -c SHA256SUMS )

read -r -p "Remplacer la base et les pièces jointes actuelles ? Taper RESTAURER : " ok
[[ "$ok" == "RESTAURER" ]] || { echo "Abandon."; exit 1; }

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="$PGURL" "$WORK/kanzen.dump"
rm -rf "${UPLOAD_DIR:?}.old" && [[ -d "$UPLOAD_DIR" ]] && mv "$UPLOAD_DIR" "$UPLOAD_DIR.old"
tar -C "$(dirname "$UPLOAD_DIR")" -xf "$WORK/uploads.tar"
echo "Restauration OK. Ancien dossier de pièces jointes conservé dans $UPLOAD_DIR.old"
