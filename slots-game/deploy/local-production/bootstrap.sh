#!/bin/sh
# 安装项目依赖、生成一次性初始材料、构建已授权的 Web 产物并固定 Compose。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_node22

image_version="$(node "$local_production_directory/resolve-image-version.mjs" "$repository_root")"

mkdir -p "$state_root" "$state_root/backups" "$state_root/artifacts" "$state_root/rendered"
chmod 0700 "$state_root" "$state_root/backups" "$state_root/artifacts" "$state_root/rendered"
acquire_deployment_lock
new_state=false
if [ ! -d "$secrets_root" ]; then
  (cd "$repository_root/server" && go run ./cmd/local-production-bootstrap "$secrets_root")
elif [ ! -s "$secrets_root/deployment-metadata.json" ]; then
  printf '%s\n' '密钥目录已存在但不完整，拒绝覆盖。' >&2
  exit 1
fi
chmod 0700 "$secrets_root"
# 首次运行可能已在密钥创建后、compose.env 提交前中断。重跑必须继续首次选择器
# 路径，否则后面的 require_state 会把可恢复状态永久卡死。
if needs_initial_compose_state; then
  new_state=true
fi
# 旧版本机状态可能早于生产共享准入门禁。该幂等子命令只在四个 Valkey
# 专用文件全部缺失时使用既有本地 CA 补齐材料；绝不旋转任何已有密钥。
(cd "$repository_root/server" && \
  go run ./cmd/local-production-bootstrap add-shared-admission "$secrets_root")

(cd "$repository_root/web" && npm ci --ignore-scripts)
(cd "$repository_root/web" && \
  VITE_RGS_BASE_URL=https://rgs.localhost:8443 \
  VITE_RGS_BET_OPTIONS_MINOR=10,20,50,100,200,300,400,600,1000,2000,5000,10000 \
  VITE_RGS_DEFAULT_BET_MINOR=100 \
  VITE_RGS_HOST_ORIGIN=https://slots.localhost:8443 \
  VITE_OPERATOR_RETURN_URL=/operator/ \
  npm run build)
node "$repository_root/deploy/web/render-release-nginx.mjs" \
  --input "$repository_root/deploy/web/nginx.conf" \
  --output "$repository_root/web/release-nginx.conf" \
  --rgs-base-url https://rgs.localhost:8443 \
  --host-origin https://slots.localhost:8443

# 资源审批先写入受限候选文件并对当前 dist 做完整验证；在定义门禁和签名提交成功
# 以前，已提交审批逐字节保持不变。
pending_asset_approval="$state_root/artifacts/release-asset-approval.pending.json"
asset_prepare_status="$(node "$local_production_directory/rotate-asset-approval.mjs" \
  prepare \
  "$repository_root/web/dist/release-manifest.json" \
  "$secrets_root/release-asset-approval.json" \
  "$pending_asset_approval")"
