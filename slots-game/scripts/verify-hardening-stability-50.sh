#!/bin/sh
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
rounds=${HARDENING_STABILITY_ROUNDS:-50}
temporary_root=${TMPDIR:-/tmp}
temporary_root=${temporary_root%/}
report_directory=${HARDENING_STABILITY_REPORT_DIR:-$repository_root/.artifacts/hardening-stability}

case "$rounds" in
  ''|*[!0-9]*)
    printf '%s\n' 'HARDENING_STABILITY_ROUNDS 必须是 1 到 100 的整数。' >&2
    exit 2
    ;;
esac
if [ "$rounds" -lt 1 ] || [ "$rounds" -gt 100 ]; then
  printf '%s\n' 'HARDENING_STABILITY_ROUNDS 必须是 1 到 100 的整数。' >&2
  exit 2
fi

for command in git go node shasum helm docker; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '缺少 50 轮稳定性回归所需命令：%s\n' "$command" >&2
    exit 2
  }
done
vitest_binary="$repository_root/web/node_modules/.bin/vitest"
test -x "$vitest_binary" || {
  printf '%s\n' '缺少固定的本地 Vitest；请先在 web 目录安装锁定依赖。' >&2
  exit 2
}

temporary_directory=$(mktemp -d "$temporary_root/slots-hardening-stability.XXXXXX")
cleanup() {
  case "$temporary_directory" in
    "$temporary_root"/slots-hardening-stability.*)
      rm -rf -- "$temporary_directory"
      ;;
  esac
}

mkdir -p "$report_directory"
run_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
report_file="$report_directory/$run_id.tsv"
report_finalized=false

git_root=$(git -C "$repository_root" rev-parse --show-toplevel)
repository_prefix=$(git -C "$repository_root" rev-parse --show-prefix)
source_manifest() {
  git -C "$git_root" ls-files --cached --others --exclude-standard -- \
    "$repository_prefix" '.github/workflows/supply-chain-release.yml' |
    LC_ALL=C sort |
    while IFS= read -r path; do
      test -f "$git_root/$path" || continue
      printf '%s\t%s\n' "$(git -C "$git_root" hash-object -- "$path")" "$path"
    done
}
source_digest() {
  source_manifest | shasum -a 256 | awk '{ print $1 }'
}

finalize_report() {
  status=$1
  if [ "$report_finalized" = true ]; then
    return
  fi
  report_finalized=true
  {
    printf 'meta\tstatus\t%s\n' "$status"
    printf 'meta\tfinished_utc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'meta\tfinal_source_sha256\t%s\n' "$(source_digest)"
  } >>"$report_file"
}

on_exit() {
  exit_status=$?
  case "$exit_status" in
    0) final_status=passed ;;
    129|130|143) final_status=aborted ;;
    *) final_status=failed ;;
  esac
  finalize_report "$final_status"
  cleanup
}

trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
{
  printf 'meta\trun_id\t%s\n' "$run_id"
  printf 'meta\tstarted_utc\t%s\n' "$started_utc"
  printf 'meta\trounds\t%s\n' "$rounds"
  printf 'meta\tgo_version\t%s\n' "$(go version)"
  printf 'meta\tnode_version\t%s\n' "$(node --version)"
  printf 'meta\tvitest_version\t%s\n' "$($vitest_binary --version | tr '\t\n' '  ')"
  printf 'meta\thelm_version\t%s\n' "$(helm version --short | tr '\t\n' '  ')"
  printf 'meta\tdocker_version\t%s\n' "$(docker --version | tr '\t\n' '  ')"
} >"$report_file"
initial_digest=$(source_digest)
{
  printf 'meta\tsource_sha256\t%s\n' "$initial_digest"
  printf 'round\tseed\tstep\tstatus\tduration_seconds\tdetails\n'
} >>"$report_file"

print_failure_log() {
  log_file=$1
  sed -n '1,200p' "$log_file" >&2
  line_count=$(wc -l <"$log_file" | tr -d ' ')
  if [ "$line_count" -gt 200 ]; then
    printf '%s\n' '……失败日志末尾……' >&2
    tail -n 200 "$log_file" >&2
  fi
}

record_step() {
  round=$1
  seed=$2
  name=$3
  duration=$4
  details=$5
  printf '%s\t%s\t%s\tpassed\t%s\t%s\n' \
    "$round" "$seed" "$name" "$duration" "$details" >>"$report_file"
}

