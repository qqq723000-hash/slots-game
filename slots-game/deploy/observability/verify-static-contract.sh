#!/bin/sh

# 该门禁不依赖 daemon，只验证入库模板；部署仍必须校验完成替换且已经审批的渲染产物。
set -eu

rendered_dir=''
rendered_mode=''
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ -z "$2" ]; then
    printf '%s\n' 'usage: verify-static-contract.sh [--rendered-dir PATH | --rendered-static-dir PATH]' >&2
    exit 2
  fi
  case "$1" in
    --rendered-dir)
      # 生产发布模式必须再由固定来源 promtool 做完整 PromQL/config 校验。
      rendered_mode='release'
      ;;
    --rendered-static-dir)
      # 仅供 daemon-independent 临时 bundle 回归；Make 的发布门禁绝不能使用此模式。
      rendered_mode='static-regression'
      ;;
    *)
      printf '%s\n' 'usage: verify-static-contract.sh [--rendered-dir PATH | --rendered-static-dir PATH]' >&2
      exit 2
      ;;
  esac
  rendered_dir=$2
fi

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)

compose_file="$script_dir/compose.yml"
prometheus_file="$script_dir/prometheus.yml"
rules_file="$script_dir/rules/rgs-alerts.yml"
datasource_file="$script_dir/grafana/provisioning/datasources/prometheus.yml"
provider_file="$script_dir/grafana/provisioning/dashboards/rgs.yml"
dashboard_file="$script_dir/grafana/dashboards/rgs-overview.json"
vector_file="$script_dir/vector.yaml"
metrics_source="$repository_root/server/internal/platform/metrics.go"
retention_file="$script_dir/retention-policy.example.yml"
readme_file="$script_dir/README.md"
runtime_smoke_file="$script_dir/ci-runtime-smoke.sh"
production_smoke_file="$script_dir/ci-runtime-production-smoke.sh"
rendered_test_file="$script_dir/test-rendered-contract.sh"

fail() {
  printf '%s\n' "observability contract: $*" >&2
  exit 1
}

require_file() {
  test -f "$1" || fail "missing ${1#"$repository_root/"}"
}

require_fixed() {
  expected=$1
  file=$2
  grep -F -- "$expected" "$file" >/dev/null ||
    fail "missing '$expected' in ${file#"$repository_root/"}"
}

require_line() {
  expected=$1
  file=$2
  grep -F -x -- "$expected" "$file" >/dev/null ||
    fail "missing exact line '$expected' in ${file#"$repository_root/"}"
}

require_regex() {
  expression=$1
  file=$2
  grep -E -- "$expression" "$file" >/dev/null ||
    fail "missing /$expression/ in ${file#"$repository_root/"}"
}

for required_file in \
  "$compose_file" \
  "$prometheus_file" \
  "$rules_file" \
  "$datasource_file" \
  "$provider_file" \
  "$dashboard_file" \
  "$vector_file" \
  "$metrics_source" \
  "$retention_file" \
  "$readme_file" \
  "$runtime_smoke_file" \
  "$production_smoke_file" \
  "$rendered_test_file"
do
  require_file "$required_file"
done

command -v ruby >/dev/null 2>&1 || fail 'ruby is required to parse YAML'
ruby -e '
  require "yaml"
  ARGV.each do |path|
    YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
  rescue StandardError => error
    warn "#{path}: #{error.message}"
    exit 1
  end
' "$compose_file" "$prometheus_file" "$rules_file" "$datasource_file" \
  "$provider_file" "$vector_file" "$retention_file" || fail 'YAML parsing failed'
ruby -e '
  require "yaml"
  compose = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  services = compose.fetch("services")
  abort "Vector must join only observability and restricted log-egress networks" unless
    services.dig("vector", "networks") == ["observability", "log-egress"]
  abort "Vector must not publish inbound ports" if services.dig("vector", "ports")
  abort "Prometheus must join only observability, private RGS operations and restricted alert egress networks" unless
    services.dig("prometheus", "networks") == ["observability", "rgs-operations", "alert-egress"]
  abort "Grafana must remain on the internal observability network" unless
    services.dig("grafana", "networks") == ["observability"]
' "$compose_file" || fail 'compose network isolation contract failed'
ruby -ryaml -e '
  document = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  rules = document.fetch("groups").flat_map { |group| group.fetch("rules") }
  alert = rules.find { |rule| rule["alert"] == "RGSSecurityLogDropsSustained" }
  abort "missing security-log drop alert" unless alert
  abort "security-log drop alert semantics changed" unless
    alert.fetch("expr") == "sum by (job, environment) (increase(rgs_security_logs_dropped_total[5m])) > 0" &&
      alert.fetch("for") == "5m" && alert.dig("labels", "severity") == "warning"
