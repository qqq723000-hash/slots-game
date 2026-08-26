#!/bin/sh
# 验证本机部署锁在进程退出后恢复，以及混合定义/Compose 代际在启动前失败关闭。
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
mode="${1:-main}"

if [ "$mode" = holder ]; then
  export LOCAL_PRODUCTION_STATE_ROOT="$2"
  # shellcheck source=deploy/local-production/common.sh
  . "$script_dir/common.sh"
  acquire_deployment_lock
  printf '%s\n' ready >"$3"
  while [ ! -e "$4" ]; do sleep 0.05; done
  exit 0
fi

if [ "$mode" = contender ]; then
  export LOCAL_PRODUCTION_STATE_ROOT="$2"
  # shellcheck source=deploy/local-production/common.sh
  . "$script_dir/common.sh"
  acquire_deployment_lock
  exit 0
fi

if [ "$mode" = binding ]; then
  export LOCAL_PRODUCTION_STATE_ROOT="$2"
  # shellcheck source=deploy/local-production/common.sh
  . "$script_dir/common.sh"
  verify_state_definition_binding
  exit 0
fi

if [ "$mode" = initial-state ]; then
  export LOCAL_PRODUCTION_STATE_ROOT="$2"
  # shellcheck source=deploy/local-production/common.sh
  . "$script_dir/common.sh"
  needs_initial_compose_state
  exit 0
fi

test "$mode" = main || { printf '%s\n' 'unsupported deployment transaction test mode' >&2; exit 2; }
temporary_root="$(mktemp -d -t slots-local-deployment-transaction.XXXXXX)"
holder_pid=''
cleanup() {
  if [ -n "$holder_pid" ]; then
    kill "$holder_pid" >/dev/null 2>&1 || true
    wait "$holder_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

state_root="$temporary_root/state"
secrets_root="$state_root/secrets"
mkdir -p "$secrets_root"
chmod 0700 "$state_root" "$secrets_root"
# 首次 bootstrap 在密钥创建后中断时尚无选择器；重跑必须识别并恢复这一状态。
sh "$0" initial-state "$state_root"
: >"$secrets_root/compose.env"
sh "$0" initial-state "$state_root"
printf '%s\n' 'committed-selector' >"$secrets_root/compose.env"
if sh "$0" initial-state "$state_root"; then
  printf '%s\n' 'committed Compose selector unexpectedly entered initial-state recovery' >&2
  exit 1
fi
rm -f "$secrets_root/compose.env"
ready_file="$temporary_root/holder-ready"
release_file="$temporary_root/holder-release"
sh "$0" holder "$state_root" "$ready_file" "$release_file" &
holder_pid="$!"
attempt=0
while [ ! -s "$ready_file" ] && [ "$attempt" -lt 100 ]; do
  sleep 0.05
  attempt=$((attempt + 1))
done
test -s "$ready_file" || { printf '%s\n' 'deployment lock holder did not start' >&2; exit 1; }
if sh "$0" contender "$state_root" 2>"$temporary_root/contender-error"; then
  printf '%s\n' 'concurrent deployment command unexpectedly acquired the lock' >&2
  exit 1
fi
grep -F '另一个 bootstrap/up/down/destroy 正在操作本机部署' \
  "$temporary_root/contender-error" >/dev/null
: >"$release_file"
wait "$holder_pid"
holder_pid=''
sh "$0" contender "$state_root"
if lock_mode="$(stat -f '%Lp' "$state_root/deployment.lock" 2>/dev/null)"; then
  :
else
  lock_mode="$(stat -c '%a' -- "$state_root/deployment.lock")"
fi
test "$lock_mode" = 600

approval_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
printf '%s\n' \
  '{' \
  '  "schema": "rgs-definition-approval-v2",' \
  '  "approval": {' \
  '    "gameId": "iron-colossus",' \
  '    "version": "definition-current",' \
  "    \"sha256\": \"$approval_hash\"" \
  '  }' \
  '}' >"$secrets_root/definition-approval.json"
chmod 0600 "$secrets_root/definition-approval.json"
printf '%s\n' '{"assets":["committed"]}' >"$secrets_root/release-asset-approval.json"
chmod 0600 "$secrets_root/release-asset-approval.json"
asset_approval_hash="$(shasum -a 256 "$secrets_root/release-asset-approval.json" | awk '{print $1}')"
write_compose_state() {
  configured_hash="$1"
  configured_image_tag="${2:-candidate-test}"
  printf '%s\n' \
    'LOCAL_PRODUCTION_GAME_ID=iron-colossus' \
    'LOCAL_PRODUCTION_DEFINITION_VERSION=definition-current' \
    "LOCAL_PRODUCTION_DEFINITION_HASH=$configured_hash" \
    "LOCAL_PRODUCTION_IMAGE_TAG=$configured_image_tag" \
    "LOCAL_PRODUCTION_ASSET_APPROVAL_HASH=$asset_approval_hash" \
    >"$secrets_root/compose.env"
  chmod 0600 "$secrets_root/compose.env"
}
write_compose_state "$approval_hash"
sh "$0" binding "$state_root"
grep -v '^LOCAL_PRODUCTION_IMAGE_TAG=' "$secrets_root/compose.env" \
  >"$secrets_root/compose.env.without-image-tag"
mv "$secrets_root/compose.env.without-image-tag" "$secrets_root/compose.env"
chmod 0600 "$secrets_root/compose.env"
if sh "$0" binding "$state_root" 2>"$temporary_root/missing-image-tag-error"; then
  printf '%s\n' 'Compose state without a candidate image tag unexpectedly passed' >&2
  exit 1
fi
grep -F 'compose state image tag is invalid' \
  "$temporary_root/missing-image-tag-error" >/dev/null
write_compose_state "$approval_hash" 'candidate/invalid'
if sh "$0" binding "$state_root" 2>"$temporary_root/invalid-image-tag-error"; then
  printf '%s\n' 'Compose state with an invalid candidate image tag unexpectedly passed' >&2
  exit 1
fi
grep -F 'compose state image tag is invalid' \
  "$temporary_root/invalid-image-tag-error" >/dev/null
write_compose_state "$approval_hash"
sh "$0" binding "$state_root"
printf '%s\n' '{"assets":["uncommitted"]}' >"$secrets_root/release-asset-approval.json"
chmod 0600 "$secrets_root/release-asset-approval.json"
if sh "$0" binding "$state_root" 2>"$temporary_root/asset-binding-error"; then
  printf '%s\n' 'mixed asset approval and Compose generations unexpectedly passed' >&2
  exit 1
fi
grep -F 'compose state does not match the committed release asset approval' \
  "$temporary_root/asset-binding-error" >/dev/null
printf '%s\n' '{"assets":["committed"]}' >"$secrets_root/release-asset-approval.json"
chmod 0600 "$secrets_root/release-asset-approval.json"
sh "$0" binding "$state_root"
write_compose_state 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
if sh "$0" binding "$state_root" 2>"$temporary_root/binding-error"; then
  printf '%s\n' 'mixed definition and Compose generations unexpectedly passed' >&2
  exit 1
fi
grep -F 'compose state does not match the committed definition' \
  "$temporary_root/binding-error" >/dev/null
write_compose_state "$approval_hash"
sh "$0" binding "$state_root"
printf '%s\n' 'local production deployment transaction contract: passed'
