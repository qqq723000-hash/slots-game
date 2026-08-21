#!/bin/sh
# 只启动 bootstrap 已审计构建的生产镜像，然后执行端到端验收。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_node22
require_state
compose config --quiet
# 源码、依赖或构建配置变化后必须重新执行 bootstrap。这里禁止重建，避免把
# 新工作区字节错误标记为旧 compose.env 中记录的 revision。
compose up -d --no-build --force-recreate
"$local_production_directory/verify.sh"