' "$rules_file" || fail 'security-log drop alert contract failed'

command -v python3 >/dev/null 2>&1 || fail 'python3 is required to parse Grafana JSON'
python3 -m json.tool "$dashboard_file" >/dev/null || fail 'Grafana dashboard JSON parsing failed'
bash -n "$runtime_smoke_file" || fail 'runtime operations smoke script has invalid Bash syntax'
bash -n "$production_smoke_file" || fail 'production runtime smoke script has invalid Bash syntax'
sh -n "$rendered_test_file" || fail 'rendered bundle regression script has invalid shell syntax'

# Compose 供应链与网络隔离不变量。
for image_variable in PROMETHEUS_IMAGE GRAFANA_IMAGE VECTOR_IMAGE; do
  require_fixed "\${$image_variable:?" "$compose_file"
done
image_lines=$(grep -E '^[[:space:]]+image:' "$compose_file" || true)
image_line_count=$(printf '%s\n' "$image_lines" | grep -c . || true)
test "$image_line_count" -eq 3 || fail 'compose must declare exactly three controlled image references'
if printf '%s\n' "$image_lines" | grep -Ev '\$\{(PROMETHEUS|GRAFANA|VECTOR)_IMAGE:\?' >/dev/null; then
  fail 'compose contains an image reference not supplied through a required release variable'
fi
require_fixed 'OBSERVABILITY_BIND_ADDRESS:-127.0.0.1' "$compose_file"
require_line '    internal: true' "$compose_file"
require_fixed 'RGS_OPERATIONS_NETWORK:?' "$compose_file"
require_fixed 'RGS_LOG_EGRESS_NETWORK:?' "$compose_file"
require_fixed 'RGS_ALERT_EGRESS_NETWORK:?' "$compose_file"
require_fixed 'RGS_CONTAINER_LOG_ROOT:?' "$compose_file"
require_fixed 'RGS_CONTAINER_LOG_GID:?' "$compose_file"
require_fixed 'RGS_VECTOR_DATA_DIR:?' "$compose_file"
require_line '      VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION: "true"' "$compose_file"
require_fixed 'GRAFANA_ADMIN_PASSWORD_FILE:?' "$compose_file"
require_fixed 'RGS_OPERATIONS_BEARER_TOKEN_FILE:?' "$compose_file"
require_fixed 'ALERTMANAGER_BEARER_TOKEN_FILE:?' "$compose_file"
if grep -F -- '/var/run/docker.sock' "$compose_file" "$vector_file" >/dev/null; then
  fail 'docker.sock must never be exposed to the log collector'
fi
read_only_count=$(grep -F -c -- '    read_only: true' "$compose_file" || true)
test "$read_only_count" -eq 3 || fail 'every observability service must have a read-only root filesystem'

# Prometheus 抓取、记录规则、告警和有界标签基数契约。
require_line '  scrape_interval: 15s' "$prometheus_file"
require_line '  evaluation_interval: 15s' "$prometheus_file"
require_line '  - job_name: prometheus' "$prometheus_file"
require_line '          - 127.0.0.1:9090' "$prometheus_file"
require_line '  - job_name: rgs' "$prometheus_file"
require_line '    metrics_path: /metrics' "$prometheus_file"
require_line '          - rgs-server:8081' "$prometheus_file"
require_line '      type: Bearer' "$prometheus_file"
require_line '      credentials_file: /run/secrets/rgs_operations_bearer_token' "$prometheus_file"
require_line '  - job_name: vector' "$prometheus_file"
require_line '          - vector:9598' "$prometheus_file"
require_line 'alerting:' "$prometheus_file"
require_line '        credentials_file: /run/secrets/alertmanager_bearer_token' "$prometheus_file"
require_line '            - "__ALERTMANAGER_TARGET__"' "$prometheus_file"
require_fixed '__ENVIRONMENT__' "$prometheus_file"
require_fixed '__CLUSTER_ID__' "$prometheus_file"

for recording_rule in \
  'rgs:http_request_rate:rate5m' \
  'rgs:http_total_failure_rate:rate5m' \
  'rgs:http_server_failure_ratio:rate5m' \
  'rgs:http_request_duration_seconds:p99_5m' \
  'rgs:round_commit_gap:increase10m' \
  'rgs:db_pool_utilization:ratio' \
  'rgs:http_connection_utilization:ratio'
do
  require_fixed "$recording_rule" "$rules_file"
  require_fixed "$recording_rule" "$dashboard_file"
done

