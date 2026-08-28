#!/bin/sh
# 安装项目依赖、生成一次性初始材料、构建已授权的 Web 产物并固定 Compose。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
if [ "${NODE_OPTIONS+x}" = x ]; then
  printf '%s\n' '本机生产候选不接受 NODE_OPTIONS；请从启动环境中移除。' >&2
  exit 1
fi
require_docker
require_node22

image_revision="$(node "$local_production_directory/resolve-source-identity.mjs" "$repository_root")"
image_version="$(node "$local_production_directory/resolve-image-version.mjs" "$repository_root")"

verify_source_identity() {
  verified_revision="$(node "$local_production_directory/resolve-source-identity.mjs" "$repository_root")"
  test "$verified_revision" = "$image_revision" || {
    printf '%s\n' '源码 HEAD 在本机候选事务中发生变化。' >&2
    exit 1
  }
}

# 版本合同读取期间也不能切换 HEAD；修改任何仓库外状态前再次关闭竞态窗口。
verify_source_identity

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

node "$local_production_directory/run-web-build.mjs" \
  "$repository_root" \
  "$node_root" \
  "$image_version" \
  "$image_revision"
node "$repository_root/deploy/web/render-release-nginx.mjs" \
  --input "$repository_root/deploy/web/nginx.conf" \
  --output "$repository_root/web/release-nginx.conf" \
  --rgs-base-url https://rgs.localhost:8443 \
  --host-origin https://slots.localhost:8443
verify_source_identity

release_static_root="$repository_root/web/dist"
release_manifest_path="$release_static_root/release-manifest.json"
asset_release_id="$(node "$local_production_directory/verify-release-identity.mjs" \
  "$release_static_root" \
  "$image_version" \
  "$image_revision")"

# 资源审批先写入受限候选文件并对当前 dist 做完整验证；在定义门禁和签名提交成功
# 以前，已提交审批逐字节保持不变。
pending_asset_approval="$state_root/artifacts/release-asset-approval.pending.json"
asset_prepare_status="$(node "$local_production_directory/rotate-asset-approval.mjs" \
  prepare \
  "$release_manifest_path" \
  "$secrets_root/release-asset-approval.json" \
  "$pending_asset_approval")"
# shellcheck disable=SC2086
set -- $asset_prepare_status
test "$#" -eq 6 && test "$1" = prepared || {
  printf '%s\n' '资源审批候选状态格式无效。' >&2
  exit 1
}
expected_asset_approval_hash="$3"
candidate_asset_approval_hash="$4"
prepared_asset_release_id="$6"
node -e '
const [action, previous, candidate, count, releaseId]=process.argv.slice(1);
if (!["created", "unchanged", "rotated-expired", "rotated-manifest"].includes(action)
    || !/^(?:-|[0-9a-f]{64})$/u.test(previous)
    || !/^[0-9a-f]{64}$/u.test(candidate)
    || !/^[1-9][0-9]*$/u.test(count)
    || !/^sha256:[0-9a-f]{64}$/u.test(releaseId)) process.exit(1);
