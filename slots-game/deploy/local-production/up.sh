#!/bin/sh
# 只启动 bootstrap 已审计构建的生产镜像，然后执行端到端验收。
# English: Only launch the artifactsion image of the bootstrap audited build and then perform end-to-end
# acceptance.
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_node22
require_state
acquire_deployment_lock
verify_state_definition_binding
compose config --quiet
# 源码、依赖或构建配置变化后必须重新执行 bootstrap。这里禁止重建，避免把
# 新工作区字节错误标记为旧 compose.env 中记录的 revision。
# English: Bootstrap must be re-executed after changes in source code, dependencies or build configuration.
# Reconstruction is prohibited here to avoid New workspace byte errors are marked as revisions recorded in the
# old compose.env.
compose up -d --no-build --force-recreate
"$local_production_directory/verify.sh"
