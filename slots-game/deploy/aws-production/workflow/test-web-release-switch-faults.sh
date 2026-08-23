#!/bin/sh

# 纯本地故障夹具：覆盖 KVS 写入结果不确定时的权威回读、补偿与人工处置边界。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
publisher="$script_directory/publish-web-release.sh"
mock_command="$script_directory/fixtures/mock-web-release-command.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-web-release-switch.XXXXXX")

cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "AWS Web 切换故障夹具失败：$*" >&2
  exit 1
}

release_id="sha256:$(printf '%064d' 1)"
previous_release="sha256:$(printf '%064d' 2)"
web_digest="sha256:$(printf '%064d' 3)"
configuration_sha256=$(printf '%064d' 4)
csp="default-src 'self';"

run_scenario() {
  scenario=$1
  initial_release=$2
  expected_status=$3
  scenario_root="$fixture_root/$scenario"
  static_root="$scenario_root/static"
  extraction_evidence="$scenario_root/extraction"
  delivery_evidence="$scenario_root/delivery"
  mock_bin="$scenario_root/bin"
  state_directory="$scenario_root/state"
  mkdir -p "$static_root" "$extraction_evidence" "$mock_bin" "$state_directory"
  ln -s "$mock_command" "$mock_bin/aws"
  ln -s "$mock_command" "$mock_bin/curl"
  ln -s "$mock_command" "$mock_bin/sleep"

  printf '{"releaseId":"%s"}\n' "$release_id" > "$static_root/release-manifest.json"
  printf '%s\n' "$csp" > "$extraction_evidence/cloudfront-content-security-policy.txt"
  {
    printf 'WEB_IMAGE_DIGEST=%s\n' "$web_digest"
    printf 'CONFIGURATION_SHA256=%s\n' "$configuration_sha256"
    printf 'RELEASE_ID=%s\n' "$release_id"
  } > "$extraction_evidence/aws-web-delivery.env"
  printf '%s\n' "$initial_release" > "$state_directory/active-release"
  printf '%s\n' 'etag-before-promotion' > "$state_directory/etag"
  : > "$state_directory/events.log"

  set +e
  env \
    PATH="$mock_bin:$PATH" \
    MOCK_WEB_STATE_DIRECTORY="$state_directory" \
    MOCK_WEB_SCENARIO="$scenario" \
    MOCK_WEB_RELEASE_ID="$release_id" \
    MOCK_WEB_IMAGE_DIGEST="$web_digest" \
    MOCK_WEB_CONFIGURATION_SHA256="$configuration_sha256" \
    MOCK_WEB_CSP="$csp" \
    MOCK_WEB_CSP_SHA256="$(sha256sum "$extraction_evidence/cloudfront-content-security-policy.txt" | awk '{ print $1 }')" \
    AWS_ACCOUNT_ID=123456789012 \
    AWS_REGION=ap-southeast-1 \
    AWS_WEB_BUCKET=slots-web-fixture \
    AWS_WEB_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-1111-1111-111111111111 \
    AWS_CLOUDFRONT_DISTRIBUTION_ID=distribution-fixture \
    AWS_CLOUDFRONT_DOMAIN_NAME=fixture.cloudfront.net \
    AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID=policy-fixture \
    AWS_CLOUDFRONT_KVS_ARN=arn:aws:cloudfront::123456789012:key-value-store/kvs-fixture \
    AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME=router-fixture \
    "$publisher" "$static_root" "$extraction_evidence" \
      "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/web@$web_digest" \
      "$configuration_sha256" "$delivery_evidence" \
      > "$scenario_root/stdout.log" 2> "$scenario_root/stderr.log"
  actual_status=$?
  set -e

  case "$expected_status" in
    success) test "$actual_status" -eq 0 || fail "$scenario 应成功，实际退出 $actual_status" ;;
    failure) test "$actual_status" -ne 0 || fail "$scenario 应失败却成功" ;;
    *) fail "未知 expected status：$expected_status" ;;
  esac
}

run_scenario applied-then-error "$previous_release" success
test "$(sed -n '1p' "$fixture_root/applied-then-error/state/active-release")" = "$release_id" || \
  fail 'applied-then-error 未保留已通过公网验证的新 release'
