#!/bin/sh
# 只停止容器；数据、密钥、备份和监控卷全部保留。
# English: Only the container is stopped; data, keys, backups, and monitoring volumes are all preserved.
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_state
acquire_deployment_lock
compose down --remove-orphans
