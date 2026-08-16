#!/bin/sh
# 把宿主机初始材料按服务白名单分配到独立卷。
# CA 私钥和 definition approval 私钥未出现在任何复制列表中。
set -eu
umask 077

prepare_directory() {
  directory="$1"
  owner="$2"
  group="$3"
  test -d "$directory"
  chown "$owner:$group" "$directory"
  chmod 0700 "$directory"
}

copy_secret() {
  source_name="$1"
  destination_directory="$2"
  destination_name="${3:-$source_name}"
  owner="$4"
  group="$5"
  source="/run/secrets/$source_name"
  test -f "$source"
  install -m 0600 -o "$owner" -g "$group" "$source" "$destination_directory/$destination_name"
}

for specification in \
  '/target/rgs-runtime:65532:65532' \
  '/target/rgs-migrator:65532:65532' \
  '/target/operator:65532:65532' \
  '/target/operator-bootstrap:65532:65532' \
  '/target/operator-derived:65532:65532' \
  '/target/root-ca:65532:65532' \
  '/target/postgres:70:70' \
  '/target/ingress:101:101' \
  '/target/prometheus:65534:65534' \
  '/target/grafana:472:0' \
  '/target/alert:101:101' \
  '/target/alertmanager-webhook:65534:65534' \
  '/target/vector:65534:65534' \
  '/target/backup:65532:65532'; do
  path="${specification%%:*}"
  ownership="${specification#*:}"
  prepare_directory "$path" "${ownership%%:*}" "${ownership##*:}"
done

for name in definition.json definition-approval.json definition-approval-public.pem operators.json \
  access-private.pem access-public.pem operator-request-public.pem operator-response-private.pem \
  operator-response-public.pem wallet-request-private.pem wallet-request-public.pem \
  wallet-response-public.pem launch-hmac.key operations.token outbox-hmac.key \
  local-operator-audit-bearer.token local-production-root-ca.pem rgs-runtime-database.url; do
  copy_secret "$name" /target/rgs-runtime "$name" 65532 65532
done
copy_secret rgs-migrator-database.url /target/rgs-migrator rgs-migrator-database.url 65532 65532
copy_secret local-production-root-ca.pem /target/rgs-migrator local-production-root-ca.pem 65532 65532

for name in local-operator-keys.json wallet-request-public.pem wallet-response-private.pem \
  wallet-response-public.pem operator-request-private.pem operator-request-public.pem \
  operator-response-public.pem local-operator-server.pem local-operator-server-key.pem \
  local-production-root-ca.pem local-operator-admin.token local-operator-metrics.token \
  alertmanager.token outbox-hmac.key local-operator-audit-bearer.token \
  local-operator-log-bearer.token; do
  copy_secret "$name" /target/operator "$name" 65532 65532
done
for name in postgres-admin-local-operator.url local-operator-owner.password \
  local-operator-runtime.password local-production-root-ca.pem; do
  copy_secret "$name" /target/operator-bootstrap "$name" 65532 65532
done
copy_secret local-production-root-ca.pem /target/root-ca local-production-root-ca.pem 65532 65532

for name in postgres-admin.password postgres-backup.password rgs-migrator.password rgs-runtime.password \
  postgres-server.pem postgres-server-key.pem local-production-root-ca.pem; do
  copy_secret "$name" /target/postgres "$name" 70 70
done
for name in ingress-server.pem ingress-server-key.pem local-production-root-ca.pem; do
  copy_secret "$name" /target/ingress "$name" 101 101
done
copy_secret operations.token /target/prometheus rgs_operations_bearer_token 65534 65534
copy_secret alertmanager.token /target/prometheus alertmanager_bearer_token 65534 65534
copy_secret local-operator-metrics.token /target/prometheus local_operator_metrics_bearer_token 65534 65534
copy_secret local-production-root-ca.pem /target/prometheus local-production-root-ca.pem 65534 65534
copy_secret grafana-admin-password /target/grafana grafana_admin_password 472 0
for name in alertmanager-server.pem alertmanager-server-key.pem local-production-root-ca.pem; do
  copy_secret "$name" /target/alert "$name" 101 101
done
for name in alertmanager.token local-production-root-ca.pem; do
  copy_secret "$name" /target/alertmanager-webhook "$name" 65534 65534
done
for name in local-operator-log-bearer.token local-production-root-ca.pem; do
  copy_secret "$name" /target/vector "$name" 65534 65534
done
for name in postgres-backup.password local-production-root-ca.pem; do
  copy_secret "$name" /target/backup "$name" 65532 65532
done

# 渲染后的观测配置不含凭据，但仍以只读、服务专用卷分发。
test -s /source/rendered/prometheus.yml
install -m 0600 -o 65534 -g 65534 /source/rendered/prometheus.yml /target/prometheus/prometheus.yml
mkdir -p /target/prometheus/rules
chown 65534:65534 /target/prometheus/rules
chmod 0700 /target/prometheus/rules
install -m 0600 -o 65534 -g 65534 /source/rendered/rules/rgs-alerts.yml /target/prometheus/rules/rgs-alerts.yml
mkdir -p /target/grafana/provisioning /target/grafana/dashboards
cp -R /source/rendered/grafana/provisioning/. /target/grafana/provisioning/
cp -R /source/rendered/grafana/dashboards/. /target/grafana/dashboards/
chown -R 472:0 /target/grafana
find /target/grafana -type d -exec chmod 0700 {} +
find /target/grafana -type f -exec chmod 0600 {} +

for directory_owner in \
  '/target/operator-data:65532:65532' '/target/prometheus-data:65534:65534' \
  '/target/grafana-data:472:0' '/target/alertmanager-data:65534:65534' \
  '/target/vector-data:65534:65534'; do
  path="${directory_owner%%:*}"
  ownership="${directory_owner#*:}"
  test -d "$path"
  chown "${ownership%%:*}:${ownership##*:}" "$path"
  chmod 0700 "$path"
  # 非空 marker 防止 Docker 首次挂载时用镜像目录的 root 属性重新覆盖卷根。
  : >"$path/.initialized"
  chown "${ownership%%:*}:${ownership##*:}" "$path/.initialized"
  chmod 0600 "$path/.initialized"
done

# 运营数据卷只初始化必需父目录，绝不清理已持久化的审计或日志。
mkdir -p /target/operator-data/audit /target/operator-data/logs /target/operator-data/alerts
chown 65532:65532 /target/operator-data /target/operator-data/audit \
  /target/operator-data/logs /target/operator-data/alerts
chmod 0700 /target/operator-data /target/operator-data/audit \
  /target/operator-data/logs /target/operator-data/alerts

printf '%s\n' 'local production service volumes: initialized'
