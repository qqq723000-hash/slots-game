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
    AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME=slots-fixture-release-request \
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

invoke_upload_scenario() {
  scenario_root=$1
  scenario=$2
  delivery_name=$3
  static_root="$scenario_root/static"
  extraction_evidence="$scenario_root/extraction"
  delivery_evidence="$scenario_root/$delivery_name"
  mock_bin="$scenario_root/bin"
  state_directory="$scenario_root/state"

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
    AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME=slots-fixture-release-request \
    "$publisher" "$static_root" "$extraction_evidence" \
      "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/web@$web_digest" \
      "$configuration_sha256" "$delivery_evidence" \
      > "$scenario_root/$delivery_name.stdout.log" \
      2> "$scenario_root/$delivery_name.stderr.log"
  publisher_status=$?
  set -e
}

upload_root="$fixture_root/upload-resume"
mkdir -p "$upload_root/static" "$upload_root/extraction" "$upload_root/bin" "$upload_root/state"
ln -s "$mock_command" "$upload_root/bin/aws"
ln -s "$mock_command" "$upload_root/bin/curl"
ln -s "$mock_command" "$upload_root/bin/sleep"
printf '%s\n' 'console.log("fixture");' > "$upload_root/static/app.js"
printf '{"releaseId":"%s"}\n' "$release_id" > "$upload_root/static/release-manifest.json"
printf '%s\n' "$csp" > "$upload_root/extraction/cloudfront-content-security-policy.txt"
{
  printf 'WEB_IMAGE_DIGEST=%s\n' "$web_digest"
  printf 'CONFIGURATION_SHA256=%s\n' "$configuration_sha256"
  printf 'RELEASE_ID=%s\n' "$release_id"
} > "$upload_root/extraction/aws-web-delivery.env"
printf '%s\n' "$previous_release" > "$upload_root/state/active-release"
printf '%s\n' 'etag-before-promotion' > "$upload_root/state/etag"
: > "$upload_root/state/events.log"

invoke_upload_scenario "$upload_root" upload-interrupt delivery-interrupted
test "$publisher_status" -ne 0 || fail '模拟上传中断应失败却成功'
test "$(find "$upload_root/state/s3" -type f -name '*.head.json' | wc -l | tr -d '[:space:]')" -eq 1 || \
  fail '模拟上传中断未精确保留一个已验证对象'
grep -F -x 's3-interrupted' "$upload_root/state/events.log" >/dev/null || \
  fail '模拟上传中断没有命中第二个对象'
if grep -E '^(promotion-put|public-target)$' "$upload_root/state/events.log" >/dev/null; then
  fail '对象上传未完成时仍进入 KVS 或公网切换'
fi

invoke_upload_scenario "$upload_root" upload-resume delivery-resumed
test "$publisher_status" -eq 0 || fail "断点续传应成功，实际退出 $publisher_status"
test "$(find "$upload_root/state/s3" -type f -name '*.head.json' | wc -l | tr -d '[:space:]')" -eq 2 || \
  fail '断点续传后的 S3 对象数量不精确'
app_sha256=$(sha256sum "$upload_root/static/app.js" | awk '{ print $1 }')
app_length=$(wc -c < "$upload_root/static/app.js" | tr -d '[:space:]')
awk -F '\t' -v sha="$app_sha256" -v expected_length="$app_length" '
  $1 == "reconciled" && $2 == "app.js" && $3 == sha && $4 == expected_length { found = 1 }
  END { exit found ? 0 : 1 }
' "$upload_root/delivery-resumed/upload-results.tsv" || \
  fail '断点续传未把已存在且完全一致的对象标记为 reconciled'
manifest_sha256=$(sha256sum "$upload_root/static/release-manifest.json" | awk '{ print $1 }')
manifest_length=$(wc -c < "$upload_root/static/release-manifest.json" | tr -d '[:space:]')
awk -F '\t' -v sha="$manifest_sha256" -v expected_length="$manifest_length" '
  $1 == "created" && $2 == "release-manifest.json" && $3 == sha && $4 == expected_length { found = 1 }
  END { exit found ? 0 : 1 }
' "$upload_root/delivery-resumed/upload-results.tsv" || \
  fail '断点续传未创建缺失对象'

