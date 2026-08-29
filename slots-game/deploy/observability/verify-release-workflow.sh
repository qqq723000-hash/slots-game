#!/bin/sh

# 受保护发布工作流只调用此固定入口。实际配置语义仍由 verify-static-contract.sh 检查；
# 本脚本负责受控渲染、固定镜像预加载、短命 CA 夹具与私密临时目录清理。
# English: Protected publishing workflows only call this fixed entry. Actual configuration semantics are still
# checked by verify-static-contract.sh; This script is responsible for controlled rendering, fixed image
# preloading, short-lived CA fixtures and private temporary directory cleanup.
set -eu
umask 077

fail() {
  printf '%s\n' "observability release workflow: $*" >&2
  exit 1
}

test "$#" -eq 0 || fail 'this workflow entrypoint does not accept arguments'
runner_temp=${RUNNER_TEMP:-}
run_id=${GITHUB_RUN_ID:-}
run_attempt=${GITHUB_RUN_ATTEMPT:-}
case "$runner_temp" in
  /*) ;;
  *) fail 'RUNNER_TEMP must be an absolute path' ;;
esac
case "$runner_temp" in
  *[!A-Za-z0-9_./-]*|*//*|*/../*|*/./*) fail 'RUNNER_TEMP must be a canonical safe path' ;;
esac
case "$run_id:$run_attempt" in
  *[!0-9:]*|:*|*:|*:*:*) fail 'GitHub run identity must contain two numeric components' ;;
esac
test -d "$runner_temp" || fail 'RUNNER_TEMP does not exist'

observability_rendered_dir="$runner_temp/observability-release-$run_id-$run_attempt"
cleanup_observability_bundle() {
  expected="$runner_temp/observability-release-$run_id-$run_attempt"
  if [ "$observability_rendered_dir" = "$expected" ] && [ -n "$runner_temp" ]; then
    rm -rf -- "$observability_rendered_dir"
  else
    printf '%s\n' "refusing to remove unexpected observability path: $observability_rendered_dir" >&2
    return 1
  fi
}
trap cleanup_observability_bundle EXIT
trap 'exit 130' HUP INT TERM

test ! -e "$observability_rendered_dir" || fail 'rendered observability path already exists'
node deploy/local-production/render-observability.mjs "$observability_rendered_dir"

docker pull "$PROMETHEUS_IMAGE"
docker pull "$VECTOR_IMAGE"
docker pull "$GRAFANA_IMAGE"
# 发布入口已完成 digest 固定镜像预载；行为门禁禁止自行 pull 或访问宿主端口。
# English: The publishing portal has completed digest fixed image preloading; behavioral gate prohibits
# self-pull or access to the host port.
make test-vector-bounded-flush
docker run --rm --pull never --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777 \
  --mount "type=bind,src=$observability_rendered_dir,dst=/output" \
  --entrypoint /bin/sh "$VECTOR_IMAGE" -ceu \
    'openssl req -new -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
      -subj /CN=alertmanager.release.invalid -keyout /tmp/alertmanager-ca.key \
      -out /output/alertmanager-root-ca.pem >/dev/null 2>&1'
chmod 0444 "$observability_rendered_dir/alertmanager-root-ca.pem"

ALERTMANAGER_ROOT_CA_FILE="$observability_rendered_dir/alertmanager-root-ca.pem" \
  OBSERVABILITY_RENDERED_DIR="$observability_rendered_dir" \
  make verify-observability-release
