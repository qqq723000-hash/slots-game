#!/bin/sh
# 只停止容器；数据、密钥、备份和监控卷全部保留。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_state
compose down --remove-orphans
