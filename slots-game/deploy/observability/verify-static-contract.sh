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
contract_file="$script_dir/verify-static-contract.sh"

compose_file="$script_dir/compose.yml"
prometheus_file="$script_dir/prometheus.yml"
rules_file="$script_dir/rules/rgs-alerts.yml"
datasource_file="$script_dir/grafana/provisioning/datasources/prometheus.yml"
provider_file="$script_dir/grafana/provisioning/dashboards/rgs.yml"
dashboard_file="$script_dir/grafana/dashboards/rgs-overview.json"
vector_file="$script_dir/vector.yaml"
local_vector_file="$repository_root/deploy/local-production/vector.yaml"
metrics_source="$repository_root/server/internal/platform/metrics.go"
retention_file="$script_dir/retention-policy.example.yml"
readme_file="$script_dir/README.md"
runtime_smoke_file="$script_dir/ci-runtime-smoke.sh"
production_smoke_file="$script_dir/ci-runtime-production-smoke.sh"
rendered_test_file="$script_dir/test-rendered-contract.sh"
bounded_flush_test_file="$script_dir/test-vector-bounded-flush.sh"

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
  "$local_vector_file" \
  "$metrics_source" \
  "$retention_file" \
  "$readme_file" \
  "$runtime_smoke_file" \
  "$production_smoke_file" \
  "$contract_file" \
  "$rendered_test_file" \
  "$bounded_flush_test_file"
do
  require_file "$required_file"
done

test -x "$bounded_flush_test_file" || fail 'bounded Vector flush behavior gate must be executable'
sh -n "$bounded_flush_test_file" || fail 'bounded Vector flush behavior gate is not valid POSIX shell'

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
  "$provider_file" "$vector_file" "$local_vector_file" "$retention_file" || fail 'YAML parsing failed'
ruby -rdigest -e '
  expected = {
    ARGV.fetch(0) => "15d52a08e40e6562206f5b6de35bf2020e42dc616eb1b30f758b4a9396524fb3",
    ARGV.fetch(1) => "dc3f3f51f26dfc1b12a3cad54c998b29cb35114d6c8bb972331e7b3415442fed"
  }
  expected.each do |path, digest|
    abort "reviewed Vector configuration digest drifted: #{path}" unless
      Digest::SHA256.file(path).hexdigest == digest
  end
' "$vector_file" "$local_vector_file" || fail 'reviewed Vector configuration digest contract failed'
# shellcheck disable=SC2016
ruby -e '
  require "yaml"
  compose = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  services = compose.fetch("services")
  abort "Vector must join only observability and restricted log-egress networks" unless
    services.dig("vector", "networks") == ["observability", "log-egress"]
  abort "Vector must not publish inbound ports" if services.dig("vector", "ports")
  abort "Prometheus must join only observability, private RGS operations and restricted alert egress networks" unless
    services.dig("prometheus", "networks") == ["observability", "rgs-operations", "alert-egress"]
  abort "Prometheus secret mount set drifted" unless services.dig("prometheus", "secrets") == [
    "rgs_operations_bearer_token",
    "alertmanager_bearer_token",
    {"source" => "alertmanager_root_ca", "target" => "alertmanager_root_ca.pem"}
  ]
  abort "Alertmanager root CA host binding drifted" unless
    compose.dig("secrets", "alertmanager_root_ca", "file") ==
      "${ALERTMANAGER_ROOT_CA_FILE:?set the approved Alertmanager root CA file}"
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

# 受审中央规则与仪表盘不能把“当前源码自身”当成唯一真相，否则同一提交同时弱化源码与
# rendered 产物会自洽假绿。合法语义变更必须显式更新这里的 reviewed SHA-256 并接受审查。
reviewed_rules_sha256='d6c5b1f520f33f67874116dcf19e90a3fec9753b7be11a6845a170df0a63e06d'
reviewed_dashboard_sha256='b230076b68669cd14ca013c82981a50b1e0c615688078e8a6379f34f262c8f13'
ruby -rdigest -e '
  ARGV.each_slice(2) do |path, expected|
    actual = Digest::SHA256.file(path).hexdigest
    abort "reviewed semantic source digest drifted for #{path}" unless actual == expected
  end
' "$rules_file" "$reviewed_rules_sha256" "$dashboard_file" "$reviewed_dashboard_sha256" ||
  fail 'reviewed Prometheus rules/dashboard source digest contract failed'

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
require_line '        ca_file: /run/secrets/alertmanager_root_ca.pem' "$prometheus_file"
require_line '        server_name: "__ALERTMANAGER_SERVER_NAME__"' "$prometheus_file"
require_line '        min_version: TLS12' "$prometheus_file"
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
  rgs_auth_replays_total \
  rgs_rate_limited_total \
  rgs_capacity_rejected_total \
  rgs_new_intent_capacity_rejected_total \
  rgs_shared_admission_errors_total \
  rgs_economic_admission_ready \
  rgs_economic_admission_last_success_age_seconds \
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
  RGSAuthenticationFailuresBurst \
  RGSAuthenticationReplayDetected \
  RGSRateLimitingSustained \
  RGSSharedAdmissionErrors \
  RGSEconomicAdmissionLimitedSustained \
  RGSEconomicAdmissionErrors \
  RGSEconomicAdmissionUnavailable \
  RGSEconomicAdmissionObservationStale \
  RGSCapacityRejectionsSustained \
  RGSNewIntentCapacityRejected \
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
require_fixed 'rgs_economic_admission_ready{job="rgs"} == 0' "$rules_file"
require_fixed 'unless on (job, instance)' "$rules_file"
require_fixed 'rgs_economic_admission_last_success_age_seconds{job="rgs"} > 900' "$rules_file"
require_fixed 'rgs_economic_admission_last_success_age_seconds{job="rgs"} < 0' "$rules_file"
require_fixed 'increase(rgs_capacity_rejected_total[5m])' "$rules_file"
require_fixed 'sum by (job, environment) (increase(rgs_security_logs_dropped_total[5m])) > 0' "$rules_file"
require_fixed '{"rgs_security_logs_dropped_total",' "$metrics_source"
require_fixed 'rgs_economic_admission_ready' "$metrics_source"
require_fixed 'rgs_economic_admission_last_success_timestamp_seconds' "$metrics_source"
require_fixed 'rgs_economic_admission_last_success_age_seconds' "$metrics_source"
require_fixed 'rgs_http_active_connections / clamp_min(rgs_http_connection_limit, 1)' "$rules_file"
require_fixed '214748390' "$rules_file"
require_fixed 'uid: rgs-prometheus' "$datasource_file"
require_fixed 'editable: false' "$datasource_file"
require_fixed 'allowUiUpdates: false' "$provider_file"
require_fixed '"uid": "rgs-release-overview"' "$dashboard_file"
require_fixed 'rgs_ready{job=\"rgs\"}' "$dashboard_file"
require_fixed 'rgs_capacity_rejected_total' "$dashboard_file"
require_fixed 'rgs_new_intent_capacity_rejected_total' "$dashboard_file"
require_fixed 'rgs_auth_replays_total' "$dashboard_file"
require_fixed 'rgs_shared_admission_errors_total' "$dashboard_file"
require_fixed 'rgs_economic_admission_ready{job=\"rgs\"}' "$dashboard_file"
require_fixed 'rgs_economic_admission_last_success_timestamp_seconds{job=\"rgs\"}' "$dashboard_file"
require_fixed 'rgs_economic_admission_last_success_age_seconds{job=\"rgs\"}' "$dashboard_file"
require_fixed 'rgs:http_connection_utilization:ratio' "$dashboard_file"

if grep -Ei '(operator|player|session|round|request|transaction)_id[[:space:]]*(=|=~)' \
  "$rules_file" "$dashboard_file" >/dev/null; then
  fail 'PromQL must not select or aggregate on high-cardinality business identifiers'
fi

# 日志最小化、出口失败即拒绝与磁盘缓冲上限。
require_fixed 'type: file' "$vector_file"
require_line '    read_from: beginning' "$vector_file"
require_line '    ignore_older_secs: 86400' "$vector_file"
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
for checked_vector_file in "$vector_file" "$local_vector_file"; do
  require_fixed '.message = "unparseable-log-redacted"' "$checked_vector_file"
  if grep -F '.message = raw' "$checked_vector_file" >/dev/null; then
    fail "unparseable log lines must not be forwarded verbatim by ${checked_vector_file#"$repository_root/"}"
  fi
  require_fixed 'event = .' "$checked_vector_file"
  require_fixed '. = { "service": "rgs-server" }' "$checked_vector_file"
  test "$(grep -F -c '. = { "service": "rgs-server" }' "$checked_vector_file")" -eq 2 ||
    fail "${checked_vector_file#"$repository_root/"} must rebuild the log event before and after scalar validation"
  require_fixed '.msg = "unknown-structured-log-redacted"' "$checked_vector_file"
  require_fixed 'sanitized = .' "$checked_vector_file"
  for route in \
    operator.launch \
    operator.round_status \
    operator.risk_decision \
    client.session_exchange \
    client.session_refresh \
    client.session_status \
    client.spin \
    client.round_status \
    client.pending_result \
    client.result_ack
  do
    require_line "        \"$route\"," "$checked_vector_file"
  done
  require_line '        "other"' "$checked_vector_file"
  for message in \
    'rgs server stopped' \
    'public RGS listener started' \
    'operations RGS listener started' \
    'security credential cleanup failed' \
    'http request' \
    'http panic recovered' \
    '检测到认证随机数重放' \
    'outbox dispatch pass failed' \
    'outbox publication deferred' \
    'recovery backlog observation failed' \
    'round recovery pass failed'
  do
    require_fixed "\"$message\"" "$checked_vector_file"
  done
  for mapping_branch in \
    'if message == "http request" {' \
    'else if message == "http panic recovered" {' \
    'else if message == "public RGS listener started" {' \
    'else if message == "operations RGS listener started" {' \
    'else if message == "检测到认证随机数重放" {' \
    'else if message == "outbox dispatch pass failed" {' \
    'else if message == "outbox publication deferred" {'
  do
    require_fixed "$mapping_branch" "$checked_vector_file"
  done
  require_fixed "match(request_id, r'^sha256:[0-9a-f]{64}$')" "$checked_vector_file"
  require_fixed '"request_id":"sha256:295c30089dbcb988c0988e4ac2ababa72182e0cc2c81d9d6e5b426e98d7d48ee"' "$checked_vector_file"
  require_fixed "match(game_id, r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')" "$checked_vector_file"
  require_fixed "match(definition_version, r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')" "$checked_vector_file"
  require_fixed "match(definition_hash, r'^[0-9a-f]{64}$')" "$checked_vector_file"
  require_fixed 'nested-secret' "$checked_vector_file"
  require_fixed '"walletSessionId":"nested-wallet-secret"' "$checked_vector_file"
  require_fixed '"wallet_session_id":"nested-wallet-snake-secret"' "$checked_vector_file"
  require_fixed '"game_id":"private-player"' "$checked_vector_file"
  require_fixed '"route":"client.spin"' "$checked_vector_file"
  require_fixed 'assert_eq!(., {' "$checked_vector_file"