for drift_mode in checksum length release image configuration csp metadata-extra content-type cache encryption kms; do
  drift_root="$fixture_root/upload-drift-$drift_mode"
  mkdir -p "$drift_root"
  cp -R "$upload_root/static" "$drift_root/static"
  cp -R "$upload_root/extraction" "$drift_root/extraction"
  cp -R "$upload_root/state" "$drift_root/state"
  mkdir -p "$drift_root/bin"
  ln -s "$mock_command" "$drift_root/bin/aws"
  ln -s "$mock_command" "$drift_root/bin/curl"
  ln -s "$mock_command" "$drift_root/bin/sleep"
  : > "$drift_root/state/events.log"
  drift_head="$drift_root/state/s3/releases/$release_id/app.js.head.json"
  case "$drift_mode" in
    checksum) drift_filter='.ChecksumSHA256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="' ;;
    length) drift_filter='.ContentLength += 1' ;;
    release) drift_filter='.Metadata["release-id"] = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' ;;
    image) drift_filter='.Metadata["web-image-digest"] = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"' ;;
    configuration) drift_filter='.Metadata["configuration-sha256"] = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"' ;;
    csp) drift_filter='.Metadata["csp-sha256"] = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"' ;;
    metadata-extra) drift_filter='.Metadata["unapproved"] = "value"' ;;
    content-type) drift_filter='.ContentType = "application/octet-stream"' ;;
    cache) drift_filter='.CacheControl = "no-store"' ;;
    encryption) drift_filter='.ServerSideEncryption = "AES256"' ;;
    kms) drift_filter='.SSEKMSKeyId = "arn:aws:kms:ap-southeast-1:123456789012:key/22222222-2222-2222-2222-222222222222"' ;;
    *) fail "未知对象漂移模式：$drift_mode" ;;
  esac
  jq "$drift_filter" "$drift_head" > "$drift_head.tmp"
  mv "$drift_head.tmp" "$drift_head"

  invoke_upload_scenario "$drift_root" "upload-drift-$drift_mode" delivery
  test "$publisher_status" -ne 0 || fail "$drift_mode 对象漂移应失败却成功"
  grep -F '对象身份回读不一致：app.js' "$drift_root/delivery.stderr.log" >/dev/null || \
    fail "$drift_mode 对象漂移没有由完整 HEAD 门禁失败关闭"
  if grep -E '^(promotion-put|public-target)$' "$drift_root/state/events.log" >/dev/null; then
    fail "$drift_mode 对象漂移后仍进入 KVS 或公网切换"
  fi
done

count_drift_root="$fixture_root/upload-drift-object-count"
mkdir -p "$count_drift_root"
cp -R "$upload_root/static" "$count_drift_root/static"
cp -R "$upload_root/extraction" "$count_drift_root/extraction"
cp -R "$upload_root/state" "$count_drift_root/state"
mkdir -p "$count_drift_root/bin"
ln -s "$mock_command" "$count_drift_root/bin/aws"
ln -s "$mock_command" "$count_drift_root/bin/curl"
ln -s "$mock_command" "$count_drift_root/bin/sleep"
: > "$count_drift_root/state/events.log"
cp "$count_drift_root/state/s3/releases/$release_id/app.js.head.json" \
  "$count_drift_root/state/s3/releases/$release_id/unexpected.js.head.json"
invoke_upload_scenario "$count_drift_root" upload-drift-object-count delivery
test "$publisher_status" -ne 0 || fail 'release 前缀额外对象应失败却成功'
grep -F 'S3 对象数量与已验证静态根不一致' "$count_drift_root/delivery.stderr.log" >/dev/null || \
  fail 'release 前缀额外对象没有由精确数量门禁失败关闭'
if grep -E '^(promotion-put|public-target)$' "$count_drift_root/state/events.log" >/dev/null; then
  fail 'release 前缀额外对象后仍进入 KVS 或公网切换'
fi

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

for unsafe_distribution_scenario in \
  cloudfront-lambda-association \
  cloudfront-extra-cache-behavior \
  cloudfront-extra-function-association
do
  run_scenario "$unsafe_distribution_scenario" "$previous_release" failure
  if grep -E '^(public-target|rollback-put|rollback-delete)$' \
    "$fixture_root/$unsafe_distribution_scenario/state/events.log" >/dev/null; then
    fail "$unsafe_distribution_scenario 在 distribution 门禁失败后仍进入公网切换或补偿"
  fi
done

printf '%s\n' 'AWS Web KVS 模糊成功故障夹具通过。'
