#!/bin/sh
# 安装项目依赖、生成一次性初始材料、构建已授权的 Web 产物并固定 Compose。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_node22

mkdir -p "$state_root" "$state_root/backups" "$state_root/artifacts" "$state_root/rendered"
chmod 0700 "$state_root" "$state_root/backups" "$state_root/artifacts" "$state_root/rendered"
if [ ! -d "$secrets_root" ]; then
  (cd "$repository_root/server" && go run ./cmd/local-production-bootstrap "$secrets_root")
elif [ ! -s "$secrets_root/deployment-metadata.json" ]; then
  printf '%s\n' '密钥目录已存在但不完整，拒绝覆盖。' >&2
  exit 1
fi
chmod 0700 "$secrets_root"

(cd "$repository_root/web" && npm ci --ignore-scripts)
(cd "$repository_root/web" && \
  VITE_RGS_BASE_URL=https://rgs.localhost:8443 \
  VITE_RGS_BET_OPTIONS_MINOR=10,20,50,100,200,300,400,600,1000,2000,5000,10000 \
  VITE_RGS_DEFAULT_BET_MINOR=100 \
  VITE_RGS_HOST_ORIGIN=https://slots.localhost:8443 \
  npm run build)
node "$repository_root/deploy/web/render-release-nginx.mjs" \
  --input "$repository_root/deploy/web/nginx.conf" \
  --output "$repository_root/web/release-nginx.conf" \
  --rgs-base-url https://rgs.localhost:8443 \
  --host-origin https://slots.localhost:8443

if [ ! -s "$secrets_root/release-asset-approval.json" ]; then
  node "$local_production_directory/create-asset-approval.mjs" \
    "$repository_root/web/dist/release-manifest.json" "$secrets_root/release-asset-approval.json"
fi
(cd "$repository_root/web" && RELEASE_ASSET_APPROVAL_FILE="$secrets_root/release-asset-approval.json" \
  node ./scripts/verify-release-asset-approval.mjs)

image_revision="${LOCAL_PRODUCTION_IMAGE_REVISION:-}"
if [ -z "$image_revision" ]; then
  image_revision="$(git -C "$repository_root" rev-parse --verify HEAD 2>/dev/null || true)"
  test -n "$image_revision" || {
    printf '%s\n' '无法取得源码 revision；请设置 LOCAL_PRODUCTION_IMAGE_REVISION。' >&2
    exit 1
  }
  if [ -n "$(git -C "$repository_root" status --porcelain --untracked-files=normal -- .)" ]; then
    image_revision="${image_revision}-dirty"
  fi
fi
image_created="${LOCAL_PRODUCTION_IMAGE_CREATED:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
image_source="${LOCAL_PRODUCTION_IMAGE_SOURCE:-https://github.com/qqq723000-hash/slots-game}"
image_version="${LOCAL_PRODUCTION_IMAGE_VERSION:-local-production}"

LOCAL_PRODUCTION_IMAGE_CREATED="$image_created" \
LOCAL_PRODUCTION_IMAGE_REVISION="$image_revision" \
LOCAL_PRODUCTION_IMAGE_SOURCE="$image_source" \
LOCAL_PRODUCTION_IMAGE_VERSION="$image_version" \
  node "$local_production_directory/prepare-state.mjs" "$state_root"
node "$local_production_directory/render-observability.mjs" "$state_root/rendered"
require_state
"$local_production_directory/verify-static-contract.sh"
compose config --quiet
compose build --provenance=mode=max rgs-migrator rgs-server local-operator web
printf '%s\n' '本机生产材料与镜像已就绪。'