' "$2" "$expected_asset_approval_hash" "$candidate_asset_approval_hash" "$5" \
  "$prepared_asset_release_id" || {
  printf '%s\n' '资源审批候选字段不符合 canonical 格式。' >&2
  exit 1
}
test "$prepared_asset_release_id" = "$asset_release_id" || {
  printf '%s\n' '资源审批候选未绑定当前发布清单身份。' >&2
  exit 1
}
verify_host_release_payload() {
  verified_release_id="$(node "$local_production_directory/verify-release-identity.mjs" \
    "$release_static_root" \
    "$image_version" \
    "$image_revision" \
    "$prepared_asset_release_id")"
  test "$verified_release_id" = "$prepared_asset_release_id" || {
    printf '%s\n' '宿主 Web payload 未绑定已准备的发布身份。' >&2
    exit 1
  }
}
verify_host_release_payload
(cd "$repository_root/web" && RELEASE_ASSET_APPROVAL_FILE="$pending_asset_approval" \
  node ./scripts/verify-release-asset-approval.mjs)

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
verify_source_identity
verify_host_release_payload
candidate_web_image_id="$(docker image inspect --format '{{.Id}}' "slots-web:$candidate_image_tag")"
node -e '
const value=process.argv[1];
if (value.length !== 71 || !/^sha256:[0-9a-f]{64}$/u.test(value)) process.exit(1);
' "$candidate_web_image_id" || {
  printf '%s\n' '候选 Web 镜像没有 canonical 本地 image ID。' >&2
  exit 1
}
candidate_web_extract_root="$(mktemp -d -t slots-local-web-candidate.XXXXXX)"
candidate_web_static_root="$candidate_web_extract_root/static"
mkdir -m 0700 "$candidate_web_static_root"
candidate_web_container_id=''
cleanup_candidate_web_extract() {
  if [ -n "$candidate_web_container_id" ]; then
    docker rm --force "$candidate_web_container_id" >/dev/null 2>&1 || true
    candidate_web_container_id=''
  fi
  if [ -n "$candidate_web_extract_root" ]; then
    case "$candidate_web_extract_root" in
      */slots-local-web-candidate.*) rm -rf -- "$candidate_web_extract_root" ;;
      *) printf '%s\n' '拒绝清理无法验证的候选 Web 临时目录。' >&2; return 1 ;;
    esac
    candidate_web_extract_root=''
  fi
}
handle_candidate_web_signal() {
  signal_status="$1"
  trap - EXIT HUP INT TERM
  cleanup_candidate_web_extract
  exit "$signal_status"
}
trap cleanup_candidate_web_extract EXIT
trap 'handle_candidate_web_signal 129' HUP
trap 'handle_candidate_web_signal 130' INT
trap 'handle_candidate_web_signal 143' TERM
candidate_web_container_id="$(docker create "$candidate_web_image_id")"
docker cp "$candidate_web_container_id:/usr/share/nginx/html/." "$candidate_web_static_root"
docker cp "$candidate_web_container_id:/etc/nginx/conf.d/default.conf" \
  "$candidate_web_extract_root/image-release-nginx.conf"
node "$repository_root/deploy/web/render-release-nginx.mjs" \
  --input "$repository_root/deploy/web/nginx.conf" \
  --output "$candidate_web_extract_root/expected-release-nginx.conf" \
  --rgs-base-url https://rgs.localhost:8443 \
  --host-origin https://slots.localhost:8443
cmp "$candidate_web_extract_root/expected-release-nginx.conf" \
  "$candidate_web_extract_root/image-release-nginx.conf"
candidate_web_release_id="$(node "$local_production_directory/verify-release-identity.mjs" \
  "$candidate_web_static_root" \
  "$image_version" \
  "$image_revision" \
  "$prepared_asset_release_id")"
test "$candidate_web_release_id" = "$prepared_asset_release_id" || {
  printf '%s\n' '候选 Web 镜像未绑定已准备的发布清单身份。' >&2
  exit 1
}
cleanup_candidate_web_extract
trap - EXIT HUP INT TERM

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

# 在第一个不可逆定义/审批提交之前再次验证源码和宿主清单；实际审批 commit 仍会
# 重新读取 releaseId，从而拒绝准备后同资产但不同 version/revision 的身份替换。
verify_source_identity
verify_host_release_payload
if [ "$rotation_required" = true ]; then
  (cd "$repository_root/server" && \
    go run ./cmd/local-production-bootstrap rotate-definition "$secrets_root" "$state_root/backups")
fi
node "$local_production_directory/rotate-asset-approval.mjs" \
  commit \
  "$release_manifest_path" \
  "$secrets_root/release-asset-approval.json" \
  "$state_root/backups" \
  "$pending_asset_approval" \
  "$expected_asset_approval_hash" \
  "$candidate_asset_approval_hash" \
  "$prepared_asset_release_id"
(cd "$repository_root/web" && RELEASE_ASSET_APPROVAL_FILE="$secrets_root/release-asset-approval.json" \
  node ./scripts/verify-release-asset-approval.mjs)

# compose.env 是唯一镜像选择器。它在定义和资源审批提交之后原子替换；若进程在
# 新定义或审批已提交、选择器尚未提交的混合窗口中断，up.sh 会因身份或摘要不匹配
# 而失败关闭，重跑即可收敛。
verify_source_identity
verify_host_release_payload
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