done
for central_test_name in \
  'nested secrets cannot cross the strict RGS allowlist' \
  'unknown structured messages cannot smuggle secrets through allowed field names' \
  'known security messages cannot borrow unrelated allowed field names' \
  'approved RGS startup identity fields remain observable'
do
  require_fixed "name: $central_test_name" "$vector_file"
done
for local_test_name in \
  'Docker Fluent log shape preserves approved RGS request semantics only' \
  'nested secrets cannot cross the local strict RGS allowlist' \
  'unknown local structured messages cannot smuggle secrets through allowed field names' \
  'known local security messages cannot borrow unrelated allowed field names' \
  'approved local RGS startup identity fields remain observable'
do
  require_fixed "name: $local_test_name" "$local_vector_file"
done
ruby -ryaml -e '
  contracts = {
    ARGV.fetch(0) => "redact_rgs_sensitive_fields",
    ARGV.fetch(1) => "strict_rgs_allowlist"
  }
  mappings = [
    ["if message == \"http request\" {", %w[route request_id method status status_class duration_ms]],
    ["else if message == \"http panic recovered\" {", %w[request_id method duration_ms]],
    ["else if message == \"public RGS listener started\" {", %w[environment runtime_role game_id definition_version definition_hash operators outbox_delivery_enabled connection_limit]],
    ["else if message == \"operations RGS listener started\" {", %w[runtime_role outbox_delivery_enabled connection_limit]],
    ["else if includes([", %w[error_class]],
    ["else if message == \"检测到认证随机数重放\" {", %w[security_event]],
    ["else if message == \"outbox dispatch pass failed\" {", %w[claimed published failed lease_lost error_class]],
    ["else if message == \"outbox publication deferred\" {", %w[claimed published failed]]
  ]
  contracts.each do |path, transform_name|
    document = YAML.safe_load(File.read(path), aliases: false)
    source = document.fetch("transforms").fetch(transform_name).fetch("source")
    mappings.each_with_index do |(marker, expected), index|
      start_at = source.index(marker)
      abort "#{path}: missing mapping #{marker}" unless start_at
      next_marker = mappings[index + 1]&.first
      end_at = next_marker ? source.index(next_marker, start_at + marker.length) : source.length
      abort "#{path}: mapping order drifted at #{marker}" unless end_at
      actual = source[start_at...end_at].scan(/sanitized\.([a-z_]+)/).flatten.uniq
      abort "#{path}: #{marker} fields #{actual.inspect} != #{expected.inspect}" unless actual == expected
    end
  end