for metric in \
  rgs_http_requests_total \
  rgs_http_failures_total \
  rgs_http_server_failures_total \
  rgs_http_request_duration_seconds_bucket \
  rgs_ready \
  rgs_db_pool_in_use_connections \
  rgs_db_pool_max_open_connections \
  rgs_auth_failures_total \
  rgs_rate_limited_total \
  rgs_capacity_rejected_total \
  rgs_cryptographic_capacity_rejected_total \
  rgs_security_logs_dropped_total \
  rgs_http_active_connections \
  rgs_http_connection_limit \
  rgs_rounds_prepared_total \
  rgs_rounds_committed_total \
  rgs_wallet_unknown_outcomes_total \
  rgs_rounds_manual_review_total \
  rgs_round_integrity_quarantines_total \
  rgs_session_integrity_quarantines_total \
  rgs_outbox_claimed_total \
  rgs_outbox_published_total \
  rgs_outbox_deferred_total \
  rgs_outbox_lease_lost_total \
  prometheus_rule_evaluation_failures_total \
  prometheus_notifications_errors_total \
  vector_component_errors_total \
  vector_component_discarded_events_total \
  vector_component_received_events_total \
  vector_component_sent_events_total \
  vector_buffer_size_bytes
do
  require_fixed "$metric" "$rules_file"
done

for alert_name in \
  RGSInstanceDown \
  RGSNotReady \
  RGSCapacityRejectionsSustained \
  RGSConnectionCapacityNearLimit \
  RGSCryptographicCapacitySaturated \
  RGSSecurityLogDropsSustained \
  RGSHTTPFailureRatioHigh \
  RGSRequestLatencyP99High \
  RGSDatabasePoolSaturated \
  RGSWalletUnknownOutcome \
  RGSRoundManualReviewRequired \
  RGSIntegrityQuarantine \
  RGSOutboxDeliveryDeferred \
  RGSOutboxPublishStalled \
  RGSOutboxLeaseLost \
  RGSRoundCommitGapGrowing \
  RGSObservabilityWatchdog \
  PrometheusRuleEvaluationFailures \
  PrometheusNotificationErrors \
  VectorTelemetryUnavailable \
  VectorLogPipelineErrors \
  VectorLogEventsDiscarded \
  VectorLogBufferNearCapacity \
  VectorLogDeliveryStalled
do
  require_fixed "alert: $alert_name" "$rules_file"
done
require_fixed '__RUNBOOK_BASE_URL__' "$rules_file"
require_fixed 'unless on (job, instance) rgs_ready{job="rgs"}' "$rules_file"
require_fixed 'increase(rgs_capacity_rejected_total[5m])' "$rules_file"
require_fixed 'sum by (job, environment) (increase(rgs_security_logs_dropped_total[5m])) > 0' "$rules_file"
require_fixed '{"rgs_security_logs_dropped_total",' "$metrics_source"
require_fixed 'rgs_http_active_connections / clamp_min(rgs_http_connection_limit, 1)' "$rules_file"
require_fixed '214748390' "$rules_file"
require_fixed 'uid: rgs-prometheus' "$datasource_file"
require_fixed 'editable: false' "$datasource_file"
require_fixed 'allowUiUpdates: false' "$provider_file"
require_fixed '"uid": "rgs-release-overview"' "$dashboard_file"
require_fixed 'rgs_ready{job=\"rgs\"}' "$dashboard_file"
require_fixed 'rgs_capacity_rejected_total' "$dashboard_file"
require_fixed 'rgs:http_connection_utilization:ratio' "$dashboard_file"

if grep -Ei '(operator|player|session|round|request|transaction)_id[[:space:]]*(=|=~)' \
  "$rules_file" "$dashboard_file" >/dev/null; then
  fail 'PromQL must not select or aggregate on high-cardinality business identifiers'
fi

# 日志最小化、出口失败即拒绝与磁盘缓冲上限。
require_fixed 'type: file' "$vector_file"
require_line '    type: internal_metrics' "$vector_file"
require_line '    namespace: vector' "$vector_file"
require_line '      host_key: ""' "$vector_file"
# Vector 环境变量由部署时展开；此处只核对配置中的字面量引用。
# shellcheck disable=SC2016
require_fixed '"${RGS_CONTAINER_LOG_GLOB}"' "$vector_file"
# shellcheck disable=SC2016
require_fixed '"${RGS_LOG_SINK_URI}"' "$vector_file"
require_fixed 'type: disk' "$vector_file"
require_fixed 'max_size: 268435488' "$vector_file"
require_fixed 'when_full: block' "$vector_file"
require_line '    type: prometheus_exporter' "$vector_file"
require_line '      - vector_internal_metrics' "$vector_file"
require_line '    address: 0.0.0.0:9598' "$vector_file"
if grep -E '^[[:space:]]+retry_attempts:' "$vector_file" >/dev/null; then
  fail 'the durable log sink must not discard a batch after a finite retry count'