run_step() {
  round=$1
  name=$2
  shift 2
  log_file="$temporary_directory/round-${round}-${name}.log"
  started=$(date +%s)
  if "$@" >"$log_file" 2>&1; then
    duration=$(($(date +%s) - started))
    record_step "$round" "$round" "$name" "$duration" '-'
    return 0
  fi
  printf '稳定性回归第 %s/%s 轮失败：%s\n' "$round" "$rounds" "$name" >&2
  cp -- "$log_file" "$report_directory/$run_id-failure-$round-$name.log"
  print_failure_log "$log_file"
  exit 1
}

run_go() {
  round=$1
  event_file="$temporary_directory/round-${round}-go.jsonl"
  started=$(date +%s)
  if ! (cd "$repository_root/server" && go test -json -count=1 "-shuffle=$round" ./...) \
    >"$event_file" 2>&1; then
    printf '稳定性回归第 %s/%s 轮失败：go-all\n' "$round" "$rounds" >&2
    cp -- "$event_file" "$report_directory/$run_id-failure-$round-go-all.jsonl"
    print_failure_log "$event_file"
    exit 1
  fi
  summary=$(node "$script_directory/summarize-go-test-json.mjs" \
    "$event_file" "$script_directory/go-test-external-skip-allowlist.txt")
  duration=$(($(date +%s) - started))
  record_step "$round" "$round" go-all "$duration" "$summary"
}

run_web() {
  round=$1
  log_file="$temporary_directory/round-${round}-web-all.log"
  result_file="$temporary_directory/round-${round}-web-all.json"
  started=$(date +%s)
  if ! (cd "$repository_root/web" && "$vitest_binary" --run --fileParallelism=false \
    --sequence.shuffle.tests --sequence.seed="$round" --reporter=json \
    --outputFile="$result_file") >"$log_file" 2>&1; then
    printf '稳定性回归第 %s/%s 轮失败：web-all\n' "$round" "$rounds" >&2
    cp -- "$log_file" "$report_directory/$run_id-failure-$round-web-all.log"
    print_failure_log "$log_file"
    exit 1
  fi
  summary=$(node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!result.success || result.numFailedTests !== 0 || result.numPendingTests !== 0 || result.numTodoTests !== 0) {
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      files_passed: result.testResults.filter((item) => item.status === "passed").length,
      tests_passed: result.numPassedTests,
      tests_skipped: result.numPendingTests + result.numTodoTests,
    }));
  ' "$result_file")
  duration=$(($(date +%s) - started))
  record_step "$round" "$round" web-all "$duration" "$summary"
}

round=1
while [ "$round" -le "$rounds" ]; do
  run_go "$round"
  run_web "$round"
  run_step "$round" terraform-static \
    "$repository_root/infra/terraform/scripts/verify-static-contract.sh"
  run_step "$round" aws-workflow-static \
    "$repository_root/deploy/aws-production/workflow/verify-contract.sh"
  run_step "$round" cluster-static \
    "$repository_root/deploy/cluster-production/verify-static-contract.sh"
  run_step "$round" cluster-prometheus-rules \
    "$repository_root/deploy/cluster-production/verify-prometheus-rule-contract.sh"
  run_step "$round" observability-static \
    "$repository_root/deploy/observability/verify-static-contract.sh"
  run_step "$round" supply-chain-static \
    "$repository_root/deploy/supply-chain/verify-contract.sh"
  run_step "$round" web-static \
    "$repository_root/deploy/web/verify-static-contract.sh"
  run_step "$round" local-production-static \
    "$repository_root/deploy/local-production/verify-static-contract.sh"
  # `$1` 由下面显式传入的子 shell 参数展开，不能在父 shell 提前插值。
  # shellcheck disable=SC2016
  run_step "$round" hardening-checklist \
    sh -c 'cd "$1" && node --test \
      scripts/verify-hardening-checklist.test.mjs \
      scripts/summarize-go-test-json.test.mjs && \
      node scripts/verify-hardening-checklist.mjs' sh "$repository_root"
  current_digest=$(source_digest)
  if [ "$current_digest" != "$initial_digest" ]; then
    printf '稳定性回归第 %s/%s 轮后源码摘要发生变化；结果跨越了不同快照。\n' \
      "$round" "$rounds" >&2
    exit 1
  fi
  printf '稳定性回归第 %s/%s 轮通过。\n' "$round" "$rounds"
  round=$((round + 1))
done

finalize_report passed
printf '加固稳定性回归通过：%s/%s 轮；摘要：%s\n' "$rounds" "$rounds" "$report_file"