' "$vector_file" "$local_vector_file" || fail 'per-message Vector field mapping contract failed'
# shellcheck disable=SC2016
ruby -ryaml -e '
  def exact_keys!(value, expected, label)
    abort "#{label} keys drifted: #{value.keys.sort.inspect}" unless value.is_a?(Hash) && value.keys.sort == expected.sort
  end

  def exact_components!(document, expected, label)
    actual = document.fetch(label)
    abort "#{label} component set drifted: #{actual.keys.sort.inspect}" unless actual.keys.sort == expected.keys.sort
    expected.each do |name, contract|
      component = actual.fetch(name)
      abort "#{label}.#{name} type drifted" unless component.fetch("type") == contract.fetch(:type)
      if contract.key?(:inputs)
        abort "#{label}.#{name} inputs drifted" unless component.fetch("inputs") == contract.fetch(:inputs)
      else
        abort "#{label}.#{name} unexpectedly has inputs" if component.key?("inputs")
      end
    end
  end

  def exact_consumers!(document, expected)
    consumers = Hash.new { |hash, key| hash[key] = [] }
    document.fetch("transforms").merge(document.fetch("sinks")).each do |consumer, component|
      Array(component["inputs"]).each { |input| consumers[input] << consumer }
    end
    actual = consumers.transform_values(&:sort)
    normalized_expected = expected.transform_values(&:sort)
    abort "Vector consumer graph drifted: #{actual.inspect}" unless actual == normalized_expected
  end

  central = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  local = YAML.safe_load(File.read(ARGV.fetch(1)), aliases: false)
  exact_keys!(central, %w[data_dir sources transforms sinks tests], "central topology")
  exact_keys!(local, %w[data_dir secret sources transforms sinks tests], "local topology")
  abort "central data_dir drifted" unless central.fetch("data_dir") == "/var/lib/vector"
  abort "local data_dir drifted" unless local.fetch("data_dir") == "/var/lib/vector"

  exact_components!(central, {
    "rgs_container_stdout" => {type: "file"},
    "vector_internal_metrics" => {type: "internal_metrics"},
    "archive_flush_heartbeat_metric" => {type: "static_metrics"}
  }, "sources")
  exact_components!(central, {
    "archive_flush_heartbeat_to_log" => {
      type: "metric_to_log", inputs: ["archive_flush_heartbeat_metric"]
    },
    "safe_archive_flush_heartbeat" => {
      type: "remap", inputs: ["archive_flush_heartbeat_to_log"]
    },
    "normalize_rgs_json" => {type: "remap", inputs: ["rgs_container_stdout"]},
    "redact_rgs_sensitive_fields" => {type: "remap", inputs: ["normalize_rgs_json"]}
  }, "transforms")
  exact_components!(central, {
    "approved_https_archive" => {
      type: "http", inputs: ["redact_rgs_sensitive_fields", "safe_archive_flush_heartbeat"]
    },
    "vector_internal_prometheus" => {type: "prometheus_exporter", inputs: ["vector_internal_metrics"]}
  }, "sinks")
  exact_consumers!(central, {
    "archive_flush_heartbeat_metric" => ["archive_flush_heartbeat_to_log"],
    "archive_flush_heartbeat_to_log" => ["safe_archive_flush_heartbeat"],
    "safe_archive_flush_heartbeat" => ["approved_https_archive"],
    "rgs_container_stdout" => ["normalize_rgs_json"],
    "normalize_rgs_json" => ["redact_rgs_sensitive_fields"],
    "redact_rgs_sensitive_fields" => ["approved_https_archive"],
    "vector_internal_metrics" => ["vector_internal_prometheus"]
  })
  central_source = central.fetch("sources").fetch("rgs_container_stdout")
  exact_keys!(central_source, %w[type include read_from ignore_older_secs internal_metrics], "central file source")
  abort "central file source glob drifted" unless central_source.fetch("include") == ["${RGS_CONTAINER_LOG_GLOB}"]
  abort "central file source start drifted" unless central_source.fetch("read_from") == "beginning"
  abort "central file source history bound drifted" unless central_source.fetch("ignore_older_secs") == 86_400
  abort "central file source metadata cardinality drifted" unless
    central_source.fetch("internal_metrics") == {"include_file_tag" => false}
  central_metrics = central.fetch("sources").fetch("vector_internal_metrics")
  abort "central internal metrics source drifted" unless central_metrics == {
    "type" => "internal_metrics",
    "namespace" => "vector",
    "scrape_interval_secs" => 15,
    "tags" => {"host_key" => ""}
  }
  expected_heartbeat = {
    "type" => "static_metrics",
    "interval_secs" => 10,
    "namespace" => "vector",
    "metrics" => [{
      "name" => "archive_flush_heartbeat",
      "kind" => "absolute",
      "tags" => {},
      "value" => {"gauge" => {"value" => 1}}
    }]
  }
  abort "central archive heartbeat source drifted" unless
    central.fetch("sources").fetch("archive_flush_heartbeat_metric") == expected_heartbeat
  expected_heartbeat_projection = <<~VRL.chomp
    # 无条件从空对象重建；上游指标名、标签、hostname 或未来新增字段都不能进入归档。
    . = {
      "service": "vector",
      "time": now(),
      "level": "INFO",
      "msg": "archive flush heartbeat"
    }
  VRL
  abort "central archive heartbeat projection drifted" unless
    central.fetch("transforms").fetch("safe_archive_flush_heartbeat").fetch("source") ==
      expected_heartbeat_projection
  central.fetch("transforms").each do |name, transform|
    expected_keys = transform.fetch("type") == "metric_to_log" ? %w[type inputs] : %w[type inputs source]
    exact_keys!(transform, expected_keys, "central transform #{name}")
  end
  central_sink = central.fetch("sinks").fetch("approved_https_archive")
  exact_keys!(central_sink, %w[type inputs uri method encoding framing batch buffer request tls], "central archive sink")
  abort "central archive sink URI drifted" unless central_sink.fetch("uri") == "${RGS_LOG_SINK_URI}"
  abort "central archive sink method drifted" unless central_sink.fetch("method") == "post"
  abort "central archive encoding drifted" unless central_sink.fetch("encoding") == {"codec" => "json"}
  abort "central archive framing drifted" unless central_sink.fetch("framing") == {"method" => "newline_delimited"}
  abort "central archive batch drifted" unless central_sink.fetch("batch") == {
    "max_bytes" => 1_048_576, "timeout_secs" => 5
  }
  abort "central archive buffer drifted" unless central_sink.fetch("buffer") == {
    "type" => "disk", "max_size" => 268_435_488, "when_full" => "block"
  }
  abort "central archive request drifted" unless central_sink.fetch("request") == {"timeout_secs" => 10}
  abort "central archive sink TLS drifted" unless central_sink.fetch("tls") == {
    "verify_certificate" => true, "verify_hostname" => true
  }
  abort "central metrics exporter drifted" unless
    central.fetch("sinks").fetch("vector_internal_prometheus") == {
      "type" => "prometheus_exporter",
      "inputs" => ["vector_internal_metrics"],
      "address" => "0.0.0.0:9598",
      "flush_period_secs" => 60
    }

  exact_components!(local, {
    "rgs_fluent" => {type: "fluent"},
    "vector_internal_metrics" => {type: "internal_metrics"},
    "archive_flush_heartbeat_metric" => {type: "static_metrics"}
  }, "sources")
  exact_components!(local, {
    "archive_flush_heartbeat_to_log" => {
      type: "metric_to_log", inputs: ["archive_flush_heartbeat_metric"]
    },
    "safe_archive_flush_heartbeat" => {
      type: "remap", inputs: ["archive_flush_heartbeat_to_log"]
    },
    "normalize_rgs_json" => {type: "remap", inputs: ["rgs_fluent"]},
    "strict_rgs_allowlist" => {type: "remap", inputs: ["normalize_rgs_json"]}
  }, "transforms")
  exact_components!(local, {
    "local_https_archive" => {
      type: "http", inputs: ["strict_rgs_allowlist", "safe_archive_flush_heartbeat"]
    },
    "vector_internal_prometheus" => {type: "prometheus_exporter", inputs: ["vector_internal_metrics"]}
  }, "sinks")
  exact_consumers!(local, {
    "archive_flush_heartbeat_metric" => ["archive_flush_heartbeat_to_log"],
    "archive_flush_heartbeat_to_log" => ["safe_archive_flush_heartbeat"],
    "safe_archive_flush_heartbeat" => ["local_https_archive"],
    "rgs_fluent" => ["normalize_rgs_json"],
    "normalize_rgs_json" => ["strict_rgs_allowlist"],
    "strict_rgs_allowlist" => ["local_https_archive"],
    "vector_internal_metrics" => ["vector_internal_prometheus"]
  })
  local_source = local.fetch("sources").fetch("rgs_fluent")
  abort "local Fluent source drifted" unless local_source == {
    "type" => "fluent", "address" => "0.0.0.0:24224"
  }
  abort "local secret backend drifted" unless local.fetch("secret") == {
    "local_files" => {
      "type" => "directory",
      "path" => "/run/vector-secrets",
      "remove_trailing_whitespace" => true
    }
  }
  local_metrics = local.fetch("sources").fetch("vector_internal_metrics")
  abort "local internal metrics source drifted" unless local_metrics == {
    "type" => "internal_metrics",
    "namespace" => "vector",
    "scrape_interval_secs" => 15,
    "tags" => {"host_key" => ""}
  }
  abort "local archive heartbeat source drifted" unless
    local.fetch("sources").fetch("archive_flush_heartbeat_metric") == expected_heartbeat
  abort "local archive heartbeat projection drifted" unless
    local.fetch("transforms").fetch("safe_archive_flush_heartbeat").fetch("source") ==
      expected_heartbeat_projection
  local.fetch("transforms").each do |name, transform|
    expected_keys = transform.fetch("type") == "metric_to_log" ? %w[type inputs] : %w[type inputs source]
    exact_keys!(transform, expected_keys, "local transform #{name}")
  end
  local_sink = local.fetch("sinks").fetch("local_https_archive")
  exact_keys!(local_sink, %w[type inputs uri method auth encoding framing batch buffer request tls], "local archive sink")
  abort "local archive sink URI drifted" unless local_sink.fetch("uri") == "https://wallet:8443/logs"
  abort "local archive sink method drifted" unless local_sink.fetch("method") == "post"
  abort "local archive sink auth drifted" unless local_sink.fetch("auth") == {
    "strategy" => "bearer",
    "token" => "SECRET[local_files.local-operator-log-bearer.token]"
  }
  abort "local archive encoding drifted" unless local_sink.fetch("encoding") == {"codec" => "json"}
  abort "local archive framing drifted" unless local_sink.fetch("framing") == {"method" => "newline_delimited"}
  abort "local archive batch drifted" unless local_sink.fetch("batch") == {
    "max_bytes" => 1_048_576, "timeout_secs" => 5
  }
  abort "local archive buffer drifted" unless local_sink.fetch("buffer") == {
    "type" => "disk", "max_size" => 268_435_488, "when_full" => "block"
  }
  abort "local archive request drifted" unless local_sink.fetch("request") == {"timeout_secs" => 10}
  abort "local archive sink TLS drifted" unless local_sink.fetch("tls") == {
    "ca_file" => "/run/vector-secrets/local-production-root-ca.pem",
    "verify_certificate" => true,
    "verify_hostname" => true
  }
  abort "local metrics exporter drifted" unless
    local.fetch("sinks").fetch("vector_internal_prometheus") == {
      "type" => "prometheus_exporter",
      "inputs" => ["vector_internal_metrics"],
      "address" => "0.0.0.0:9598",
      "flush_period_secs" => 60
    }

  local_normalizer = local.fetch("transforms").fetch("normalize_rgs_json").fetch("source")
  abort "local Fluent payload branch drifted" unless
    local_normalizer.include?(%q{raw = string(.log) ?? string(.message) ?? ""}) &&
    local_normalizer.include?("if length(raw) <= 65536 {") &&
    local_normalizer.include?("del(.log)")
  fluent_test = local.fetch("tests").find do |test|
    test["name"] == "Docker Fluent log shape preserves approved RGS request semantics only"
  end
  abort "missing Docker Fluent shape test" unless fluent_test
  log_fields = fluent_test.fetch("inputs").fetch(0).fetch("log_fields")
  abort "Docker Fluent shape fields drifted" unless
    log_fields.keys.sort == %w[container_id container_name log source] &&
    log_fields.fetch("log").include?(%q{"msg":"http request"}) &&
    log_fields.fetch("log").include?(%q{"route":"operator.launch"})
' "$vector_file" "$local_vector_file" || fail 'Vector topology/TLS/Fluent boundary contract failed'
require_line '      - redact_rgs_sensitive_fields' "$vector_file"
require_line '      - safe_archive_flush_heartbeat' "$vector_file"
require_fixed 'inputs: [strict_rgs_allowlist, safe_archive_flush_heartbeat]' "$local_vector_file"
require_fixed 'extract_from: redact_rgs_sensitive_fields' "$vector_file"
require_fixed 'extract_from: strict_rgs_allowlist' "$local_vector_file"
require_fixed 'archive flush heartbeat is rebuilt as a fixed four-field safe log' "$vector_file"
require_fixed 'local archive flush heartbeat is rebuilt as a fixed four-field safe log' "$local_vector_file"
if grep -Ei '(authorization:[[:space:]]*"?bearer|bearer_token:[[:space:]]+[^[:space:]#]|token=|password=)' "$vector_file" "$compose_file" "$prometheus_file" >/dev/null; then
  fail 'observability config must not embed credentials'
fi