grep -F -x 'public-target' "$fixture_root/applied-then-error/state/events.log" >/dev/null || \
  fail 'applied-then-error 没有进入公网验证'
if grep -E '^rollback-(put|delete)$' "$fixture_root/applied-then-error/state/events.log" >/dev/null; then
  fail 'applied-then-error 公网验证成功后仍执行回退'
fi

run_scenario delayed-apply-after-read "$previous_release" success
test "$(sed -n '1p' "$fixture_root/delayed-apply-after-read/state/active-release")" = "$release_id" || \
  fail 'delayed-apply-after-read 没有识别迟到提交的新 release'
grep -F -x 'delayed-promotion-applied' \
  "$fixture_root/delayed-apply-after-read/state/events.log" >/dev/null || \
  fail 'delayed-apply-after-read 未在首次旧值回读后触发迟到提交'
grep -F -x 'public-target' \
  "$fixture_root/delayed-apply-after-read/state/events.log" >/dev/null || \
  fail 'delayed-apply-after-read 未在 ETag 推进后进入公网验证'

run_scenario applied-then-error-public-failure "$previous_release" failure
test "$(sed -n '1p' "$fixture_root/applied-then-error-public-failure/state/active-release")" = \
  "$previous_release" || fail 'applied-then-error 公网失败后未恢复旧 release'
grep -F -x 'rollback-put' \
  "$fixture_root/applied-then-error-public-failure/state/events.log" >/dev/null || \
  fail 'applied-then-error 公网失败后未执行条件回退'
grep -F -x 'public-rollback-release' \
  "$fixture_root/applied-then-error-public-failure/state/events.log" >/dev/null || \
  fail 'applied-then-error 回退后未验证公网旧 release'

run_scenario applied-then-error-first-release none failure
test "$(sed -n '1p' "$fixture_root/applied-then-error-first-release/state/active-release")" = none || \
  fail '首次发布故障后 active-release 仍存在'
grep -F -x 'rollback-delete' \
  "$fixture_root/applied-then-error-first-release/state/events.log" >/dev/null || \
  fail '首次发布故障未删除 active-release'
grep -F -x 'public-rollback-503' \
  "$fixture_root/applied-then-error-first-release/state/events.log" >/dev/null || \
  fail '首次发布回退后未验证受控 503'

run_scenario not-applied-error "$previous_release" failure
test "$(sed -n '1p' "$fixture_root/not-applied-error/state/active-release")" = "$previous_release" || \
  fail 'not-applied-error 改变了旧 release'
grep -F 'CAS fence 已推进原 ETag 且 active-release 保持旧状态' \
  "$fixture_root/not-applied-error/stderr.log" >/dev/null || \
  fail 'not-applied-error 未在消费原 ETag 后报告安全失败'
if grep -E '^(public-target|rollback-put|rollback-delete)$' \
  "$fixture_root/not-applied-error/state/events.log" >/dev/null; then
  fail 'not-applied-error 仍执行公网验证或补偿写入'
fi

run_scenario lookup-error "$previous_release" failure
test "$(sed -n '1p' "$fixture_root/lookup-error/state/active-release")" = "$release_id" || \
  fail 'lookup-error 夹具没有保留服务端已应用的未知状态'
test -f "$fixture_root/lookup-error/delivery/kvs-manual-intervention.env" || \
  fail 'lookup-error 未生成受限人工处置证据'
grep -F -x 'STAGE=promotion-reconciliation' \
  "$fixture_root/lookup-error/delivery/kvs-manual-intervention.env" >/dev/null || \
  fail 'lookup-error 人工处置证据未绑定 promotion reconciliation 阶段'
grep -F -x 'ACTION=freeze-and-authoritatively-reconcile' \
  "$fixture_root/lookup-error/delivery/kvs-manual-intervention.env" >/dev/null || \
  fail 'lookup-error 未冻结自动写入并要求权威人工对账'
if grep -E '^(public-target|rollback-put|rollback-delete)$' \
  "$fixture_root/lookup-error/state/events.log" >/dev/null; then
  fail 'lookup-error 在未知状态下继续公网验证或盲目回退'
fi

printf '%s\n' 'AWS Web KVS 模糊成功故障夹具通过。'
