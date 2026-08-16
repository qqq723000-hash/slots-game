#!/bin/sh
# 启动所有生产服务，然后执行端到端验收。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_node22
require_state
compose config --quiet
# 配置通过只读 bind/命名卷注入；即使镜像摘要未变，也必须重建容器才能保证
# Prometheus、Grafana、Alertmanager、Vector 与入口实际加载本次渲染结果。
compose build --provenance=mode=max rgs-migrator rgs-server local-operator web
compose up -d --no-build --force-recreate
"$local_production_directory/verify.sh"