# 临时 bundle 与 production-config smoke 必须保留失败闭合和“非发布证据”边界。
# shellcheck disable=SC2016
require_fixed '--rendered-static-dir "$good_bundle"' "$rendered_test_file"
require_fixed 'insecure local-operator TLS was accepted' "$rendered_test_file"
require_fixed 'missing local-operator critical alert was accepted' "$rendered_test_file"
require_fixed 'disabled local-operator alert expression was accepted' "$rendered_test_file"
require_fixed 'missing local-operator dashboard signal was accepted' "$rendered_test_file"
require_fixed 'forced-healthy local dashboard query was accepted' "$rendered_test_file"
require_fixed 'disabled central alert expression was accepted' "$rendered_test_file"
require_fixed 'remote_write egress was accepted' "$rendered_test_file"
require_fixed 'remote_read ingress was accepted' "$rendered_test_file"
require_fixed 'extra scrape job was accepted' "$rendered_test_file"
require_fixed 'second RGS scrape target was accepted' "$rendered_test_file"
require_fixed 'RGS address relabel egress was accepted' "$rendered_test_file"
require_fixed 'RGS scrape proxy egress was accepted' "$rendered_test_file"
require_fixed 'second Alertmanager target was accepted' "$rendered_test_file"
require_fixed 'disabled Alertmanager TLS verification was accepted' "$rendered_test_file"
require_fixed 'Alertmanager CA secret path drift was accepted' "$rendered_test_file"
require_fixed 'missing RGS scrape was accepted' "$rendered_test_file"
require_fixed 'missing Vector scrape was accepted' "$rendered_test_file"
require_fixed 'missing required authentication replay alert was accepted' "$rendered_test_file"
require_fixed 'missing required authentication replay dashboard signal was accepted' "$rendered_test_file"
require_fixed 'structurally invalid rule was accepted' "$rendered_test_file"
require_fixed 'release gate accepted an untrusted promtool source' "$rendered_test_file"
require_fixed 'complete source-control fixture was rejected before mutation' "$rendered_test_file"
require_fixed 'weakened reviewed source alert expression was accepted' "$rendered_test_file"
require_fixed 'Vector startup log position drift was accepted' "$rendered_test_file"
require_fixed 'development runtime smoke without private umask was accepted' "$rendered_test_file"
require_fixed 'incompatible PostgreSQL TLS algorithm was accepted' "$rendered_test_file"
require_fixed 'incomplete Valkey Lua command probe was accepted' "$rendered_test_file"
require_fixed 'false Valkey Lua artifact result was accepted' "$rendered_test_file"
require_fixed 'stale Valkey Lua digest was accepted' "$rendered_test_file"
require_fixed 'missing central strict log allowlist was accepted' "$rendered_test_file"
require_fixed 'missing local strict log allowlist was accepted' "$rendered_test_file"
require_fixed 'missing nested-secret Vector fixture was accepted' "$rendered_test_file"
require_fixed 'RGS route enum drift was accepted' "$rendered_test_file"
require_fixed 'RGS per-message field mapping drift was accepted' "$rendered_test_file"
require_fixed 'RGS startup Vector fixture drift was accepted' "$rendered_test_file"
require_fixed 'raw request-id allowlist drift was accepted' "$rendered_test_file"
require_fixed 'missing central release Vector test was accepted' "$rendered_test_file"
require_fixed 'missing local release Vector test was accepted' "$rendered_test_file"
require_fixed 'local Vector TLS verification drift was accepted' "$rendered_test_file"
require_fixed 'local Vector CA path drift was accepted' "$rendered_test_file"
require_fixed 'local Vector archive URI drift was accepted' "$rendered_test_file"
require_fixed 'local Vector archive input drift was accepted' "$rendered_test_file"
require_fixed 'central Vector bypass sink was accepted' "$rendered_test_file"
require_fixed 'local Vector bypass sink was accepted' "$rendered_test_file"
require_fixed 'central Vector TLS verification drift was accepted' "$rendered_test_file"
require_fixed 'central Vector archive URI drift was accepted' "$rendered_test_file"
require_fixed 'local Fluent source drift was accepted' "$rendered_test_file"
require_fixed 'local Fluent payload branch drift was accepted' "$rendered_test_file"
require_fixed 'missing Docker Fluent shape test was accepted' "$rendered_test_file"
require_fixed 'broad release container log glob was accepted' "$rendered_test_file"
require_fixed 'broad release glob did not reach the dedicated fail-closed policy' "$rendered_test_file"
require_fixed 'central Vector exclude-all source was accepted' "$rendered_test_file"
require_fixed 'local Vector drop-newest buffer was accepted' "$rendered_test_file"
require_fixed 'central Vector non-JSON encoding was accepted' "$rendered_test_file"
require_fixed 'local Vector internal-metrics host tag was accepted' "$rendered_test_file"
require_fixed 'missing local release Vector validation was accepted' "$rendered_test_file"
require_fixed 'Alertmanager root CA Compose mount drift was accepted' "$rendered_test_file"
require_fixed 'Alertmanager root CA host source drift was accepted' "$rendered_test_file"
require_fixed 'missing local-operator promtool credential mount was accepted' "$rendered_test_file"
require_fixed 'missing release Alertmanager CA promtool mount was accepted' "$rendered_test_file"
require_fixed 'conditional Vector field leak was accepted' "$rendered_test_file"
require_fixed 'missing central archive heartbeat was accepted' "$rendered_test_file"
require_fixed 'unsafe central archive heartbeat projection was accepted' "$rendered_test_file"
require_fixed 'missing local archive heartbeat input was accepted' "$rendered_test_file"

# 行为门禁必须保留“唯一业务事件 + 实际心跳 + 同一磁盘缓冲”的固定低敏边界。
require_fixed "expected_vector_image='timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39'" "$bounded_flush_test_file"
require_fixed "source_name = 'archive_flush_heartbeat_metric'" "$bounded_flush_test_file"
require_fixed "'count' => 1" "$bounded_flush_test_file"
require_fixed "'type' => 'disk'" "$bounded_flush_test_file"
require_fixed "raise 'business probe count mismatch' unless probes.length == 1" "$bounded_flush_test_file"
require_fixed "raise 'raw metric escaped' if raw_metric" "$bounded_flush_test_file"
# 发布脚本中的变量引用必须按字面量计数，不能在本次静态检查中展开。
# shellcheck disable=SC2016
central_vector_test_marker='"$vector_image" test --dangerously-allow-env-var-interpolation'
test "$(grep -F -c -- "$central_vector_test_marker" "$contract_file")" -eq 2 ||
  fail 'release contract must execute the central Vector tests exactly once'
local_vector_test_marker='exec /usr/bin/vector test /etc/vector/vector.yaml'
test "$(grep -F -c -- "$local_vector_test_marker" "$contract_file")" -eq 2 ||
  fail 'release contract must execute the local Vector tests exactly once'
local_vector_validate_marker='exec /usr/bin/vector validate --no-environment /etc/vector/vector.yaml'
test "$(grep -F -c -- "$local_vector_validate_marker" "$contract_file")" -eq 2 ||
  fail 'release contract must validate the complete local Vector topology exactly once'
require_fixed 'release RGS container log glob contract failed' "$contract_file"
# shellcheck disable=SC2016
test "$(grep -E -c -- '^[[:space:]]{6}--env RGS_CONTAINER_LOG_GLOB="\$release_log_glob"[[:space:]]+\\$' "$contract_file")" -eq 2 ||
  fail 'release contract must forward the validated RGS log glob to both central Vector checks'
require_fixed 'dst=/run/secrets/rgs_operations_bearer_token,readonly' "$contract_file"
require_fixed 'dst=/run/secrets/alertmanager_bearer_token,readonly' "$contract_file"
require_line "        --mount type=bind,src=/dev/null,dst=/run/secrets/local_operator_metrics_bearer_token,readonly \\" "$contract_file"
require_line "        --mount \"type=bind,src=\$alertmanager_root_ca_source,dst=/run/secrets/alertmanager_root_ca.pem,readonly\" \\" "$contract_file"
require_line "      fail 'fixed-source OpenSSL rejected the supplied Alertmanager root CA'" "$contract_file"
require_fixed '--tmpfs /run/vector-secrets:rw,nosuid,nodev,noexec,mode=1777,size=1m' "$contract_file"
for documented_release_input in \
  'export RGS_OPERATIONS_TARGET=' \
  'export ALERTMANAGER_TARGET=' \
  'export ALERTMANAGER_ROOT_CA_FILE=' \
  'export ALERTMANAGER_CA_FILE=' \
  'export ALERTMANAGER_SERVER_NAME=' \
  'export PROMETHEUS_RENDER_PROFILE=' \
  'export RGS_CONTAINER_LOG_GLOB='
do
  require_fixed "$documented_release_input" "$readme_file"
