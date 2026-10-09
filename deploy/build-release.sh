#!/usr/bin/env bash
# Build the server release files into a folder (the GitHub release workflow uses this):
#   VERSION, install.sh, ims-server.tar.gz, ims-image-<arch>.tar.gz, SHA256SUMS
#
#   deploy/build-release.sh <out-dir> [platforms]      (default platforms: linux/amd64,linux/arm64)
#
# Needs Docker with buildx. IMS_DOCKERFILE and IMS_BUILD_ARGS change the build (local tests).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?usage: deploy/build-release.sh <out-dir> [platforms]}"
PLATFORMS="${2:-linux/amd64,linux/arm64}"
VERSION="${IMS_RELEASE_VERSION:-$(node -p "require('./package.json').version")}"
mkdir -p "$OUT"
echo "$VERSION" >"$OUT/VERSION"
cp deploy/install.sh "$OUT/install.sh"
tar -czf "$OUT/ims-server.tar.gz" -C deploy/server --owner=0 --group=0 docker-compose.yml caddy ims systemd

IFS=',' read -ra platforms <<<"$PLATFORMS"
for platform in "${platforms[@]}"; do
  arch="${platform#linux/}"
  echo "== Image $VERSION for $platform"
  # shellcheck disable=SC2086
  docker buildx build --platform "$platform" -f "${IMS_DOCKERFILE:-Dockerfile}" ${IMS_BUILD_ARGS:-} \
    --provenance=false --sbom=false -t "warehouse-ims:$VERSION" --load .
  docker save "warehouse-ims:$VERSION" | gzip -6 >"$OUT/ims-image-$arch.tar.gz"
done

(cd "$OUT" && sha256sum VERSION install.sh ims-server.tar.gz ims-image-*.tar.gz >SHA256SUMS)
ls -lh "$OUT"