# shellcheck disable=SC2086
set -- $asset_prepare_status
test "$#" -eq 5 && test "$1" = prepared || {
  printf '%s\n' '资源审批候选状态格式无效。' >&2
  exit 1
}
expected_asset_approval_hash="$3"
candidate_asset_approval_hash="$4"
(cd "$repository_root/web" && RELEASE_ASSET_APPROVAL_FILE="$pending_asset_approval" \
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
candidate_image_tag="candidate-${image_revision}-$(date -u '+%Y%m%dT%H%M%SZ')-$$"

LOCAL_PRODUCTION_IMAGE_CREATED="$image_created" \
LOCAL_PRODUCTION_IMAGE_REVISION="$image_revision" \
LOCAL_PRODUCTION_IMAGE_SOURCE="$image_source" \
LOCAL_PRODUCTION_IMAGE_VERSION="$image_version" \
LOCAL_PRODUCTION_IMAGE_TAG="$candidate_image_tag" \
LOCAL_PRODUCTION_ASSET_APPROVAL_HASH="$candidate_asset_approval_hash" \
  node "$local_production_directory/prepare-state.mjs" "$state_root" --validate-only

node "$local_production_directory/render-observability.mjs" "$state_root/rendered"
# 首次安装尚无 Compose 环境。此时定义已经是目标代际，可以先写入候选镜像身份；
# 既有部署则保持最后一次已提交的 compose.env，直到所有候选镜像和提交门禁通过。
if [ "$new_state" = true ]; then
  LOCAL_PRODUCTION_IMAGE_CREATED="$image_created" \
  LOCAL_PRODUCTION_IMAGE_REVISION="$image_revision" \
  LOCAL_PRODUCTION_IMAGE_SOURCE="$image_source" \
  LOCAL_PRODUCTION_IMAGE_VERSION="$image_version" \
  LOCAL_PRODUCTION_IMAGE_TAG="$candidate_image_tag" \
  LOCAL_PRODUCTION_ASSET_APPROVAL_HASH="$candidate_asset_approval_hash" \
    node "$local_production_directory/prepare-state.mjs" "$state_root"
fi
require_state
"$local_production_directory/verify-static-contract.sh"

# 候选镜像使用唯一 tag 构建，不覆盖 compose.env 当前选择的已提交镜像。即使后续
# 排空失败或定义拒绝轮换，up.sh 仍只会启动上一代兼容镜像。
(
  export LOCAL_PRODUCTION_IMAGE_CREATED="$image_created"
  export LOCAL_PRODUCTION_IMAGE_REVISION="$image_revision"
  export LOCAL_PRODUCTION_IMAGE_SOURCE="$image_source"
  export LOCAL_PRODUCTION_IMAGE_VERSION="$image_version"
  export LOCAL_PRODUCTION_IMAGE_TAG="$candidate_image_tag"
  compose config --quiet
  # shellcheck disable=SC2016
  compose config --format json | node -e '
const {readFileSync}=require("node:fs");
const document=JSON.parse(readFileSync(0,"utf8"));
const expected=`slots-nginx-proxy:${process.argv[1]}`;
for (const serviceName of ["ingress", "alert-proxy"]) {
  if (document.services?.[serviceName]?.image !== expected) {
    throw new Error(`${serviceName} 未绑定共用 Nginx 候选镜像`);
  }
}
' "$candidate_image_tag"
  # ingress 与 alert-proxy 绑定同一个 slots-nginx-proxy tag，只需构建一次。
  compose build --provenance=mode=max rgs-migrator rgs-server local-operator web ingress
)
for candidate_image in \
  "slots-rgs-migrator:$candidate_image_tag" \
  "slots-rgs-runtime:$candidate_image_tag" \
  "slots-local-operator:$candidate_image_tag" \
  "slots-web:$candidate_image_tag" \
  "slots-nginx-proxy:$candidate_image_tag"
do
  docker image inspect "$candidate_image" >/dev/null
done

# 候选构建全部成功后才进入受锁提交窗口。up/down/destroy 继承同一 lockf 边界，
# 无法在排空检查与定义提交之间重新启动旧 RGS。
rotation_status="$(cd "$repository_root/server" && \
  go run ./cmd/local-production-bootstrap definition-rotation-status "$secrets_root")"
# 输出字段均已由 Go 侧定义标识符和 SHA-256 校验。
# shellcheck disable=SC2086
set -- $rotation_status
test "$#" -eq 4 || { printf '%s\n' '定义轮换状态格式无效。' >&2; exit 1; }
rotation_required="$1"
target_game="$2"
target_version="$3"
target_hash="$4"
if [ "$rotation_required" = true ]; then
  "$local_production_directory/verify-definition-drain.sh" \
    "$target_game" "$target_version" "$target_hash"
elif [ "$rotation_required" != false ]; then
  printf '%s\n' '定义轮换状态不受支持。' >&2
  exit 1
fi

if [ "$rotation_required" = true ]; then
  (cd "$repository_root/server" && \
    go run ./cmd/local-production-bootstrap rotate-definition "$secrets_root" "$state_root/backups")
fi
node "$local_production_directory/rotate-asset-approval.mjs" \
  commit \
  "$repository_root/web/dist/release-manifest.json" \
  "$secrets_root/release-asset-approval.json" \
  "$state_root/backups" \
  "$pending_asset_approval" \
  "$expected_asset_approval_hash" \
  "$candidate_asset_approval_hash"
(cd "$repository_root/web" && RELEASE_ASSET_APPROVAL_FILE="$secrets_root/release-asset-approval.json" \
  node ./scripts/verify-release-asset-approval.mjs)

# compose.env 是唯一镜像选择器。它在定义和资源审批提交之后原子替换；若进程在
# 新定义或审批已提交、选择器尚未提交的混合窗口中断，up.sh 会因身份或摘要不匹配
# 而失败关闭，重跑即可收敛。
LOCAL_PRODUCTION_IMAGE_CREATED="$image_created" \
LOCAL_PRODUCTION_IMAGE_REVISION="$image_revision" \
LOCAL_PRODUCTION_IMAGE_SOURCE="$image_source" \
LOCAL_PRODUCTION_IMAGE_VERSION="$image_version" \
LOCAL_PRODUCTION_IMAGE_TAG="$candidate_image_tag" \
LOCAL_PRODUCTION_ASSET_APPROVAL_HASH="$candidate_asset_approval_hash" \
  node "$local_production_directory/prepare-state.mjs" "$state_root"
verify_state_definition_binding
compose config --quiet
printf '%s\n' "本机集成验收材料与候选镜像已提交：$candidate_image_tag"
