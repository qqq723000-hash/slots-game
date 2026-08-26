#!/bin/sh

# 两阶段验证 Vector 低流量磁盘缓冲：A 阶段先制造出口中断并证明业务事件已落入
# 磁盘；B 阶段先用独立控制面探针证明接收端就绪，再验证在线单事件仅靠安全心跳推进。
set -eu
umask 077

fail() {
  printf '%s\n' 'vector bounded flush test: failed' >&2
  exit 1
}

expected_vector_image='timberio/vector:0.57.0-debian@sha256:ed2134fa8f9844c1ca6405260903c2c2c52f94af9e16bc8fa9de9655134e0b39'
vector_image=${VECTOR_IMAGE:-}
test "$vector_image" = "$expected_vector_image" || fail
command -v docker >/dev/null 2>&1 || fail
command -v ruby >/dev/null 2>&1 || fail
docker image inspect "$vector_image" >/dev/null 2>&1 || fail

runtime_uid=$(id -u 2>/dev/null) || fail
runtime_gid=$(id -g 2>/dev/null) || fail
test "$runtime_uid" -ne 0 || fail

temporary_parent=${TMPDIR:-/tmp}
case "$temporary_parent" in
  /*) ;;
  *) fail ;;
esac
temporary_parent=${temporary_parent%/}
test -n "$temporary_parent" || temporary_parent=/
case "$temporary_parent" in
  *[!A-Za-z0-9_./-]*|*//*|*/../*|*/./*) fail ;;
esac
test -d "$temporary_parent" || fail

test_directory=$(mktemp -d "$temporary_parent/vector-bounded-flush.XXXXXX" 2>/dev/null) || fail
case "$test_directory" in
  "$temporary_parent"/vector-bounded-flush.*) ;;
  *) fail ;;
esac

test_token=${test_directory##*.}
network_name="vector-bounded-flush-$test_token"
outage_sender_name="vector-bounded-outage-$test_token"
readiness_sender_name="vector-bounded-readiness-$test_token"
online_sender_name="vector-bounded-online-$test_token"
receiver_name="vector-bounded-receiver-$test_token"
network_created=0

cleanup_resources() {
  cleanup_status=0
  if [ "$network_created" -eq 1 ]; then
    for container_name in \
      "$outage_sender_name" "$readiness_sender_name" \
      "$online_sender_name" "$receiver_name"
    do
      if docker container inspect "$container_name" >/dev/null 2>&1; then
        docker rm --force "$container_name" >/dev/null 2>&1 || cleanup_status=1
      fi
      if docker container inspect "$container_name" >/dev/null 2>&1; then
        cleanup_status=1
      fi
    done
    if docker network inspect "$network_name" >/dev/null 2>&1; then
      docker network rm "$network_name" >/dev/null 2>&1 || cleanup_status=1
    fi
    if docker network inspect "$network_name" >/dev/null 2>&1; then
      cleanup_status=1
    else
      network_created=0
    fi
  fi
  case "$test_directory" in
    "$temporary_parent"/vector-bounded-flush.*)
      rm -rf -- "$test_directory" >/dev/null 2>&1 || cleanup_status=1
      test ! -e "$test_directory" || cleanup_status=1
      ;;
    *)
      cleanup_status=1
      ;;
  esac
  test "$cleanup_status" -eq 0
}

cleanup() {
  trap - EXIT HUP INT TERM
  cleanup_resources || :
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

outage_sender_config="$test_directory/outage-sender.yaml"
readiness_sender_config="$test_directory/readiness-sender.yaml"
online_sender_config="$test_directory/online-sender.yaml"
receiver_config="$test_directory/receiver.yaml"
outage_sender_data="$test_directory/outage-sender-data"
readiness_sender_data="$test_directory/readiness-sender-data"
online_sender_data="$test_directory/online-sender-data"
receiver_data="$test_directory/receiver-data"
receiver_output="$test_directory/receiver-output"
mkdir -m 0700 \
  "$outage_sender_data" "$readiness_sender_data" "$online_sender_data" \
  "$receiver_data" "$receiver_output" >/dev/null 2>&1 || fail

# Ruby 只抽取两份真实配置中完全一致的心跳链路、HTTP 编码、batch 与 disk buffer；
# TLS、凭据和生产 URI 不进入夹具，三个接收入口都只存在于本次内部 Docker 网络。
if ! ruby -ryaml -rjson - \
  deploy/observability/vector.yaml \
  deploy/local-production/vector.yaml \
  "$outage_sender_config" "$readiness_sender_config" \
  "$online_sender_config" "$receiver_config" >/dev/null 2>&1 <<'RUBY'
central_path, local_path, outage_path, readiness_path, online_path, receiver_path = ARGV

def load_config(path)
  value = YAML.safe_load(File.read(path), aliases: false)
  raise 'invalid config' unless value.is_a?(Hash)
  value
end

def component(config, section, name)
  value = config.fetch(section).fetch(name)
  raise 'invalid component' unless value.is_a?(Hash)
  value
end

central = load_config(central_path)
local = load_config(local_path)

source_name = 'archive_flush_heartbeat_metric'
metric_transform_name = 'archive_flush_heartbeat_to_log'
safe_transform_name = 'safe_archive_flush_heartbeat'

heartbeat_source = component(central, 'sources', source_name)
heartbeat_metric_transform = component(central, 'transforms', metric_transform_name)
heartbeat_safe_transform = component(central, 'transforms', safe_transform_name)

raise 'heartbeat source mismatch' unless heartbeat_source == component(local, 'sources', source_name)
raise 'heartbeat transform mismatch' unless heartbeat_metric_transform == component(local, 'transforms', metric_transform_name)
raise 'heartbeat transform mismatch' unless heartbeat_safe_transform == component(local, 'transforms', safe_transform_name)
raise 'invalid heartbeat source' unless heartbeat_source['type'] == 'static_metrics'
raise 'invalid heartbeat interval' unless heartbeat_source['interval_secs'] == 10
raise 'invalid heartbeat transform' unless heartbeat_metric_transform == {
  'type' => 'metric_to_log',
  'inputs' => [source_name]
}
raise 'invalid heartbeat transform' unless heartbeat_safe_transform['type'] == 'remap'
raise 'invalid heartbeat transform' unless heartbeat_safe_transform['inputs'] == [metric_transform_name]

central_sink = component(central, 'sinks', 'approved_https_archive')
local_sink = component(local, 'sinks', 'local_https_archive')
%w[encoding framing batch buffer request].each do |key|
  raise 'archive transport mismatch' unless central_sink.fetch(key) == local_sink.fetch(key)
end
raise 'heartbeat is not archived' unless central_sink.fetch('inputs').include?(safe_transform_name)
raise 'heartbeat is not archived' unless local_sink.fetch('inputs').include?(safe_transform_name)

batch = central_sink.fetch('batch')
buffer = central_sink.fetch('buffer')
raise 'invalid batch' unless batch == {'max_bytes' => 1_048_576, 'timeout_secs' => 5}
raise 'invalid buffer' unless buffer == {
  'type' => 'disk',
  'max_size' => 268_435_488,
  'when_full' => 'block'
}

def bounded_sender(source_name:, metric_transform_name:, safe_transform_name:,
                   heartbeat_source:, heartbeat_metric_transform:, heartbeat_safe_transform:,
                   sink:, batch:, buffer:, marker:, message:, uri:)
  probe = {
    'service' => 'rgs-server',
    'level' => 'INFO',
    'msg' => message,
    'bounded_flush_probe' => marker
  }
  {
    'data_dir' => '/var/lib/vector',
    'sources' => {
      source_name => heartbeat_source,
      'bounded_flush_business_probe' => {
        'type' => 'demo_logs',
        'format' => 'shuffle',
        'lines' => [JSON.generate(probe)],
        'sequence' => false,
        'count' => 1,
        'interval' => 0.0,
        'framing' => {'method' => 'bytes'},
        'decoding' => {'codec' => 'json'}
      }
    },
    'transforms' => {
      metric_transform_name => heartbeat_metric_transform,
      safe_transform_name => heartbeat_safe_transform
    },
    'sinks' => {
      'bounded_archive' => {
        'type' => 'http',
        'inputs' => ['bounded_flush_business_probe', safe_transform_name],
        'uri' => uri,
        'method' => 'post',
        'encoding' => sink.fetch('encoding'),
        'framing' => sink.fetch('framing'),
        'batch' => batch,
        'buffer' => buffer,
        'request' => sink.fetch('request'),
        'healthcheck' => {'enabled' => false}
      }
    }
  }
end

outage_sender = bounded_sender(
  source_name: source_name,
  metric_transform_name: metric_transform_name,
  safe_transform_name: safe_transform_name,
  heartbeat_source: heartbeat_source,
  heartbeat_metric_transform: heartbeat_metric_transform,
  heartbeat_safe_transform: heartbeat_safe_transform,
  sink: central_sink,
  batch: batch,
  buffer: buffer,
  marker: 'vector-bounded-flush-outage-v1',
  message: 'bounded flush outage business probe',
  uri: 'http://archive-receiver:8080/outage'
)

online_sender = bounded_sender(
  source_name: source_name,
  metric_transform_name: metric_transform_name,
  safe_transform_name: safe_transform_name,
  heartbeat_source: heartbeat_source,
  heartbeat_metric_transform: heartbeat_metric_transform,
  heartbeat_safe_transform: heartbeat_safe_transform,
  sink: central_sink,
  batch: batch,
  buffer: buffer,
  marker: 'vector-bounded-flush-online-v1',
  message: 'bounded flush online business probe',
  uri: 'http://archive-receiver:8082/online'
)

readiness_control = {
  'service' => 'vector-test-control',
  'level' => 'INFO',
  'msg' => 'receiver readiness probe',
  'bounded_flush_control' => 'receiver-ready-v1'
}
readiness_sender = {
  'data_dir' => '/var/lib/vector',
  'sources' => {
    'receiver_readiness_probe' => {
      'type' => 'demo_logs',
      'format' => 'shuffle',
      'lines' => [JSON.generate(readiness_control)],
      'sequence' => false,
      'count' => 1,
      'interval' => 0.0,
      'framing' => {'method' => 'bytes'},
      'decoding' => {'codec' => 'json'}
    }
  },
  'sinks' => {
    'receiver_readiness_http' => {
      'type' => 'http',
      'inputs' => ['receiver_readiness_probe'],
      'uri' => 'http://archive-receiver:8081/readiness',
      'method' => 'post',
      'encoding' => central_sink.fetch('encoding'),
      'framing' => central_sink.fetch('framing'),
      'batch' => {'max_events' => 1, 'timeout_secs' => 1},
      'buffer' => {'type' => 'memory', 'max_events' => 10, 'when_full' => 'block'},
      'request' => {'timeout_secs' => 2},
      'healthcheck' => {'enabled' => false}
    }
  }
}

def receiver_source(port, path)
  {
    'type' => 'http_server',
    'address' => "0.0.0.0:#{port}",
    'method' => 'POST',
    'path' => path,
    'strict_path' => true,
    'host_key' => '',
    'path_key' => '',
    # HTTP 传输元数据保留在 Vector 元数据命名空间，文件只记录原始事件字段。
    'log_namespace' => true,
    'framing' => {'method' => 'newline_delimited'},
    'decoding' => {'codec' => 'json'},
    'response_code' => 204
  }
end

def receiver_file(input, path)
  {
    'type' => 'file',
    'inputs' => [input],
    'path' => path,
    'idle_timeout_secs' => 1,
    'encoding' => {'codec' => 'json'},
    'framing' => {'method' => 'newline_delimited'}
  }
end

receiver = {
  'data_dir' => '/var/lib/vector',
  'sources' => {
    'outage_archive_http' => receiver_source(8080, '/outage'),
    'readiness_http' => receiver_source(8081, '/readiness'),
    'online_archive_http' => receiver_source(8082, '/online')
  },
  'sinks' => {
    'outage_archive_file' => receiver_file('outage_archive_http', '/output/outage.ndjson'),
    'readiness_file' => receiver_file('readiness_http', '/output/readiness.ndjson'),
    'online_archive_file' => receiver_file('online_archive_http', '/output/online.ndjson')
  }
}

File.write(outage_path, YAML.dump(outage_sender))
File.write(readiness_path, YAML.dump(readiness_sender))
File.write(online_path, YAML.dump(online_sender))
File.write(receiver_path, YAML.dump(receiver))
RUBY
then
  fail
fi
chmod 0400 \
  "$outage_sender_config" "$readiness_sender_config" \
  "$online_sender_config" "$receiver_config" >/dev/null 2>&1 || fail

validate_config() {
  config_path=$1
  docker run --rm --pull never --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --user "$runtime_uid:$runtime_gid" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777 \
    --mount "type=bind,src=$config_path,dst=/etc/vector/vector.yaml,readonly" \
    --entrypoint vector "$vector_image" \
    validate --no-environment /etc/vector/vector.yaml >/dev/null 2>&1
}
validate_config "$outage_sender_config" || fail
validate_config "$readiness_sender_config" || fail
validate_config "$online_sender_config" || fail
validate_config "$receiver_config" || fail

run_vector() {
  container_name=$1
  config_path=$2
  data_path=$3
  shift 3
  docker run --detach --pull never --name "$container_name" \
    --network "$network_name" --read-only --log-driver none \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --user "$runtime_uid:$runtime_gid" --pids-limit 128 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777 \
    --mount "type=bind,src=$config_path,dst=/etc/vector/vector.yaml,readonly" \
    --mount "type=bind,src=$data_path,dst=/var/lib/vector" \
    --env VECTOR_LOG=error \
    "$@" "$vector_image" --config /etc/vector/vector.yaml >/dev/null 2>&1
}

archive_is_valid() {
  archive_path=$1
  marker=$2
  expected_message=$3
  test -s "$archive_path" || return 1
  ruby -rjson - "$archive_path" "$marker" "$expected_message" >/dev/null 2>&1 <<'RUBY'
path, marker, expected_message = ARGV
events = File.readlines(path, chomp: true).reject(&:empty?).map { |line| JSON.parse(line) }
raise 'invalid archive' unless events.all? { |event| event.is_a?(Hash) }

probes = events.select { |event| event['bounded_flush_probe'] == marker }
raise 'business probe count mismatch' unless probes.length == 1
raise 'business probe changed' unless probes.first['msg'] == expected_message

heartbeat_keys = %w[level msg service time].sort
heartbeats = events.select do |event|
  event.keys.sort == heartbeat_keys &&
    event['service'] == 'vector' &&
    event['level'] == 'INFO' &&
    event['msg'] == 'archive flush heartbeat' &&
    event['time'].is_a?(String)
end
raise 'heartbeat missing' if heartbeats.empty?

raw_metric = events.any? do |event|
  event['name'] == 'archive_flush_heartbeat' ||
    event.key?('gauge') || event.key?('counter') ||
    event.key?('kind') || event.key?('tags')
end
raise 'raw metric escaped' if raw_metric
RUBY
}

wait_for_archive() {
  archive_path=$1
  marker=$2
  expected_message=$3
  deadline=$4
  while :; do
    if archive_is_valid "$archive_path" "$marker" "$expected_message"; then
      return 0
    fi
    test "$(date +%s 2>/dev/null)" -lt "$deadline" || return 1
    sleep 1
  done
}

docker network create --internal "$network_name" >/dev/null 2>&1 || fail
network_created=1

# A：接收端尚不存在时启动 sender；8 秒后直接在 disk buffer 中寻找唯一业务标记，
# 证明事件确已由 demo_logs 产生并持久化，而不是在接收端恢复后才生成。
outage_started_at=$(date +%s 2>/dev/null) || fail
run_vector "$outage_sender_name" "$outage_sender_config" "$outage_sender_data" || fail
sleep 8
test "$(docker container inspect --format '{{.State.Running}}' "$outage_sender_name" 2>/dev/null)" = true || fail
if docker container inspect "$receiver_name" >/dev/null 2>&1; then
  fail
fi
if ! ruby - "$outage_sender_data" >/dev/null 2>&1 <<'RUBY'
directory = ARGV.fetch(0)
marker = 'vector-bounded-flush-outage-v1'.b
files = Dir.glob(File.join(directory, '**', '*'), File::FNM_DOTMATCH).select { |path| File.file?(path) }
raise 'business event is not durable' unless files.any? { |path| File.binread(path).include?(marker) }
RUBY
then
  fail
fi

run_vector "$receiver_name" "$receiver_config" "$receiver_data" \
  --network-alias archive-receiver \
  --mount "type=bind,src=$receiver_output,dst=/output" || fail
outage_deadline=$((outage_started_at + 25))
wait_for_archive \
  "$receiver_output/outage.ndjson" \
  'vector-bounded-flush-outage-v1' \
  'bounded flush outage business probe' \
  "$outage_deadline" || fail

docker stop --time 3 "$outage_sender_name" >/dev/null 2>&1 || fail
docker rm "$outage_sender_name" >/dev/null 2>&1 || fail
sleep 2
archive_is_valid \
  "$receiver_output/outage.ndjson" \
  'vector-bounded-flush-outage-v1' \
  'bounded flush outage business probe' || fail

# B 前置：控制面探针使用独立端口与独立文件；其固定字段不能被业务 marker 计数。
test "$(docker container inspect --format '{{.State.Running}}' "$receiver_name" 2>/dev/null)" = true || fail
run_vector \
  "$readiness_sender_name" "$readiness_sender_config" "$readiness_sender_data" || fail
readiness_deadline=$(($(date +%s 2>/dev/null) + 10))
readiness_file="$receiver_output/readiness.ndjson"
readiness_ready=0
while :; do
  if [ -s "$readiness_file" ] && ruby -rjson - "$readiness_file" >/dev/null 2>&1 <<'RUBY'
events = File.readlines(ARGV.fetch(0), chomp: true).reject(&:empty?).map { |line| JSON.parse(line) }
controls = events.select { |event| event['bounded_flush_control'] == 'receiver-ready-v1' }
raise 'readiness count mismatch' unless controls.length == 1
raise 'readiness disguised as business' if controls.first.key?('bounded_flush_probe')
raise 'readiness changed' unless controls.first['service'] == 'vector-test-control'
raise 'readiness changed' unless controls.first['msg'] == 'receiver readiness probe'
RUBY
  then
    readiness_ready=1
    break
  fi
  test "$(date +%s 2>/dev/null)" -lt "$readiness_deadline" || break
  sleep 1
done
test "$readiness_ready" -eq 1 || fail
docker rm --force "$readiness_sender_name" >/dev/null 2>&1 || fail

# B：接收端已经以真实 HTTP→file 事件证明就绪；全新 sender 与 data_dir 只产生一条
# 在线业务事件，因此这一阶段没有连接失败或旧重试可以推动 disk buffer。
online_started_at=$(date +%s 2>/dev/null) || fail
run_vector "$online_sender_name" "$online_sender_config" "$online_sender_data" || fail
online_deadline=$((online_started_at + 25))
wait_for_archive \
  "$receiver_output/online.ndjson" \
  'vector-bounded-flush-online-v1' \
  'bounded flush online business probe' \
  "$online_deadline" || fail

docker stop --time 3 "$online_sender_name" >/dev/null 2>&1 || fail
docker rm "$online_sender_name" >/dev/null 2>&1 || fail
sleep 2

# 最终重新读取三个独立文件：两条业务 marker 各自精确一次，控制面事件未混入，
# 两阶段都至少存在一个固定四字段安全心跳，且任何原始 metric 形状都未越界。
archive_is_valid \
  "$receiver_output/outage.ndjson" \
  'vector-bounded-flush-outage-v1' \
  'bounded flush outage business probe' || fail
archive_is_valid \
  "$receiver_output/online.ndjson" \
  'vector-bounded-flush-online-v1' \
  'bounded flush online business probe' || fail
if ! ruby -rjson - \
  "$receiver_output/outage.ndjson" \
  "$receiver_output/readiness.ndjson" \
  "$receiver_output/online.ndjson" >/dev/null 2>&1 <<'RUBY'
outage_path, readiness_path, online_path = ARGV
outage = File.readlines(outage_path, chomp: true).reject(&:empty?).map { |line| JSON.parse(line) }
readiness = File.readlines(readiness_path, chomp: true).reject(&:empty?).map { |line| JSON.parse(line) }
online = File.readlines(online_path, chomp: true).reject(&:empty?).map { |line| JSON.parse(line) }
all = outage + readiness + online

raise 'outage probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-outage-v1' } == 1
raise 'online probe count mismatch' unless all.count { |event| event['bounded_flush_probe'] == 'vector-bounded-flush-online-v1' } == 1
raise 'control count mismatch' unless all.count { |event| event['bounded_flush_control'] == 'receiver-ready-v1' } == 1
raise 'control entered archive' unless (outage + online).none? { |event| event.key?('bounded_flush_control') }
raise 'business entered control file' unless readiness.none? { |event| event.key?('bounded_flush_probe') }
RUBY
then
  fail
fi

cleanup_resources || fail
trap - EXIT HUP INT TERM
printf '%s\n' 'vector bounded flush test: passed'