done
# shellcheck disable=SC2016
require_fixed '`insecure_skip_verify: false`' "$readme_file"
# shellcheck disable=SC2016
require_fixed '`min_version: TLS12`' "$readme_file"
require_fixed '中央归档五组和 local-production 六组' "$readme_file"
require_fixed 'RGS_CI_RUNTIME_FIXTURE_PROFILE=development' "$runtime_smoke_file"
require_fixed 'RGS_CI_RUNTIME_FIXTURE_PROFILE=production' "$production_smoke_file"
require_line 'umask 077' "$runtime_smoke_file"
require_line 'umask 077' "$production_smoke_file"
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
require_fixed "valkey_image='valkey/valkey:8.1-alpine@sha256:e0eb7c480958d32bdc4357a74bdd70653ae15f2f9b4c93c4a5a9fad1dc471c84'" "$production_smoke_file"
require_fixed 'valkey-server-key.pem' "$production_smoke_file"
require_fixed 'valkey_certificate_key_digest' "$production_smoke_file"
require_fixed 'maxmemory-policy noeviction' "$production_smoke_file"
require_fixed 'user default off' "$production_smoke_file"
require_fixed '+evalsha +eval +get +pttl +set +time +mset +pexpire +ping +hello +auth +client|setname +client|setinfo' "$production_smoke_file"
require_fixed "shared_admission_lua_probe_key_a='rgs:shared-admission:v2:{ci-only-acl-lua}:state-a'" "$production_smoke_file"
require_fixed "shared_admission_lua_probe_key_b='rgs:shared-admission:v2:{ci-only-acl-lua}:state-b'" "$production_smoke_file"
require_fixed "redis.call('TIME')" "$production_smoke_file"
require_fixed "redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl_ms)" "$production_smoke_file"
require_fixed "redis.call('GET', KEYS[1])" "$production_smoke_file"
require_fixed "redis.call('PTTL', KEYS[1])" "$production_smoke_file"
require_fixed "redis.call('MSET', KEYS[1], ARGV[2], KEYS[2], ARGV[3])" "$production_smoke_file"
require_fixed "redis.call('PEXPIRE', KEYS[1], ttl_ms)" "$production_smoke_file"
require_fixed "redis.call('PEXPIRE', KEYS[2], ttl_ms)" "$production_smoke_file"
require_fixed "shared_admission_lua_probe_sha='ff334ac492bc06b8421d59494098b485d59dd00d'" "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'EVAL "$shared_admission_lua_probe" 2' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'if ! shared_admission_lua_eval_result="$(' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'EVALSHA "$shared_admission_lua_probe_sha" 2' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'if ! shared_admission_lua_evalsha_result="$(' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'docker exec -e REDISCLI_AUTH="$valkey_password"' "$production_smoke_file"
if grep -F 'VALKEYCLI_AUTH' "$production_smoke_file" >/dev/null; then
  fail 'Valkey CLI probes must use supported REDISCLI_AUTH authentication'
fi
if grep -E -- '--(host|port)[[:space:]]' "$production_smoke_file" >/dev/null; then
  fail 'Valkey CLI probes must use the supported -h/-p endpoint options'
fi
require_fixed 'shared_admission_tls_acl_and_lua=true' "$production_smoke_file"
require_fixed '"sharedAdmissionTLSACLAndLua": True' "$production_smoke_file"
require_fixed '"sharedAdmissionTLSACLAndLua":true' "$production_smoke_file"
require_fixed 'CI-only Valkey Lua probe key was not cleaned by TTL' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'if ! shared_admission_lua_probe_residue="$(' "$production_smoke_file"
require_fixed 'RGS_SHARED_ADMISSION_URL=rediss://127.0.0.1:18445' "$production_smoke_file"
require_fixed 'RGS_SHARED_ADMISSION_PASSWORD_FILE=/run/rgs-production-smoke/valkey-password' "$production_smoke_file"
require_fixed 'RGS_SHARED_ADMISSION_HMAC_KEY_FILE=/run/rgs-production-smoke/admission-hmac.key' "$production_smoke_file"
require_fixed 'RGS_SHARED_ADMISSION_ROOT_CA_FILE=/run/rgs-production-smoke/postgres-root-ca.pem' "$production_smoke_file"
require_fixed 'TLS/ACL Valkey did not become ready' "$production_smoke_file"
if grep -F 'channel_binding=disable' "$production_smoke_file" >/dev/null; then
  fail 'production smoke must not disable PostgreSQL channel binding'
fi
require_fixed 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' "$production_smoke_file"
require_fixed 'PostgreSQL verify-full TLS barrier timed out' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'docker logs --tail 80 "$RGS_RUNTIME_SMOKE_POSTGRES_CONTAINER"' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'verify_safe_startup_failure "$missing_token_log"' "$production_smoke_file"
# shellcheck disable=SC2016
require_fixed 'verify_safe_startup_failure "$v1_log"' "$production_smoke_file"
require_fixed 'allowed_keys = {"time", "level", "msg", "error_class"}' "$production_smoke_file"
require_fixed 'safe-startup-envelope.raw.log' "$production_smoke_file"
require_fixed 'unique safe startup failure envelope' "$production_smoke_file"
if grep -F "grep -F 'RGS_OPERATIONS_BEARER_TOKEN_FILE is required in production'" \
  "$production_smoke_file" >/dev/null || \
  grep -F "grep -F 'production requires rgs-definition-approval-v2'" \
    "$production_smoke_file" >/dev/null; then
  fail 'production smoke must not restore raw startup errors for negative gates'
fi
require_fixed '"name":"outbox_delivery","ok":true' "$production_smoke_file"
require_fixed "grep -F -x 'rgs_ready 1'" "$production_smoke_file"
require_fixed 'openssl s_server -accept 18443' "$production_smoke_file"
require_fixed 'runtime-startup-failure.raw.log' "$runtime_smoke_file"
require_fixed 'runtime-startup-failure.raw.log' "$production_smoke_file"
require_fixed 'runtime.raw.log' "$runtime_smoke_file"
require_fixed 'runtime-production-ci-only.raw.log' "$production_smoke_file"
require_fixed 'valkey-production-ci-only.raw.log' "$production_smoke_file"
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
  ALERTMANAGER_ROOT_CA_FILE="$retention_file" \
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
  if [ "$rendered_mode" = 'release' ]; then
    approved_render_profile=$(printenv PROMETHEUS_RENDER_PROFILE 2>/dev/null || true)
    approved_rgs_target=$(printenv RGS_OPERATIONS_TARGET 2>/dev/null || true)
    approved_alertmanager_target=$(printenv ALERTMANAGER_TARGET 2>/dev/null || true)
    approved_alertmanager_ca_file=$(printenv ALERTMANAGER_CA_FILE 2>/dev/null || true)
    approved_alertmanager_server_name=$(printenv ALERTMANAGER_SERVER_NAME 2>/dev/null || true)
    case "$approved_render_profile" in
      central|local-production) ;;
      *) fail 'PROMETHEUS_RENDER_PROFILE must be central or local-production for rendered release validation' ;;
    esac
    test -n "$approved_rgs_target" || fail 'RGS_OPERATIONS_TARGET is required for rendered release validation'
    test -n "$approved_alertmanager_target" || fail 'ALERTMANAGER_TARGET is required for rendered release validation'
    test -n "$approved_alertmanager_ca_file" || fail 'ALERTMANAGER_CA_FILE is required for rendered release validation'
    test -n "$approved_alertmanager_server_name" || fail 'ALERTMANAGER_SERVER_NAME is required for rendered release validation'
  else
    approved_render_profile=$(printenv PROMETHEUS_RENDER_PROFILE 2>/dev/null || true)
    case "$approved_render_profile" in
      ''|central)
        approved_render_profile='central'
        approved_rgs_target='rgs-server:8081'
        approved_alertmanager_target='alertmanager.ci.invalid:443'
        approved_alertmanager_ca_file='/run/secrets/alertmanager_root_ca.pem'
        approved_alertmanager_server_name='alertmanager.ci.invalid'
        ;;
      local-production)
        approved_rgs_target=${RGS_OPERATIONS_TARGET:-rgs-server:8081}
        approved_alertmanager_target=${ALERTMANAGER_TARGET:-alert-proxy:8443}
        approved_alertmanager_ca_file=${ALERTMANAGER_CA_FILE:-/run/secrets/alertmanager_root_ca.pem}
        approved_alertmanager_server_name=${ALERTMANAGER_SERVER_NAME:-alert-proxy}
        ;;
      *) fail 'PROMETHEUS_RENDER_PROFILE must be central or local-production for rendered static validation' ;;
    esac
  fi
  ruby -e '
    require "yaml"
    require "json"
    require "uri"

    begin
    prometheus_path, rules_path, dashboard_path, source_rules_path, source_dashboard_path,
      approved_render_profile, approved_rgs_target, approved_alertmanager_target, approved_alertmanager_ca_file,
      approved_alertmanager_server_name = ARGV
    config = YAML.safe_load(
      File.read(prometheus_path), permitted_classes: [], permitted_symbols: [], aliases: false
    )
    rules_config = YAML.safe_load(
      File.read(rules_path), permitted_classes: [], permitted_symbols: [], aliases: false
    )
    dashboard = JSON.parse(File.read(dashboard_path))
    source_rules_text = File.read(source_rules_path)
    source_rules_config = YAML.safe_load(
      source_rules_text, permitted_classes: [], permitted_symbols: [], aliases: false
    )
    source_dashboard_text = File.read(source_dashboard_path)
    source_dashboard = JSON.parse(source_dashboard_text)
    abort "rendered Prometheus config must be an object" unless config.is_a?(Hash)
    abort "rendered rules config must be an object" unless rules_config.is_a?(Hash)
    abort "rendered dashboard must be an object" unless dashboard.is_a?(Hash)
    abort "source rules config must be an object" unless source_rules_config.is_a?(Hash)
    abort "source dashboard must be an object" unless source_dashboard.is_a?(Hash)

    nonempty = ->(value) { value.is_a?(String) && !value.empty? && value !~ /__[A-Z0-9_]+__/ }
    safe_label_value = lambda do |value|
      value.is_a?(String) && value.bytesize.between?(1, 64) &&
        /\A[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\z/.match?(value)
    end
    exact_object = lambda do |value, keys, label|
      abort "#{label} must be an object with exact keys #{keys.sort.join(",")}" unless
        value.is_a?(Hash) && value.keys.sort == keys.sort
      value
    end
    exact_static = lambda do |value, target, service, environment, label|
      abort "#{label} static_configs must contain exactly one object" unless
        value.is_a?(Array) && value.length == 1
      item = exact_object.call(value.first, %w[labels targets], "#{label} static config")
      abort "#{label} must contain exactly one controlled target" unless item["targets"] == [target]
      labels = exact_object.call(item["labels"], %w[environment service], "#{label} labels")
      abort "#{label} labels drifted" unless
        labels == { "service" => service, "environment" => environment }
      item
    end
    valid_host = lambda do |host|
      next false unless host.is_a?(String) && host.bytesize.between?(1, 253)
      labels = host.split(".", -1)
      !labels.empty? && labels.all? do |label|
        label.bytesize.between?(1, 63) &&
          /\A[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\z/.match?(label)
      end
    end
    parse_target = lambda do |target|
      next nil unless target.is_a?(String)
      match = /\A([^:]+):([0-9]{1,5})\z/.match(target)
      next nil unless match && valid_host.call(match[1])
      port = Integer(match[2], 10)
      next nil unless port.between?(1, 65_535)
      [match[1], port]
    rescue ArgumentError
      nil
    end
    safe_absolute_path = lambda do |path|
      next false unless path.is_a?(String) && path.start_with?("/") && path.bytesize <= 4096
      parts = path.split("/", -1).drop(1)
      !parts.empty? && parts.all? do |part|
        !part.empty? && part != "." && part != ".." && /\A[A-Za-z0-9._-]+\z/.match?(part)
      end
    end

    abort "approved RGS operations target is invalid" unless parse_target.call(approved_rgs_target)
    abort "approved Prometheus render profile is invalid" unless
      %w[central local-production].include?(approved_render_profile)
    approved_alert_target = parse_target.call(approved_alertmanager_target)
    abort "approved Alertmanager target is invalid" unless approved_alert_target
    abort "approved Alertmanager CA path is invalid" unless safe_absolute_path.call(approved_alertmanager_ca_file)
    abort "approved Alertmanager CA must use the fixed mounted secret path" unless
      approved_alertmanager_ca_file == "/run/secrets/alertmanager_root_ca.pem"
    abort "approved Alertmanager TLS server name is invalid" unless valid_host.call(approved_alertmanager_server_name)

    exact_object.call(config, %w[alerting global rule_files scrape_configs], "rendered Prometheus config")
    global = exact_object.call(
      config.fetch("global"),
      %w[evaluation_interval external_labels scrape_interval scrape_timeout],
      "rendered global config"
    )
    abort "rendered global timing policy drifted" unless
      global["scrape_interval"] == "15s" && global["scrape_timeout"] == "5s" &&
      global["evaluation_interval"] == "15s"
    labels = exact_object.call(global.fetch("external_labels"), %w[cluster environment], "rendered external labels")
    abort "rendered environment label is invalid" unless safe_label_value.call(labels["environment"])
    abort "rendered cluster label is invalid" unless safe_label_value.call(labels["cluster"])
    environment = labels.fetch("environment")
    if approved_render_profile == "local-production"
      abort "local-production external labels drifted" unless
        labels == { "environment" => "production", "cluster" => "local-mac" }
    end
    abort "rendered rule_files must load the controlled rule directory" unless
      config.fetch("rule_files") == ["/etc/prometheus/rules/*.yml"]

    scrape_configs = config.fetch("scrape_configs")
    expected_job_names = if approved_render_profile == "local-production"
      %w[local-operator prometheus rgs vector]
    else
      %w[prometheus rgs vector]
    end
    abort "rendered scrape_configs must contain exactly the controlled profile jobs" unless
      scrape_configs.is_a?(Array) && scrape_configs.length == expected_job_names.length
    jobs = scrape_configs.group_by { |job| job.is_a?(Hash) ? job["job_name"] : nil }
    abort "rendered scrape job set drifted from the approved profile" unless
      jobs.keys.sort == expected_job_names && jobs.values.all? { |entries| entries.length == 1 }

    self_job = exact_object.call(
      jobs.fetch("prometheus").first,
      %w[job_name metrics_path scheme static_configs],
      "Prometheus self-scrape"
    )
    abort "Prometheus self-scrape must remain HTTP /metrics" unless
      self_job["job_name"] == "prometheus" && self_job["scheme"] == "http" &&
      self_job["metrics_path"] == "/metrics"
    exact_static.call(
      self_job.fetch("static_configs"), "127.0.0.1:9090", "prometheus", environment,
      "Prometheus self-scrape"
    )

    rgs_job = exact_object.call(
      jobs.fetch("rgs").first,
      %w[authorization honor_labels job_name metrics_path scheme static_configs],
      "RGS scrape"
    )
    abort "RGS scrape must remain HTTP /metrics with honor_labels disabled" unless
      rgs_job["job_name"] == "rgs" && rgs_job["scheme"] == "http" && rgs_job["metrics_path"] == "/metrics" &&
      rgs_job["honor_labels"] == false
    authorization = exact_object.call(rgs_job.fetch("authorization"), %w[credentials_file type], "RGS authorization")
    abort "RGS scrape must use a Bearer secret file" unless authorization == {
      "type" => "Bearer",
      "credentials_file" => "/run/secrets/rgs_operations_bearer_token"
    }
    exact_static.call(rgs_job.fetch("static_configs"), approved_rgs_target, "rgs", environment, "RGS scrape")

    vector_job = exact_object.call(
      jobs.fetch("vector").first,
      %w[honor_labels job_name metrics_path scheme static_configs],
      "Vector scrape"
    )
    abort "Vector scrape must remain unauthenticated HTTP /metrics on the private network" unless
      vector_job["job_name"] == "vector" && vector_job["scheme"] == "http" &&
      vector_job["metrics_path"] == "/metrics" && vector_job["honor_labels"] == false
    exact_static.call(vector_job.fetch("static_configs"), "vector:9598", "vector", environment, "Vector scrape")

    if approved_render_profile == "local-production"
      operator_job = exact_object.call(
        jobs.fetch("local-operator").first,
        %w[authorization honor_labels job_name metrics_path scheme static_configs tls_config],
        "local-operator scrape"
      )
      abort "local-operator scrape must remain verified HTTPS /metrics" unless
        operator_job["job_name"] == "local-operator" && operator_job["scheme"] == "https" &&
        operator_job["metrics_path"] == "/metrics" && operator_job["honor_labels"] == false
      operator_authorization = exact_object.call(
        operator_job.fetch("authorization"), %w[credentials_file type], "local-operator authorization"
      )
      abort "local-operator scrape must use the dedicated Bearer secret file" unless
        operator_authorization == {
          "type" => "Bearer",
          "credentials_file" => "/run/secrets/local_operator_metrics_bearer_token"
        }
      operator_tls = exact_object.call(
        operator_job.fetch("tls_config"),
        %w[ca_file insecure_skip_verify min_version server_name],
        "local-operator TLS config"
      )
      abort "local-operator TLS verification drifted" unless operator_tls == {
        "ca_file" => "/run/secrets/local-production-root-ca.pem",
        "server_name" => "wallet",
        "min_version" => "TLS12",
        "insecure_skip_verify" => false
      }
      exact_static.call(
        operator_job.fetch("static_configs"), "wallet:8443", "local-operator", environment,
        "local-operator scrape"
      )
    end

    alerting = exact_object.call(config.fetch("alerting"), %w[alertmanagers], "rendered alerting config")
    managers = alerting.fetch("alertmanagers")
    abort "rendered config must contain exactly one controlled Alertmanager" unless
      managers.is_a?(Array) && managers.length == 1
    manager = exact_object.call(
      managers.first,
      %w[authorization scheme static_configs tls_config],
      "rendered Alertmanager"
    )
    abort "Alertmanager scheme must be HTTPS" unless manager["scheme"] == "https"
    manager_authorization = exact_object.call(
      manager.fetch("authorization"), %w[credentials_file type], "Alertmanager authorization"
    )
    abort "Alertmanager authorization must use a Bearer secret file" unless
      manager_authorization == {
        "type" => "Bearer",
        "credentials_file" => "/run/secrets/alertmanager_bearer_token"
      }
    manager_static = manager.fetch("static_configs")
    abort "Alertmanager static_configs must contain exactly one object" unless
      manager_static.is_a?(Array) && manager_static.length == 1
    manager_static_item = exact_object.call(manager_static.first, %w[targets], "Alertmanager static config")
    targets = manager_static_item.fetch("targets")
    abort "Alertmanager must contain exactly one target" unless targets.is_a?(Array) && targets.length == 1
    tls = exact_object.call(
      manager.fetch("tls_config"),
      %w[ca_file insecure_skip_verify min_version server_name],
      "Alertmanager TLS config"
    )
    abort "Alertmanager TLS CA/server name/minimum version/certificate verification drifted" unless
      tls["ca_file"] == approved_alertmanager_ca_file &&
      tls["server_name"] == approved_alertmanager_server_name && tls["min_version"] == "TLS12" &&
      tls["insecure_skip_verify"] == false
    abort "Alertmanager target drifted from the approved verified endpoint" unless
      targets == [approved_alertmanager_target]

    groups = rules_config.fetch("groups")
    abort "rendered rules must contain non-empty groups" unless groups.is_a?(Array) && !groups.empty?
    source_groups = source_rules_config.fetch("groups")
    abort "source rules must contain non-empty groups" unless source_groups.is_a?(Array) && !source_groups.empty?
    source_anchor = source_groups.flat_map { |group| group.fetch("rules") }.find do |rule|
      rule["alert"].is_a?(String) &&
        rule.dig("annotations", "runbook_url").to_s.start_with?("__RUNBOOK_BASE_URL__/")
    end
    abort "source rules are missing the controlled runbook placeholder" unless source_anchor
    source_runbook = source_anchor.dig("annotations", "runbook_url")
    runbook_suffix = source_runbook.delete_prefix("__RUNBOOK_BASE_URL__")
    rendered_anchor = groups.flat_map { |group| group.fetch("rules") }.find do |rule|
      rule["alert"] == source_anchor["alert"]
    end
    rendered_anchor_url = rendered_anchor&.dig("annotations", "runbook_url")
    abort "rendered anchor runbook does not match the source rule suffix" unless
      rendered_anchor_url.is_a?(String) && rendered_anchor_url.end_with?(runbook_suffix)
    approved_runbook_base = rendered_anchor_url.delete_suffix(runbook_suffix)
    runbook_base_uri = URI.parse(approved_runbook_base)
    abort "rendered runbook base must be one credential-free HTTPS origin/path" unless
      runbook_base_uri.scheme == "https" && runbook_base_uri.host &&
      !runbook_base_uri.user && !runbook_base_uri.password &&
      !runbook_base_uri.query && !runbook_base_uri.fragment
    canonical_rules_config = YAML.safe_load(
      source_rules_text.gsub("__RUNBOOK_BASE_URL__", approved_runbook_base),
      permitted_classes: [], permitted_symbols: [], aliases: false
    )
    canonical_groups = canonical_rules_config.fetch("groups")
    if approved_render_profile == "central"
      abort "rendered central rules drifted from the reviewed source" unless
        rules_config == canonical_rules_config
    else
      abort "local-production runbook base drifted" unless
        approved_runbook_base == "https://slots.localhost:8443/operator/runbooks"
      abort "rendered local rules must retain the exact reviewed central prefix and one local group" unless
        rules_config.keys == ["groups"] && groups.length == canonical_groups.length + 1 &&
        groups.take(canonical_groups.length) == canonical_groups

      build_local_rule = lambda do |name, expression, duration, severity, service, summary, description, slug|
        {
          "alert" => name,
          "expr" => expression,
          "for" => duration,
          "labels" => { "severity" => severity, "service" => service },
          "annotations" => {
            "summary" => summary,
            "description" => description,
            "runbook_url" => "https://slots.localhost:8443/operator/runbooks/#{slug}"
          }
        }
      end
      expected_local_rules = [
        build_local_rule.call(
          "LocalOperatorUnavailable",
          "(max_over_time(local_operator_ready{job=\"local-operator\"}[2m]) < 1) or absent(local_operator_ready{job=\"local-operator\"})",
          "2m", "critical", "local-operator", "本机运营钱包或持久化文件不可用",
          "数据库或持久化文件句柄连续不可用；容量水位由独立告警覆盖。", "local-operator-unavailable"
        ),
        build_local_rule.call(
          "LocalProductionBackupStatusUnreadable",
          "(local_production_backup_status_file_readable{job=\"local-operator\"} < 1) or absent(local_production_backup_status_file_readable{job=\"local-operator\"})",
          "2m", "critical", "backup", "本机备份状态文件不可读",
          "原子备份状态缺失或校验失败，备份新鲜度不可证明。", "backup-status-unreadable"
        ),
        build_local_rule.call(
          "LocalProductionBackupFailed",
          "local_production_backup_consecutive_failures{job=\"local-operator\"} > 0",
          "2m", "critical", "backup", "本机数据库备份连续失败",
          "周期任务正在按一分钟间隔重试；检查数据库 TLS、凭据、磁盘与归档权限。", "backup-failed"
        ),
        build_local_rule.call(
          "LocalProductionBackupStale",
          "(time() - local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"} > 25200) or (local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"} <= 0) or absent(local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"})",
          "10m", "critical", "backup", "本机备份超过七小时未成功",
          "六小时备份周期已越过一小时容错窗口；恢复点目标无法满足。", "backup-stale"
        )
      ]
      [
        ["Audit", "audit", "审计"],
        ["Log", "log", "运行日志"],
        ["Alert", "alert", "告警归档"]
      ].each do |title, metric, chinese|
        expected_local_rules << build_local_rule.call(
          "LocalOperator#{title}StoreNearCapacity",
          "(local_operator_#{metric}_store_bytes{job=\"local-operator\"} / clamp_min(local_operator_#{metric}_store_capacity_bytes{job=\"local-operator\"}, 1) > 0.75) or absent(local_operator_#{metric}_store_bytes{job=\"local-operator\"})",
          "10m", "warning", "local-operator", "本机#{chinese}存储接近容量上限",
          "#{chinese}分段归档已超过硬容量的 75%；先确认备份完整，再处理最旧只读段。",
          "#{metric}-store-capacity"
        )
        expected_local_rules << build_local_rule.call(
          "LocalOperator#{title}StoreNotWritable",
          "(local_operator_#{metric}_store_writable{job=\"local-operator\"} < 1) or absent(local_operator_#{metric}_store_writable{job=\"local-operator\"})",
          "2m", "critical", "local-operator", "本机#{chinese}存储无法接受最大批次",
          "#{chinese}硬容量剩余不足；服务保持可观测但对应 sink 会失败闭合。",
          "#{metric}-store-not-writable"
        )
      end
      expected_local_group = {
        "name" => "local-production-operator-alerts",
        "interval" => "30s",
        "rules" => expected_local_rules
      }
      abort "rendered local alert group drifted from the reviewed canonical semantics" unless
        groups.last == expected_local_group
    end
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
      RGSInstanceDown RGSNotReady RGSAuthenticationFailuresBurst RGSAuthenticationReplayDetected
      RGSRateLimitingSustained RGSSharedAdmissionErrors
      RGSEconomicAdmissionLimitedSustained RGSEconomicAdmissionErrors
      RGSEconomicAdmissionUnavailable RGSEconomicAdmissionObservationStale
      RGSCapacityRejectionsSustained RGSNewIntentCapacityRejected RGSConnectionCapacityNearLimit
      RGSCryptographicCapacitySaturated RGSSecurityLogDropsSustained RGSHTTPFailureRatioHigh
      RGSRequestLatencyP99High RGSDatabasePoolSaturated RGSWalletUnknownOutcome
      RGSRoundManualReviewRequired RGSIntegrityQuarantine RGSOutboxDeliveryDeferred
      RGSOutboxPublishStalled RGSOutboxLeaseLost RGSRoundCommitGapGrowing
      RGSObservabilityWatchdog PrometheusRuleEvaluationFailures PrometheusNotificationErrors
      VectorTelemetryUnavailable VectorLogPipelineErrors VectorLogEventsDiscarded
      VectorLogBufferNearCapacity VectorLogDeliveryStalled
    ]
    if approved_render_profile == "local-production"
      required_alerts += %w[
        LocalOperatorUnavailable LocalProductionBackupStatusUnreadable
        LocalProductionBackupFailed LocalProductionBackupStale
        LocalOperatorAuditStoreNearCapacity LocalOperatorAuditStoreNotWritable
        LocalOperatorLogStoreNearCapacity LocalOperatorLogStoreNotWritable
        LocalOperatorAlertStoreNearCapacity LocalOperatorAlertStoreNotWritable
      ]
    end
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

    canonical_dashboard = JSON.parse(
      source_dashboard_text.gsub("__RUNBOOK_BASE_URL__", approved_runbook_base)
    )
    if approved_render_profile == "central"
      abort "rendered central dashboard drifted from the reviewed source" unless
        dashboard == canonical_dashboard
    else
      canonical_panels = canonical_dashboard.fetch("panels")
      rendered_panels = dashboard.fetch("panels")
      canonical_without_panels = canonical_dashboard.reject { |key, _value| key == "panels" }
      rendered_without_panels = dashboard.reject { |key, _value| key == "panels" }
      abort "rendered local dashboard must retain the exact central dashboard and four local panels" unless
        rendered_without_panels == canonical_without_panels &&
        rendered_panels.is_a?(Array) && rendered_panels.length == canonical_panels.length + 4 &&
        rendered_panels.take(canonical_panels.length) == canonical_panels

      clone = ->(value) { Marshal.load(Marshal.dump(value)) }
      target = lambda do |expression, legend, reference|
        {
          "editorMode" => "code", "expr" => expression, "legendFormat" => legend,
          "range" => true, "refId" => reference
        }
      end
      readiness_panel = clone.call(canonical_panels.find { |panel| panel["id"] == 1 })
      readiness_panel["id"] = 20
      readiness_panel["title"] = "本机运营服务就绪状态"
      readiness_panel["description"] = "同时显示 TLS/Bearer 指标抓取状态与数据库、审计/日志容量就绪状态。"
      readiness_panel["gridPos"] = { "h" => 6, "w" => 8, "x" => 0, "y" => 21 }
      readiness_panel["targets"] = [
        target.call("min(up{job=\"local-operator\"})", "operator scrape", "A"),
        target.call("min(local_operator_ready{job=\"local-operator\"}) or vector(0)", "operator readiness", "B")
      ]

      traffic_panel = clone.call(canonical_panels.find { |panel| panel["id"] == 2 })
      traffic_panel["id"] = 21
      traffic_panel["title"] = "本机运营流量与异常"
      traffic_panel["gridPos"] = { "h" => 6, "w" => 16, "x" => 8, "y" => 21 }
      traffic_panel["targets"] = [
        target.call("sum(rate(local_operator_requests_total[5m]))", "requests/s", "A"),
        target.call("sum(rate(local_operator_failures_total[5m]))", "failures/s", "B"),
        target.call("sum(rate(local_operator_launches_total[5m]))", "launches/s", "C"),
        target.call("sum(rate(local_operator_audit_accepted_total[5m]))", "audit batches/s", "D"),
        target.call("sum(rate(local_operator_log_batches_total[5m]))", "log batches/s", "E")
      ]

      storage_panel = clone.call(canonical_panels.find { |panel| panel["id"] == 2 })
      storage_panel["id"] = 22
      storage_panel["title"] = "本机持久化容量使用率"
      storage_panel["description"] = "审计、脱敏日志和 Alertmanager 本地通知的分段归档容量；75% 触发预警。"
      storage_panel["gridPos"] = { "h" => 6, "w" => 12, "x" => 0, "y" => 27 }
      storage_panel["targets"] = []
      [["audit", "A", "B"], ["log", "C", "D"], ["alert", "E", "F"]].each do |name, used_ref, writable_ref|
        storage_panel["targets"] << target.call(
          "local_operator_#{name}_store_bytes / clamp_min(local_operator_#{name}_store_capacity_bytes, 1)",
          "#{name} utilization", used_ref
        )
        storage_panel["targets"] << target.call(
          "local_operator_#{name}_store_writable", "#{name} writable", writable_ref
        )
      end

      backup_panel = clone.call(canonical_panels.find { |panel| panel["id"] == 1 })
      backup_panel["id"] = 23
      backup_panel["title"] = "本机备份健康与新鲜度"
      backup_panel["description"] = "显示状态文件有效性、连续失败次数和距离最近成功备份的秒数。"
      backup_panel["gridPos"] = { "h" => 6, "w" => 12, "x" => 12, "y" => 27 }
      backup_panel["targets"] = [
        target.call("local_production_backup_status_file_readable", "status readable", "A"),
        target.call("local_production_backup_consecutive_failures", "consecutive failures", "B"),
        target.call("time() - local_production_backup_last_success_timestamp_seconds", "backup age seconds", "C")
      ]
      abort "rendered local dashboard panels drifted from the reviewed canonical semantics" unless
        rendered_panels.drop(canonical_panels.length) == [
          readiness_panel, traffic_panel, storage_panel, backup_panel
        ]
    end

    panel_ids = dashboard.fetch("panels").map { |panel| panel["id"] }
    abort "rendered dashboard panel IDs must be unique integers" unless
      panel_ids.all? { |id| id.is_a?(Integer) } && panel_ids.uniq.length == panel_ids.length

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
      rgs_economic_admission_ready rgs_economic_admission_last_success_timestamp_seconds
      rgs_economic_admission_last_success_age_seconds rgs_new_intent_capacity_rejected_total
      rgs_auth_replays_total rgs_shared_admission_errors_total
    ]
    if approved_render_profile == "local-production"
      required_dashboard_signals += %w[
        local_operator_ready local_operator_requests_total local_operator_failures_total
        local_operator_launches_total local_operator_audit_accepted_total local_operator_log_batches_total
        local_operator_audit_store_bytes local_operator_audit_store_capacity_bytes
        local_operator_audit_store_writable local_operator_log_store_bytes
        local_operator_log_store_capacity_bytes local_operator_log_store_writable
        local_operator_alert_store_bytes local_operator_alert_store_capacity_bytes
        local_operator_alert_store_writable local_production_backup_status_file_readable
        local_production_backup_consecutive_failures
        local_production_backup_last_success_timestamp_seconds
      ]
    end
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
  ' "$rendered_prometheus" "$rendered_rules" "$rendered_dashboard" "$rules_file" "$dashboard_file" \
    "$approved_render_profile" "$approved_rgs_target" "$approved_alertmanager_target" \
    "$approved_alertmanager_ca_file" "$approved_alertmanager_server_name" ||
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
    release_log_glob=$(printenv RGS_CONTAINER_LOG_GLOB 2>/dev/null || true)
    ruby -e '
      value = ARGV.fetch(0)
      abort "release log glob is empty" if value.empty?
      abort "release log glob contains control or whitespace bytes" if
        value.each_byte.any? { |byte| byte <= 0x20 || byte == 0x7f }
      abort "release log glob contains an ambiguous path" if
        value.include?("..") || value.include?("//") || value.include?("\\")
      approved = %r{\A/var/log/containers/[A-Za-z0-9][A-Za-z0-9._*-]{0,191}\.log\z}
      abort "release log glob syntax is not approved" unless approved.match?(value)
      basename = value.delete_prefix("/var/log/containers/").delete_suffix(".log")
      abort "release log glob must contain exactly one wildcard" unless basename.count("*") == 1
      abort "release log glob is not scoped to an independent rgs-server identity segment" unless
        /(?:\A|[-_.])rgs-server(?:\z|[-_.])/.match?(basename)
    ' "$release_log_glob" || fail 'release RGS container log glob contract failed'

    # 生产门禁只信任调用方审批并预载的 digest-pinned Prometheus 镜像。--pull never 与
    # --network none 保证校验不会在执行时换源或联网；宿主 PATH 中的任意 promtool 不足以放行。
    command -v docker >/dev/null 2>&1 || fail 'Docker is required for fixed-source release promtool'
    docker info >/dev/null 2>&1 || fail 'Docker daemon is required for fixed-source release promtool'
    prometheus_image=$(printenv PROMETHEUS_IMAGE 2>/dev/null || true)
    docker image inspect "$prometheus_image" >/dev/null 2>&1 ||
      fail 'PROMETHEUS_IMAGE must be preloaded; release validation never pulls it'
    vector_image=$(printenv VECTOR_IMAGE 2>/dev/null || true)
    docker image inspect "$vector_image" >/dev/null 2>&1 ||
      fail 'VECTOR_IMAGE must be preloaded; release validation never pulls it'
    alertmanager_root_ca_source=$(printenv ALERTMANAGER_ROOT_CA_FILE 2>/dev/null || true)
    ruby -e '
      path = ARGV.fetch(0)
      parts = path.split("/", -1).drop(1)
      abort "Alertmanager root CA path must be a canonical safe absolute path" unless
        path.start_with?("/") && path.bytesize <= 4096 && !parts.empty? &&
        parts.all? { |part| !part.empty? && part != "." && part != ".." && /\A[A-Za-z0-9._-]+\z/.match?(part) }
      abort "Alertmanager root CA must be one readable regular non-symlink file" unless
        File.file?(path) && File.readable?(path) && !File.symlink?(path)
    ' "$alertmanager_root_ca_source" || fail 'release Alertmanager root CA source contract failed'
    docker run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
      --mount "type=bind,src=$alertmanager_root_ca_source,dst=/input/alertmanager-root-ca.pem,readonly" \
      --entrypoint /bin/sh "$vector_image" -ceu \
        'openssl x509 -in /input/alertmanager-root-ca.pem -noout >/dev/null' ||
      fail 'fixed-source OpenSSL rejected the supplied Alertmanager root CA'
    for promtool_check in \
      'check config /etc/prometheus/prometheus.yml' \
      'check rules /etc/prometheus/rules/rgs-alerts.yml'
    do
      # 参数由上面的固定字面量产生，不接受 bundle 或环境注入附加 promtool 选项。
      # shellcheck disable=SC2086
      docker run --rm --pull never --network none --read-only \
        --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
        --mount "type=bind,src=$rendered_dir,dst=/etc/prometheus,readonly" \
        --mount type=bind,src=/dev/null,dst=/run/secrets/rgs_operations_bearer_token,readonly \
        --mount type=bind,src=/dev/null,dst=/run/secrets/local_operator_metrics_bearer_token,readonly \
        --mount type=bind,src=/dev/null,dst=/run/secrets/alertmanager_bearer_token,readonly \
        --mount "type=bind,src=$alertmanager_root_ca_source,dst=/run/secrets/alertmanager_root_ca.pem,readonly" \
        --entrypoint /bin/promtool "$prometheus_image" $promtool_check >/dev/null ||
        fail "fixed-source promtool rejected rendered bundle ($promtool_check)"
    done

    # 同一发布还必须由已评审并预载的 Vector 镜像解析真实 topology。这里禁用环境探测和
    # 网络，仅验证该固定版本认识所有 source/transform/sink 选项与缓冲约束。
    docker run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
      --env VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true \
      --env RGS_CONTAINER_LOG_GLOB="$release_log_glob" \
      --env RGS_LOG_SINK_URI="$log_sink_uri" \
      --mount "type=bind,src=$vector_file,dst=/etc/vector/vector.yaml,readonly" \
      "$vector_image" validate --no-environment /etc/vector/vector.yaml >/dev/null ||
      fail 'fixed-source Vector rejected the checked-in log topology'
    docker run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
      --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
      --env RGS_CONTAINER_LOG_GLOB="$release_log_glob" \
      --env RGS_LOG_SINK_URI="$log_sink_uri" \
      --mount "type=bind,src=$vector_file,dst=/etc/vector/vector.yaml,readonly" \
      "$vector_image" test --dangerously-allow-env-var-interpolation \
        /etc/vector/vector.yaml >/dev/null ||
      fail 'fixed-source Vector failed the central strict allowlist tests'
    docker run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
      --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
      --tmpfs /run/vector-secrets:rw,nosuid,nodev,noexec,mode=1777,size=1m \
      --mount "type=bind,src=$local_vector_file,dst=/etc/vector/vector.yaml,readonly" \
      --entrypoint /bin/sh "$vector_image" -c \
        'set -eu &&
         cp /etc/hostname /run/vector-secrets/local-operator-log-bearer.token &&
         openssl req -new -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
           -subj /CN=slots-vector-contract.invalid -keyout /tmp/local-vector-ca.key \
           -out /run/vector-secrets/local-production-root-ca.pem >/dev/null 2>&1 &&
         exec /usr/bin/vector validate --no-environment /etc/vector/vector.yaml' >/dev/null ||
      fail 'fixed-source Vector rejected the complete local HTTPS archive topology'
    docker run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
      --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
      --tmpfs /run/vector-secrets:rw,nosuid,nodev,noexec,mode=1777,size=1m \
      --mount "type=bind,src=$local_vector_file,dst=/etc/vector/vector.yaml,readonly" \
      --entrypoint /bin/sh "$vector_image" -c \
        'cp /etc/hostname /run/vector-secrets/local-operator-log-bearer.token &&
         cp /etc/hostname /run/vector-secrets/local-production-root-ca.pem &&
         exec /usr/bin/vector test /etc/vector/vector.yaml' >/dev/null ||
      fail 'fixed-source Vector failed the local strict allowlist tests'
  fi
  printf '%s\n' 'observability rendered release contract: ok'
fi

printf '%s\n' 'observability contract: ok'
