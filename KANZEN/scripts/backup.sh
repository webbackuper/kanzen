#!/usr/bin/env bash
# Sauvegarde KanZen : base PostgreSQL (pg_dump format custom) + pièces jointes.
# Variables : DATABASE_URL, UPLOAD_DIR, BACKUP_DIR (défaut /var/backups/kanzen),
#             BACKUP_RETENTION_DAYS (défaut 14), BACKUP_GPG_RECIPIENT (optionnel : chiffrement asymétrique),
#             BACKUP_GNUPGHOME (trousseau contenant la clé publique, défaut /etc/kanzen/gnupg).
set -euo pipefail
umask 077

# shellcheck source=pgenv.sh
source "$(dirname "$(readlink -f "$0")")/pgenv.sh"
UPLOAD_DIR="${UPLOAD_DIR:-/var/lib/kanzen/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/kanzen}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$BACKUP_DIR"

pg_dump --format=custom --no-owner --no-privileges --file="$WORK/kanzen.dump"
tar -C "$(dirname "$UPLOAD_DIR")" -cf "$WORK/uploads.tar" "$(basename "$UPLOAD_DIR")"
( cd "$WORK" && sha256sum kanzen.dump uploads.tar > SHA256SUMS )

OUT="$BACKUP_DIR/kanzen-$STAMP.tar"
tar -C "$WORK" -cf "$OUT" kanzen.dump uploads.tar SHA256SUMS
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  # Trousseau en lecture seule (clé PUBLIQUE uniquement, déposée par root) : aucun verrou ni trustdb à écrire
  gpg --homedir "${BACKUP_GNUPGHOME:-/etc/kanzen/gnupg}" --batch --yes --lock-never --no-auto-check-trustdb --trust-model always \
    --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$OUT.gpg" "$OUT"
  rm -f "$OUT"
  OUT="$OUT.gpg"
fi
sha256sum "$OUT" > "$OUT.sha256"

find "$BACKUP_DIR" -maxdepth 1 -name 'kanzen-*.tar*' -mtime "+$RETENTION" -delete
echo "Sauvegarde OK : $OUT ($(du -h "$OUT" | cut -f1))"
