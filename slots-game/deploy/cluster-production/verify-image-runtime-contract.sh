#!/bin/sh
# 真实构建并执行集群发布镜像，防止静态模板与最终镜像入口悄然分叉。
# English: Really build and execute the cluster release image to prevent the static template and the final image
# entry from quietly bifurcating.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
runtime_image=${CLUSTER_RUNTIME_IMAGE:-slots-rgs-cluster-runtime:contract}
migrator_image=${CLUSTER_MIGRATOR_IMAGE:-slots-rgs-cluster-migrator:contract}
temporary_root=${TMPDIR:-/tmp}
fixture_directory=$(mktemp -d "${temporary_root%/}/slots-cluster-image-contract.XXXXXX")
probe_server_pid=''
runtime_container=''
migrator_container=''
materializer_container=''
materializer_volume=''

fail() {
  printf '%s\n' "cluster image runtime contract: $*" >&2
  exit 1
}

cleanup() {
  if test -n "$materializer_container"; then
    docker rm -f "$materializer_container" >/dev/null 2>&1 || true
  fi
  if test -n "$runtime_container"; then
    docker rm -f "$runtime_container" >/dev/null 2>&1 || true
  fi
  if test -n "$migrator_container"; then
    docker rm -f "$migrator_container" >/dev/null 2>&1 || true
  fi
  if test -n "$probe_server_pid"; then
    kill "$probe_server_pid" >/dev/null 2>&1 || true
    wait "$probe_server_pid" >/dev/null 2>&1 || true
  fi
  if test -n "$materializer_volume"; then
    docker volume rm "$materializer_volume" >/dev/null 2>&1 || true
  fi
  case "$fixture_directory" in
    "${temporary_root%/}"/slots-cluster-image-contract.*) rm -rf -- "$fixture_directory" ;;
    *) fail "拒绝清理异常路径 $fixture_directory" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

for command in docker python3 grep mktemp cat chmod id uname mkdir cmp awk; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done

docker build --platform linux/amd64 \
  --file "$script_directory/Dockerfile.services" \
  --target rgs-runtime \
  --tag "$runtime_image" \
  "$repository_root"
docker build --platform linux/amd64 \
  --file "$script_directory/Dockerfile.services" \
  --target rgs-migrator \
  --tag "$migrator_image" \
  "$repository_root"

test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$runtime_image")" = linux/amd64 ||
  fail 'RGS 运行镜像不是 linux/amd64'
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$migrator_image")" = linux/amd64 ||
  fail '迁移镜像不是 linux/amd64'
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$runtime_image")" = \
  '["/secret-env","RGS_DATABASE_URL","/rgs-server"]' || fail 'RGS 运行镜像入口不符合集群契约'
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$migrator_image")" = \
  '["/secret-env","RGS_MIGRATOR_DATABASE_URL","/rgs-migrator"]' || fail '迁移镜像入口不符合集群契约'
test "$(docker image inspect --format '{{.Config.User}}' "$runtime_image")" = nonroot:nonroot ||
  fail 'RGS 运行镜像没有固定非 root 用户'
test "$(docker image inspect --format '{{.Config.User}}' "$migrator_image")" = nonroot:nonroot ||
  fail '迁移镜像没有固定非 root 用户'

runtime_container=$(docker create "$runtime_image")
migrator_container=$(docker create "$migrator_image")
docker cp "$runtime_container:/THIRD_PARTY_NOTICES.txt" "$fixture_directory/runtime-third-party-notices.txt"
docker cp "$migrator_container:/THIRD_PARTY_NOTICES.txt" "$fixture_directory/migrator-third-party-notices.txt"
cmp "$repository_root/server/THIRD_PARTY_NOTICES.txt" "$fixture_directory/runtime-third-party-notices.txt" >/dev/null ||
  fail 'RGS 运行镜像没有交付权威 Go 第三方许可声明'
cmp "$repository_root/server/THIRD_PARTY_NOTICES.txt" "$fixture_directory/migrator-third-party-notices.txt" >/dev/null ||
  fail '迁移镜像没有交付权威 Go 第三方许可声明'

# Docker Desktop 会把 Linux 容器在 macOS bind mount 上创建的 0400 文件映射为 0600；Docker Desktop can surface a Linux-created 0400 file as 0600 on a macOS bind mount.
# 使用 daemon 管理的卷模拟 Kubernetes emptyDir/fsGroup；Use a daemon-managed volume to model Kubernetes emptyDir/fsGroup.
# 从 docker cp 的 tar 元数据读取容器侧 mode，避免误判主机文件系统语义；Read the container-side mode from docker cp tar metadata to avoid confusing host filesystem semantics with an image regression.
volume_initializer_image=$(awk '
  $1 == "ARG" && $2 ~ /^GO_IMAGE=/ { count += 1; sub(/^GO_IMAGE=/, "", $2); image = $2 }
  END { if (count != 1) exit 1; print image }
' "$script_directory/Dockerfile.services") || fail '无法解析固定摘要的卷初始化镜像'
case "$volume_initializer_image" in
  *@sha256:*) ;;
  *) fail '卷初始化镜像没有固定摘要' ;;
esac
materializer_volume="slots-cluster-image-materializer-${fixture_directory##*.}"
docker volume create "$materializer_volume" >/dev/null
docker run --rm --platform linux/amd64 --user 0:0 \
  --mount "type=volume,src=$materializer_volume,dst=/run/materializer" \
  --entrypoint /bin/sh \
  "$volume_initializer_image" -eu -c '
    install -d -o 0 -g 65532 -m 0750 /run/materializer/source
    install -d -o 65532 -g 65532 -m 0700 /run/materializer/destination
    printf "%s\n" materialized-secret > /run/materializer/source/secret
    chown 0:65532 /run/materializer/source/secret
    chmod 0440 /run/materializer/source/secret
  '
