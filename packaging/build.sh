#!/usr/bin/env bash
# Construit les livrables offline de KanZen, sur une machine de build CONNECTÉE à Internet :
#   dist/kanzen-<ver>-linux-x64.tar.gz   bundle autonome (runtime Node + application)
#   dist/kanzen-<ver>-<rel>.x86_64.rpm    RHEL / Rocky / Alma 9+
#   dist/kanzen_<ver>-<rel>_amd64.deb     Debian 12+ / Ubuntu 22.04+
#   dist/SHA256SUMS, dist/sbom.cdx.json
# Prérequis : bash, curl, tar, xz, sha256sum, Node.js + npm (≥ 22.18) pour le build.
# Usage : packaging/build.sh [version] [release]
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.22.3}"   # LTS embarqué (aligner sur la politique de mise à jour)
NFPM_VERSION="${NFPM_VERSION:-2.49.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_SRC="$ROOT/KANZEN"
VERSION="${1:-$(node -p "require('$APP_SRC/package.json').version.replace(/-.*/, '')")}"
RELEASE="${2:-1}"
OUT="$ROOT/dist"
WORK="$(mktemp -d)"
CACHE="${CACHE_DIR:-$HOME/.cache/kanzen-build}"
trap 'rm -rf "$WORK" "$HERE/.stage"' EXIT
mkdir -p "$OUT" "$CACHE"

log() { printf '\n==> %s\n' "$*"; }

fetch_verified() { # url sha256 dest
  local url=$1 sum=$2 dest=$3
  if [[ ! -f $dest ]] || ! echo "$sum  $dest" | sha256sum -c --status; then
    curl -fsSL --retry 3 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  echo "$sum  $dest" | sha256sum -c --quiet || { echo "Empreinte invalide : $url" >&2; exit 1; }
}

log "Runtime Node.js v$NODE_VERSION (linux-x64)"
NODE_TGZ="node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL --retry 3 -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
NODE_SUM="$(grep " $NODE_TGZ\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)"
[[ -n $NODE_SUM ]] || { echo "Empreinte Node introuvable" >&2; exit 1; }
fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ" "$NODE_SUM" "$CACHE/$NODE_TGZ"

log "nfpm v$NFPM_VERSION"
NFPM_TGZ="nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
curl -fsSL --retry 3 -o "$CACHE/nfpm-checksums-$NFPM_VERSION.txt" "https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/checksums.txt"
NFPM_SUM="$(grep " $NFPM_TGZ\$" "$CACHE/nfpm-checksums-$NFPM_VERSION.txt" | cut -d' ' -f1)"
fetch_verified "https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/$NFPM_TGZ" "$NFPM_SUM" "$CACHE/$NFPM_TGZ"
tar -C "$WORK" -xzf "$CACHE/$NFPM_TGZ" nfpm

log "Build de l'application"
BUILD="$WORK/build"
mkdir -p "$BUILD"
# Copie propre des sources suivies par git (aucun .env, node_modules ou fichier local)
git -C "$ROOT" archive --format=tar HEAD KANZEN | tar -C "$BUILD" -xf -
cd "$BUILD/KANZEN"
export CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
npm ci --no-audit --no-fund
npm audit --omit=dev --audit-level=high
npm run build
npm run sbom
npm prune --omit=dev --no-audit --no-fund
# Moteur de migration Prisma : nom neutre, référencé par PRISMA_SCHEMA_ENGINE_BINARY (RHEL et Debian, OpenSSL 3)
ENGINE="$(ls node_modules/@prisma/engines/schema-engine-* | grep -v '\.gz$' | head -1)"
mv "$ENGINE" node_modules/@prisma/engines/schema-engine
rm -f node_modules/@prisma/engines/schema-engine-*
# Binaires natifs inutiles en production (autres OS/architectures)
find node_modules/argon2/prebuilds -mindepth 1 -maxdepth 1 ! -name linux-x64 -exec rm -rf {} +

log "Assemblage du bundle"
STAGE="$HERE/.stage"   # chemin relatif attendu par nfpm.yaml
rm -rf "$STAGE"
APP_DST="$STAGE/opt/kanzen/app"
mkdir -p "$APP_DST" "$STAGE/opt/kanzen/node"
tar -C "$STAGE/opt/kanzen/node" --strip-components=1 -xJf "$CACHE/$NODE_TGZ"
rm -rf "$STAGE/opt/kanzen/node/include" "$STAGE/opt/kanzen/node/share" \
       "$STAGE/opt/kanzen/node/lib/node_modules/npm" "$STAGE/opt/kanzen/node/lib/node_modules/corepack" \
       "$STAGE/opt/kanzen/node/bin/npm" "$STAGE/opt/kanzen/node/bin/npx" "$STAGE/opt/kanzen/node/bin/corepack"
cp -a package.json prisma.config.js prisma src scripts node_modules README.md "$APP_DST/"
rm -rf "$APP_DST/src/client"
cp -a dist "$APP_DST/public"
echo "$VERSION-$RELEASE" > "$APP_DST/VERSION"
cp sbom.cdx.json "$OUT/sbom.cdx.json"

BUNDLE="kanzen-$VERSION-linux-x64"
mkdir -p "$WORK/$BUNDLE"
cp -a "$STAGE/opt" "$WORK/$BUNDLE/"
cp -a "$HERE/files" "$HERE/scripts" "$WORK/$BUNDLE/"
cp "$HERE/install-bundle.sh" "$WORK/$BUNDLE/install.sh"
tar -C "$WORK" -czf "$OUT/$BUNDLE.tar.gz" --owner=0 --group=0 "$BUNDLE"

log "Paquets RPM et DEB"
cd "$HERE"
export KANZEN_VERSION="$VERSION" KANZEN_RELEASE="$RELEASE"
"$WORK/nfpm" package --config nfpm.yaml --packager rpm --target "$OUT/"
"$WORK/nfpm" package --config nfpm.yaml --packager deb --target "$OUT/"

cd "$OUT"
rm -f SHA256SUMS
sha256sum ./*.tar.gz ./*.rpm ./*.deb sbom.cdx.json | sed 's# \./# #' > SHA256SUMS
log "Livrables dans $OUT"
cat SHA256SUMS
