# shellcheck shell=bash
# Inclus par backup.sh et restore.sh : traduit DATABASE_URL (ou DATABASE_URL_FILE) en variables libpq.
# Le mot de passe passe par PGPASSWORD (environnement, lisible du seul propriétaire du processus)
# et jamais en argument de pg_dump / pg_restore (visible de tous dans la liste des processus).
if [[ -z "${DATABASE_URL:-}" && -n "${DATABASE_URL_FILE:-}" ]]; then DATABASE_URL="$(<"$DATABASE_URL_FILE")"; fi
: "${DATABASE_URL:?DATABASE_URL (ou DATABASE_URL_FILE) manquante}"
_urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }
re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@(\[[^]]+\]|[^:/?]+)(:([0-9]+))?/([^?]+)'
[[ "$DATABASE_URL" =~ $re ]] || { echo "DATABASE_URL non reconnue (attendu postgresql://utilisateur:motdepasse@hôte:port/base)" >&2; exit 1; }
export PGUSER="$(_urldecode "${BASH_REMATCH[2]}")"
export PGPASSWORD="$(_urldecode "${BASH_REMATCH[4]}")"
export PGHOST="${BASH_REMATCH[5]}"; PGHOST="${PGHOST#[}"; export PGHOST="${PGHOST%]}"
export PGPORT="${BASH_REMATCH[7]:-5432}"
export PGDATABASE="$(_urldecode "${BASH_REMATCH[8]}")"
unset re DATABASE_URL