docker run --rm --platform linux/amd64 \
  --user 65532:65532 \
  --mount "type=volume,src=$materializer_volume,dst=/run/materializer" \
  --entrypoint /secret-materializer \
  "$runtime_image" /run/materializer/source/secret /run/materializer/destination/secret
materializer_container=$(docker create --platform linux/amd64 \
  --mount "type=volume,src=$materializer_volume,dst=/run/materializer,readonly" \
  "$runtime_image")
materializer_archive="$fixture_directory/materialized-secret.tar"
docker cp "$materializer_container:/run/materializer/destination/secret" - >"$materializer_archive"
python3 - "$materializer_archive" <<'PYTHON'
import sys
import tarfile

with tarfile.open(sys.argv[1], mode="r:*") as archive:
    members = [member for member in archive.getmembers() if member.isfile()]
    if len(members) != 1:
        raise SystemExit("物化凭据 tar 必须只包含一个普通文件")
    member = members[0]
    extracted = archive.extractfile(member)
    if extracted is None:
        raise SystemExit("物化凭据 tar 无法读取")
    payload = extracted.read()

if member.mode != 0o400 or payload != b"materialized-secret\n":
    raise SystemExit("物化凭据不是 0400 或内容不一致")
PYTHON
docker rm "$materializer_container" >/dev/null
materializer_container=''
if docker run --rm --platform linux/amd64 \
  --user 65532:65532 \
  --mount "type=volume,src=$materializer_volume,dst=/run/materializer" \
  --entrypoint /secret-materializer \
  "$runtime_image" /run/materializer/source/secret /run/materializer/destination/secret >/dev/null 2>&1; then
  fail '/secret-materializer 错误覆盖了已有凭据'
fi

runtime_missing_secret_log="$fixture_directory/runtime-missing-secret.log"
if docker run --rm --platform linux/amd64 "$runtime_image" >"$runtime_missing_secret_log" 2>&1; then
  fail 'RGS 运行镜像在缺少数据库 Secret 文件时启动成功'
fi
grep -F 'secret-env: absolute secret file path is required' "$runtime_missing_secret_log" >/dev/null ||
  fail 'RGS 运行镜像没有由 /secret-env 失败关闭'

migrator_missing_secret_log="$fixture_directory/migrator-missing-secret.log"
if docker run --rm --platform linux/amd64 "$migrator_image" >"$migrator_missing_secret_log" 2>&1; then
  fail '迁移镜像在缺少数据库 Secret 文件时启动成功'
fi
grep -F 'secret-env: absolute secret file path is required' "$migrator_missing_secret_log" >/dev/null ||
  fail '迁移镜像没有由 /secret-env 失败关闭'

probe_missing_url_log="$fixture_directory/probe-missing-url.log"
if docker run --rm --platform linux/amd64 --entrypoint /service-probe "$runtime_image" >"$probe_missing_url_log" 2>&1; then
  fail '/service-probe 在缺少目标 URL 时错误成功'
fi
grep -F 'service-probe: PROBE_URL is required' "$probe_missing_url_log" >/dev/null ||
  fail '/service-probe 不存在、不可执行或没有失败关闭'

probe_port_file="$fixture_directory/probe-port"
python3 - "$probe_port_file" <<'PYTHON' &
import http.server
import pathlib
import sys


class ContractHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        status = 200 if self.path == "/readyz" else 503
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, _format, *_args):
        return


server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), ContractHandler)
pathlib.Path(sys.argv[1]).write_text(str(server.server_port), encoding="ascii")
server.serve_forever()
PYTHON
probe_server_pid=$!

attempt=0
while test ! -s "$probe_port_file"; do
  attempt=$((attempt + 1))
  test "$attempt" -le 50 || fail '本地探针夹具未能启动'
  kill -0 "$probe_server_pid" >/dev/null 2>&1 || fail '本地探针夹具提前退出'
  sleep 0.1
done
probe_port=$(cat "$probe_port_file")
case "$probe_port" in
  ''|*[!0-9]*) fail '本地探针夹具返回非法端口' ;;
esac

if test "$(uname -s)" = Linux; then
  probe_host=127.0.0.1
  probe_network=host
else
  probe_host=host.docker.internal
  probe_network=bridge
fi

docker run --rm --platform linux/amd64 --network "$probe_network" --entrypoint /service-probe \
  -e "PROBE_URL=http://${probe_host}:${probe_port}/readyz" \
  "$runtime_image"

database_secret="$fixture_directory/database-url"
printf '%s\n' 'postgres://contract:contract@database.invalid/contract?sslmode=verify-full' > "$database_secret"
chmod 0440 "$database_secret"
docker run --rm --platform linux/amd64 --network "$probe_network" \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$fixture_directory,dst=/run/cluster-contract,readonly" \
  --entrypoint /secret-env \
  -e RGS_DATABASE_URL_FILE=/run/cluster-contract/database-url \
  -e "PROBE_URL=http://${probe_host}:${probe_port}/readyz" \
  "$runtime_image" RGS_DATABASE_URL /service-probe

probe_failure_log="$fixture_directory/probe-failure.log"
if docker run --rm --platform linux/amd64 --network "$probe_network" --entrypoint /service-probe \
  -e "PROBE_URL=http://${probe_host}:${probe_port}/not-ready" \
  "$runtime_image" >"$probe_failure_log" 2>&1; then
  fail '/service-probe 错误接受了非 200 响应'
fi
grep -F 'service-probe: unexpected HTTP status 503' "$probe_failure_log" >/dev/null ||
  fail '/service-probe 没有按 HTTP 状态失败关闭'

printf '%s\n' 'cluster image runtime contract: passed'