fi
require_fixed '.message = "unparseable-log-redacted"' "$vector_file"
if grep -F '.message = raw' "$vector_file" >/dev/null; then
  fail 'unparseable log lines must not be forwarded verbatim'
fi
require_line '      - --require-healthy' "$compose_file"
for removed_field in remote_ip authorization access_token refresh_token cookie signature private_key database_url wallet_request wallet_response error stack stacktrace; do
  require_fixed "del(.$removed_field)" "$vector_file"
done
if grep -Ei '(authorization:[[:space:]]*"?bearer|bearer_token:[[:space:]]+[^[:space:]#]|token=|password=)' "$vector_file" "$compose_file" "$prometheus_file" >/dev/null; then
  fail 'observability config must not embed credentials'
fi

# 临时 bundle 与 production-config smoke 必须保留失败闭合和“非发布证据”边界。
# shellcheck disable=SC2016
require_fixed '--rendered-static-dir "$good_bundle"' "$rendered_test_file"
require_fixed 'missing RGS scrape was accepted' "$rendered_test_file"
require_fixed 'missing Vector scrape was accepted' "$rendered_test_file"
require_fixed 'structurally invalid rule was accepted' "$rendered_test_file"
require_fixed 'release gate accepted an untrusted promtool source' "$rendered_test_file"
require_fixed 'incompatible PostgreSQL TLS algorithm was accepted' "$rendered_test_file"
require_fixed 'RGS_CI_RUNTIME_FIXTURE_PROFILE=development' "$runtime_smoke_file"
require_fixed 'RGS_CI_RUNTIME_FIXTURE_PROFILE=production' "$production_smoke_file"
require_fixed 'http://127.0.0.1:18081/healthz || true' "$runtime_smoke_file"
require_fixed 'expect_status 404 http://127.0.0.1:18080/healthz' "$runtime_smoke_file"
require_fixed 'expect_status 200 http://127.0.0.1:18081/healthz' "$runtime_smoke_file"
require_fixed 'http://127.0.0.1:18181/healthz || true' "$production_smoke_file"
require_fixed 'expect_status 404 http://127.0.0.1:18180/healthz' "$production_smoke_file"
require_fixed 'expect_status 200 http://127.0.0.1:18181/healthz' "$production_smoke_file"
if grep -F 'expect_status 200 http://127.0.0.1:18080/healthz' "$runtime_smoke_file" >/dev/null \
    || grep -F 'expect_status 200 http://127.0.0.1:18180/healthz' "$production_smoke_file" >/dev/null; then
  fail 'runtime smoke must not restore public RGS liveness'
fi
require_fixed 'CI_ONLY_NOT_RELEASE_EVIDENCE' "$production_smoke_file"
require_fixed 'RGS_ENVIRONMENT=production' "$production_smoke_file"
require_fixed 'sslmode=verify-full' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'PGSSLROOTCERT="$fixture_dir/postgres-root-ca.pem"' "$production_smoke_file"
require_fixed 'openssl req -new -x509 -newkey rsa:3072 -nodes -sha256 -days 2' "$production_smoke_file"
require_fixed 'basicConstraints=critical,CA:TRUE,pathlen:0' "$production_smoke_file"
require_fixed 'keyUsage=critical,digitalSignature,keyEncipherment' "$production_smoke_file"
require_fixed 'extendedKeyUsage=serverAuth' "$production_smoke_file"
require_fixed 'subjectAltName=DNS:localhost,IP:127.0.0.1' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'openssl verify -purpose sslserver -CAfile "$fixture_dir/postgres-root-ca.pem"' "$production_smoke_file"
require_fixed 'Signature Algorithm: sha256WithRSAEncryption' "$production_smoke_file"
require_fixed 'Public Key Algorithm: rsaEncryption' "$production_smoke_file"
require_fixed 'TLS Web Server Authentication' "$production_smoke_file"
require_fixed 'DNS:localhost, IP Address:127.0.0.1' "$production_smoke_file"
require_fixed 'postgres_certificate_key_digest' "$production_smoke_file"
require_fixed 'postgres_private_key_digest' "$production_smoke_file"
require_fixed 'sslrootcert=/run/rgs-production-smoke/postgres-root-ca.pem' "$production_smoke_file"
if grep -F 'channel_binding=disable' "$production_smoke_file" >/dev/null; then
  fail 'production smoke must not disable PostgreSQL channel binding'
