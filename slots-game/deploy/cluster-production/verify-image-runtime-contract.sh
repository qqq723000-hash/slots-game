#!/bin/sh
# 真实构建并执行集群发布镜像，防止静态模板与最终镜像入口悄然分叉。
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

fail() {
  printf '%s\n' "cluster image runtime contract: $*" >&2
  exit 1
}

cleanup() {
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
  case "$fixture_directory" in
    "${temporary_root%/}"/slots-cluster-image-contract.*) rm -rf -- "$fixture_directory" ;;
    *) fail "拒绝清理异常路径 $fixture_directory" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

for command in docker python3 grep mktemp cat chmod id uname mkdir cmp; do
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

materializer_directory="$fixture_directory/materializer"
mkdir "$materializer_directory"
printf '%s\n' 'materialized-secret' >"$materializer_directory/source"
chmod 0440 "$materializer_directory/source"
docker run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$materializer_directory,dst=/run/materializer" \
  --entrypoint /secret-materializer \
  "$runtime_image" /run/materializer/source /run/materializer/destination
python3 - "$materializer_directory/destination" <<'PYTHON'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
if stat.S_IMODE(os.stat(path).st_mode) != 0o400 or path.read_text(encoding="utf-8") != "materialized-secret\n":
    raise SystemExit("物化凭据不是 0400 或内容不一致")
PYTHON
if docker run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$materializer_directory,dst=/run/materializer" \
  --entrypoint /secret-materializer \
  "$runtime_image" /run/materializer/source /run/materializer/destination >/dev/null 2>&1; then
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