fi
require_fixed 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' "$production_smoke_file"
require_fixed 'PostgreSQL verify-full TLS barrier timed out' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'docker logs --tail 80 "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER"' "$production_smoke_file"
require_fixed 'production requires rgs-definition-approval-v2' "$production_smoke_file"
require_fixed 'RGS_OPERATIONS_BEARER_TOKEN_FILE is required in production' "$production_smoke_file"
require_fixed '"name":"outbox_delivery","ok":true' "$production_smoke_file"
require_fixed "grep -F -x 'rgs_ready 1'" "$production_smoke_file"
require_fixed 'openssl s_server -accept 18443' "$production_smoke_file"
require_fixed 'runtime-startup-failure.raw.log' "$runtime_smoke_file"
require_fixed 'runtime-startup-failure.raw.log' "$production_smoke_file"
require_fixed 'runtime.raw.log' "$runtime_smoke_file"
require_fixed 'runtime-production-ci-only.raw.log' "$production_smoke_file"
# shellcheck disable=SC2016
if grep -E 'docker logs.*\$artifact_dir' "$runtime_smoke_file" "$production_smoke_file" >/dev/null; then
  fail 'raw runtime logs must remain in the temporary fixture and never enter uploaded artifacts'
fi
if grep -E '(cat[[:space:]]*>|ci_runtime_smoke_fixture_[^/]*\.go)' \
  "$runtime_smoke_file" "$production_smoke_file" >/dev/null; then
  fail 'runtime smoke scripts must not generate or mutate Go source files'
fi

# 仓库模板必须明确保持未审批状态，不能被误当作合规证据。
require_line 'status: DRAFT_NOT_APPROVED' "$retention_file"
require_fixed '__REQUIRED_POLICY_REFERENCE__' "$retention_file"
require_fixed '__REQUIRED_JURISDICTION__' "$retention_file"
require_fixed '__REQUIRED_POSITIVE_INTEGER__' "$retention_file"
require_fixed '__REQUIRED_LEGAL_HOLD_RUNBOOK__' "$retention_file"
if grep -E '^status:[[:space:]]+APPROVED$' "$retention_file" >/dev/null; then
  fail 'the checked-in retention example must never claim approval'
fi

# 可选语义校验器用于增加覆盖，但不能把本地 daemon 变成静态门禁前置条件。
if command -v promtool >/dev/null 2>&1; then
  promtool check rules "$rules_file" >/dev/null || fail 'promtool rejected alert rules'
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  synthetic_digest='sha256:0000000000000000000000000000000000000000000000000000000000000000'
  PROMETHEUS_IMAGE="example.invalid/prometheus@$synthetic_digest" \
  GRAFANA_IMAGE="example.invalid/grafana@$synthetic_digest" \
  VECTOR_IMAGE="example.invalid/vector@$synthetic_digest" \
  PROMETHEUS_RETENTION_TIME=1d \
  PROMETHEUS_RETENTION_SIZE=64MB \
  GRAFANA_ADMIN_PASSWORD_FILE="$retention_file" \
  RGS_OPERATIONS_BEARER_TOKEN_FILE="$retention_file" \
  ALERTMANAGER_BEARER_TOKEN_FILE="$retention_file" \
  RGS_OPERATIONS_NETWORK=contract-only \
  RGS_LOG_EGRESS_NETWORK=contract-egress-only \
  RGS_ALERT_EGRESS_NETWORK=contract-alert-egress-only \
  RGS_CONTAINER_LOG_ROOT="$script_dir" \
  RGS_CONTAINER_LOG_GID=65534 \
  RGS_VECTOR_DATA_DIR="$script_dir" \
  RGS_CONTAINER_LOG_GLOB='/var/log/containers/rgs-server-contract.log' \
  RGS_LOG_SINK_URI='https://logs.example.invalid/v1/logs' \
    docker compose --file "$compose_file" config --quiet >/dev/null ||
      fail 'docker compose rejected observability template structure'
fi

# 发布流水线必须对渲染副本启用失败即拒绝校验。入库模板刻意保留占位符；可部署 bundle
# 的 Prometheus、规则和仪表盘活动配置必须重新解析并满足完整结构契约，不能只做字符串替换检查。
if [ -n "$rendered_dir" ]; then
  test -d "$rendered_dir" || fail "rendered directory does not exist: $rendered_dir"
  rendered_prometheus="$rendered_dir/prometheus.yml"
  rendered_rules="$rendered_dir/rules/rgs-alerts.yml"
  rendered_dashboard="$rendered_dir/grafana/dashboards/rgs-overview.json"
  require_file "$rendered_prometheus"
  require_file "$rendered_rules"
  require_file "$rendered_dashboard"
  if grep -EH '__[A-Z0-9_]+__' "$rendered_prometheus" "$rendered_rules" "$rendered_dashboard" >/dev/null; then
    fail 'rendered release configuration contains unresolved __PLACEHOLDER__ values'
  fi
  ruby -e '
    require "yaml"
    require "json"
    require "uri"

    begin
    prometheus_path, rules_path, dashboard_path = ARGV
    config = YAML.safe_load(
      File.read(prometheus_path), permitted_classes: [], permitted_symbols: [], aliases: false
    )
    rules_config = YAML.safe_load(
      File.read(rules_path), permitted_classes: [], permitted_symbols: [], aliases: false
    )
    dashboard = JSON.parse(File.read(dashboard_path))
    abort "rendered Prometheus config must be an object" unless config.is_a?(Hash)
    abort "rendered rules config must be an object" unless rules_config.is_a?(Hash)
    abort "rendered dashboard must be an object" unless dashboard.is_a?(Hash)

    nonempty = ->(value) { value.is_a?(String) && !value.empty? && value !~ /__[A-Z0-9_]+__/ }
    valid_target = lambda do |target|
      next false unless target.is_a?(String)
      match = /\A(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):([0-9]{1,5})\z/.match(target)
      next false unless match
      Integer(match[1], 10).between?(1, 65_535)
    rescue ArgumentError
      false
    end

    global = config.fetch("global")
    abort "rendered global config must be an object" unless global.is_a?(Hash)
    labels = global.fetch("external_labels")
    abort "rendered external labels must be an object" unless labels.is_a?(Hash)
    abort "rendered environment label is required" unless nonempty.call(labels["environment"])
    abort "rendered cluster label is required" unless nonempty.call(labels["cluster"])
    abort "rendered rule_files must load the controlled rule directory" unless
      config.fetch("rule_files") == ["/etc/prometheus/rules/*.yml"]

    scrape_configs = config.fetch("scrape_configs")
    abort "rendered scrape_configs must be a non-empty array" unless
      scrape_configs.is_a?(Array) && !scrape_configs.empty?
    jobs = scrape_configs.group_by { |job| job.is_a?(Hash) ? job["job_name"] : nil }
    abort "rendered config must contain exactly one Prometheus self-scrape" unless jobs["prometheus"]&.length == 1
    abort "rendered config must contain exactly one RGS scrape" unless jobs["rgs"]&.length == 1
    abort "rendered config must contain exactly one Vector scrape" unless jobs["vector"]&.length == 1

    self_job = jobs.fetch("prometheus").first
    abort "Prometheus self-scrape must remain HTTP /metrics" unless
      self_job.fetch("scheme", "http") == "http" && self_job.fetch("metrics_path", "/metrics") == "/metrics"
    self_targets = self_job.fetch("static_configs").flat_map { |item| item.fetch("targets") }
    abort "Prometheus self-scrape target is invalid" unless self_targets == ["127.0.0.1:9090"]

    rgs_job = jobs.fetch("rgs").first
    abort "RGS scrape must remain HTTP /metrics with honor_labels disabled" unless
      rgs_job.fetch("scheme", "http") == "http" && rgs_job.fetch("metrics_path", "/metrics") == "/metrics" &&
      rgs_job["honor_labels"] == false
    abort "RGS scrape must use a Bearer secret file" unless rgs_job.fetch("authorization") == {
      "type" => "Bearer",
      "credentials_file" => "/run/secrets/rgs_operations_bearer_token"
    }
    rgs_static = rgs_job.fetch("static_configs")
    abort "RGS scrape must have controlled static targets" unless rgs_static.is_a?(Array) && !rgs_static.empty?
    rgs_targets = rgs_static.flat_map { |item| item.fetch("targets") }
    abort "RGS scrape targets are empty or invalid" unless
      !rgs_targets.empty? && rgs_targets.all? { |target| valid_target.call(target) }
    abort "RGS scrape must retain fixed service/environment labels" unless rgs_static.all? do |item|
      item.fetch("labels").fetch("service") == "rgs" && nonempty.call(item.fetch("labels").fetch("environment"))
    end

    vector_job = jobs.fetch("vector").first
    abort "Vector scrape must remain unauthenticated HTTP /metrics on the private network" unless
      vector_job.fetch("scheme", "http") == "http" &&
      vector_job.fetch("metrics_path", "/metrics") == "/metrics" &&
      !vector_job.key?("authorization")
    vector_static = vector_job.fetch("static_configs")
    abort "Vector scrape must have one controlled private target" unless
      vector_static.is_a?(Array) && vector_static.length == 1 &&
      vector_static.first.fetch("targets") == ["vector:9598"]
    abort "Vector scrape must retain fixed service/environment labels" unless
      vector_static.first.fetch("labels").fetch("service") == "vector" &&
      nonempty.call(vector_static.first.fetch("labels").fetch("environment"))

    managers = config.fetch("alerting").fetch("alertmanagers")
    abort "rendered config must contain exactly one controlled Alertmanager" unless
      managers.is_a?(Array) && managers.length == 1
    manager = managers.first
    abort "Alertmanager scheme must be HTTPS" unless manager.fetch("scheme") == "https"
    authorization = manager.fetch("authorization")
    abort "Alertmanager authorization must use a Bearer secret file" unless
      authorization == {
        "type" => "Bearer",
        "credentials_file" => "/run/secrets/alertmanager_bearer_token"
      }
    target = manager.fetch("static_configs").fetch(0).fetch("targets").fetch(0)
    abort "Alertmanager target must be one valid host:port" unless valid_target.call(target)

    groups = rules_config.fetch("groups")
    abort "rendered rules must contain non-empty groups" unless groups.is_a?(Array) && !groups.empty?
    group_names = groups.map { |group| group.fetch("name") }
    abort "rendered rule group names must be non-empty and unique" unless
      group_names.all? { |name| nonempty.call(name) } && group_names.uniq.length == group_names.length
    recording_names = []
    alert_names = []
    groups.each do |group|
      entries = group.fetch("rules")
      abort "rendered rule group must not be empty" unless entries.is_a?(Array) && !entries.empty?
      entries.each do |rule|
        abort "rendered rule entry must be an object" unless rule.is_a?(Hash)
        kinds = [rule.key?("record"), rule.key?("alert")].count(true)
        abort "rendered rule must define exactly one of record or alert" unless kinds == 1
        expression = rule["expr"]
        abort "rendered rule expression must be a non-empty string" unless nonempty.call(expression)
        if rule.key?("record")
          name = rule["record"]
          abort "rendered recording rule name is invalid" unless nonempty.call(name)
          recording_names << name
        else
          name = rule["alert"]
          abort "rendered alert name is invalid" unless nonempty.call(name)
          alert_names << name
          annotations = rule.fetch("annotations")
          runbook = URI.parse(annotations.fetch("runbook_url"))
          abort "rendered alert runbook must use HTTPS" unless runbook.scheme == "https" && runbook.host
          labels = rule.fetch("labels")
          abort "rendered alert must retain severity and service labels" unless
            nonempty.call(labels["severity"]) && nonempty.call(labels["service"])
        end
      end
    end
    abort "rendered recording rule names must be unique" unless recording_names.uniq.length == recording_names.length
    abort "rendered alert names must be unique" unless alert_names.uniq.length == alert_names.length
    required_recordings = %w[
      rgs:http_request_rate:rate5m rgs:http_total_failure_rate:rate5m
      rgs:http_server_failure_ratio:rate5m rgs:http_request_duration_seconds:p99_5m
      rgs:round_commit_gap:increase10m rgs:db_pool_utilization:ratio
      rgs:http_connection_utilization:ratio
    ]
    required_alerts = %w[
      RGSInstanceDown RGSNotReady RGSCapacityRejectionsSustained RGSConnectionCapacityNearLimit
      RGSCryptographicCapacitySaturated RGSSecurityLogDropsSustained
      RGSEconomicAdmissionLimitedSustained RGSEconomicAdmissionErrors
      RGSHTTPFailureRatioHigh
      RGSRequestLatencyP99High RGSDatabasePoolSaturated RGSWalletUnknownOutcome
      RGSRoundManualReviewRequired RGSIntegrityQuarantine RGSOutboxDeliveryDeferred
      RGSOutboxPublishStalled RGSOutboxLeaseLost RGSRoundCommitGapGrowing
      RGSObservabilityWatchdog PrometheusRuleEvaluationFailures PrometheusNotificationErrors
      VectorTelemetryUnavailable VectorLogPipelineErrors VectorLogEventsDiscarded
      VectorLogBufferNearCapacity VectorLogDeliveryStalled
    ]
    security_log_drop = groups.flat_map { |group| group.fetch("rules") }.find do |rule|
      rule["alert"] == "RGSSecurityLogDropsSustained"
    end
    abort "rendered security-log drop alert semantics changed" unless
      security_log_drop &&
      security_log_drop.fetch("expr") ==
        "sum by (job, environment) (increase(rgs_security_logs_dropped_total[5m])) > 0" &&
      security_log_drop.fetch("for") == "5m" &&
      security_log_drop.dig("labels", "severity") == "warning"
    abort "rendered bundle removed required recording rules" unless (required_recordings - recording_names).empty?
    abort "rendered bundle removed required alerts" unless (required_alerts - alert_names).empty?

    abort "rendered dashboard UID/editability contract changed" unless
      dashboard["uid"] == "rgs-release-overview" && dashboard["editable"] == false
    panels = dashboard.fetch("panels")
    abort "rendered dashboard must contain panels" unless panels.is_a?(Array) && !panels.empty?
    expressions = panels.flat_map do |panel|
      Array(panel["targets"]).map { |target_config| target_config["expr"] if target_config.is_a?(Hash) }.compact
    end
    required_dashboard_signals = required_recordings + %w[
      rgs_ready rgs_capacity_rejected_total rgs_economic_admission_allowed_total
      rgs_economic_admission_limited_total rgs_economic_admission_errors_total
    ]
    abort "rendered dashboard removed required release signals" unless required_dashboard_signals.all? do |signal|
      expressions.any? { |expression| expression.is_a?(String) && expression.include?(signal) }
    end
    links = Array(dashboard["links"])
    abort "rendered dashboard must contain one HTTPS runbook link" unless links.any? do |link|
      next false unless link.is_a?(Hash)
      url = URI.parse(link.fetch("url"))
      url.scheme == "https" && url.host
    rescue KeyError, URI::InvalidURIError
      false
    end
    rescue KeyError, TypeError, Psych::Exception, JSON::ParserError, URI::InvalidURIError => error
      warn error.message
      exit 1
    end
  ' "$rendered_prometheus" "$rendered_rules" "$rendered_dashboard" ||
    fail 'rendered Prometheus/rules/dashboard semantic contract failed'
  for image_variable in PROMETHEUS_IMAGE GRAFANA_IMAGE VECTOR_IMAGE; do
    image_value=$(printenv "$image_variable" 2>/dev/null || true)
    printf '%s\n' "$image_value" | grep -E '^[^[:space:]]+@sha256:[0-9a-f]{64}$' >/dev/null ||
      fail "$image_variable must be supplied as a digest-pinned image for rendered validation"
  done
  log_sink_uri=$(printenv RGS_LOG_SINK_URI 2>/dev/null || true)
  ruby -ruri -e '
    value = URI.parse(ARGV.fetch(0))
    abort "log sink must use HTTPS" unless value.scheme == "https" && value.host
    abort "log sink URI must not embed credentials, query or fragment" if
      value.user || value.password || value.query || value.fragment
  ' "$log_sink_uri" || fail 'rendered log sink URI contract failed'

  if [ "$rendered_mode" = 'release' ]; then
    # 生产门禁只信任调用方审批并预载的 digest-pinned Prometheus 镜像。--pull never 与
    # --network none 保证校验不会在执行时换源或联网；宿主 PATH 中的任意 promtool 不足以放行。
    command -v docker >/dev/null 2>&1 || fail 'Docker is required for fixed-source release promtool'
    docker info >/dev/null 2>&1 || fail 'Docker daemon is required for fixed-source release promtool'
    prometheus_image=$(printenv PROMETHEUS_IMAGE 2>/dev/null || true)
    docker image inspect "$prometheus_image" >/dev/null 2>&1 ||
      fail 'PROMETHEUS_IMAGE must be preloaded; release validation never pulls it'
    for promtool_check in \
      'check config /etc/prometheus/prometheus.yml' \
      'check rules /etc/prometheus/rules/rgs-alerts.yml'
    do
      # 参数由上面的固定字面量产生，不接受 bundle 或环境注入附加 promtool 选项。
      # shellcheck disable=SC2086
      docker run --rm --pull never --network none --read-only \
        --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
        --mount "type=bind,src=$rendered_dir,dst=/etc/prometheus,readonly" \
        --entrypoint /bin/promtool "$prometheus_image" $promtool_check >/dev/null ||
        fail "fixed-source promtool rejected rendered bundle ($promtool_check)"
    done

    # 同一发布还必须由已评审并预载的 Vector 镜像解析真实 topology。这里禁用环境探测和
    # 网络，仅验证该固定版本认识所有 source/transform/sink 选项与缓冲约束。
    vector_image=$(printenv VECTOR_IMAGE 2>/dev/null || true)
    docker image inspect "$vector_image" >/dev/null 2>&1 ||
      fail 'VECTOR_IMAGE must be preloaded; release validation never pulls it'
    docker run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
      --env VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true \
      --env RGS_CONTAINER_LOG_GLOB=/var/log/containers/rgs-server-release-contract.log \
      --env RGS_LOG_SINK_URI="$log_sink_uri" \
      --mount "type=bind,src=$vector_file,dst=/etc/vector/vector.yaml,readonly" \
      "$vector_image" validate --no-environment /etc/vector/vector.yaml >/dev/null ||
      fail 'fixed-source Vector rejected the checked-in log topology'
  fi
  printf '%s\n' 'observability rendered release contract: ok'
fi

printf '%s\n' 'observability contract: ok'
