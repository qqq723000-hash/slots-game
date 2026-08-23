#!/bin/sh

# 调用方必须先验证并拉取 Web digest；本脚本只写全新的不可变前缀，再调用固定版本切换接口。
set -eu
umask 077

fail() {
  printf '%s\n' "AWS Web 发布失败：$*" >&2
  exit 1
}

test "$#" -eq 5 || fail '必须传入静态根、提取证据、Web 镜像引用、配置摘要和发布证据目录'
static_root=$1
extraction_evidence=$2
web_image_reference=$3
configuration_sha256=$4
delivery_evidence=$5

for command_name in aws jq sha256sum find sort grep curl node sed wc tr awk sleep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"
done
for variable_name in AWS_ACCOUNT_ID AWS_REGION AWS_WEB_BUCKET AWS_WEB_KMS_KEY_ARN AWS_CLOUDFRONT_DISTRIBUTION_ID \
  AWS_CLOUDFRONT_DOMAIN_NAME AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID \
  AWS_CLOUDFRONT_KVS_ARN AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME; do
  variable_value=$(printenv "$variable_name" 2>/dev/null || true)
  test -n "$variable_value" || fail "$variable_name 未配置"
done

test -d "$static_root" || fail '静态根不存在'
test -f "$static_root/release-manifest.json" || fail 'release-manifest.json 不存在'
test -f "$extraction_evidence/cloudfront-content-security-policy.txt" || fail 'CSP 证据不存在'
test -f "$extraction_evidence/aws-web-delivery.env" || fail '提取身份记录不存在'
test ! -e "$delivery_evidence" || fail '发布证据目录必须尚不存在'
mkdir -m 0700 "$delivery_evidence"

release_id=$(jq -er '.releaseId | select(test("^sha256:[0-9a-f]{64}$"))' \
  "$static_root/release-manifest.json") || fail 'release ID 格式错误'
web_digest=${web_image_reference##*@}
test "$web_image_reference" != "$web_digest" || fail 'Web 镜像引用必须包含仓库和摘要'
printf '%s\n' "$web_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail 'Web 镜像摘要格式错误'
printf '%s\n' "$configuration_sha256" | grep -Eq '^[0-9a-f]{64}$' || fail '配置摘要格式错误'
grep -F -x "WEB_IMAGE_DIGEST=$web_digest" "$extraction_evidence/aws-web-delivery.env" >/dev/null || \
  fail '提取证据中的 Web 摘要不一致'
grep -F -x "CONFIGURATION_SHA256=$configuration_sha256" "$extraction_evidence/aws-web-delivery.env" >/dev/null || \
  fail '提取证据中的配置摘要不一致'
grep -F -x "RELEASE_ID=$release_id" "$extraction_evidence/aws-web-delivery.env" >/dev/null || \
  fail '提取证据中的 release ID 不一致'

csp=$(sed -n '1p' "$extraction_evidence/cloudfront-content-security-policy.txt")
test "$(wc -l < "$extraction_evidence/cloudfront-content-security-policy.txt" | tr -d ' ')" -eq 1 || \
  fail 'CSP 必须只有一行'
test -n "$csp" || fail 'CSP 为空'
csp_sha256=$(sha256sum "$extraction_evidence/cloudfront-content-security-policy.txt" | awk '{ print $1 }')

release_prefix="releases/${release_id}/"
existing_count=$(aws s3api list-objects-v2 --bucket "$AWS_WEB_BUCKET" --prefix "$release_prefix" \
  --max-keys 1 --query "length(Contents || \`[]\`)" --output text)
test "$existing_count" = 0 || fail '不可变 release 前缀已经存在'

content_type_for() {
  case "$1" in
    *.html) printf '%s\n' 'text/html; charset=utf-8' ;;
    *.css) printf '%s\n' 'text/css; charset=utf-8' ;;
    *.js|*.mjs) printf '%s\n' 'text/javascript; charset=utf-8' ;;
    *.json) printf '%s\n' 'application/json; charset=utf-8' ;;
    *.svg) printf '%s\n' 'image/svg+xml' ;;
    *.png) printf '%s\n' 'image/png' ;;
    *.avif) printf '%s\n' 'image/avif' ;;
    *.jpg|*.jpeg) printf '%s\n' 'image/jpeg' ;;
    *.webp) printf '%s\n' 'image/webp' ;;
    *.ico) printf '%s\n' 'image/vnd.microsoft.icon' ;;
    *.woff) printf '%s\n' 'font/woff' ;;
    *.woff2) printf '%s\n' 'font/woff2' ;;
    *.mp3) printf '%s\n' 'audio/mpeg' ;;
    *.m4a) printf '%s\n' 'audio/mp4' ;;
    *.ogg) printf '%s\n' 'audio/ogg' ;;
    *.wasm) printf '%s\n' 'application/wasm' ;;
    *.atlas|*.fnt|*.txt) printf '%s\n' 'text/plain; charset=utf-8' ;;
    *.skel) printf '%s\n' 'application/octet-stream' ;;
    *) return 1 ;;
  esac
}

cache_control_for() {
  case "$1" in
    index.html|release-manifest.json) printf '%s\n' 'public,max-age=0,must-revalidate' ;;
    *) printf '%s\n' 'public,max-age=31536000,immutable' ;;
  esac
}

file_list="$delivery_evidence/uploaded-files.txt"
(cd "$static_root" && find . -type f -print | LC_ALL=C sort) > "$file_list"
test -s "$file_list" || fail '静态根没有普通文件'
local_count=0
while IFS= read -r relative_path; do
  relative_path=${relative_path#./}
  test -n "$relative_path" || fail '发现空文件路径'
  case "$relative_path" in *..*|/*) fail '发现不安全文件路径' ;; esac
  object_key="${release_prefix}${relative_path}"
  content_type=$(content_type_for "$relative_path") || fail "发现未审批的静态文件扩展名：$relative_path"
  cache_control=$(cache_control_for "$relative_path")
  aws s3api put-object --bucket "$AWS_WEB_BUCKET" --key "$object_key" \
    --body "$static_root/$relative_path" --content-type "$content_type" \
    --cache-control "$cache_control" --if-none-match '*' \
    --metadata "release-id=${release_id},web-image-digest=${web_digest},configuration-sha256=${configuration_sha256},csp-sha256=${csp_sha256}" \
    --server-side-encryption aws:kms --ssekms-key-id "$AWS_WEB_KMS_KEY_ARN" >/dev/null
  head_json=$(aws s3api head-object --bucket "$AWS_WEB_BUCKET" --key "$object_key" --output json)
  printf '%s\n' "$head_json" | jq -e \
    --arg release "$release_id" --arg image "$web_digest" --arg configuration "$configuration_sha256" \
    --arg csp_sha "$csp_sha256" --arg content_type "$content_type" --arg cache "$cache_control" \
    --arg kms_key "$AWS_WEB_KMS_KEY_ARN" '
      .Metadata["release-id"] == $release and
      .Metadata["web-image-digest"] == $image and
      .Metadata["configuration-sha256"] == $configuration and
      .Metadata["csp-sha256"] == $csp_sha and
      .ContentType == $content_type and .CacheControl == $cache and
      .ServerSideEncryption == "aws:kms" and .SSEKMSKeyId == $kms_key
    ' >/dev/null || fail "对象元数据回读不一致：$relative_path"
  local_count=$((local_count + 1))
done < "$file_list"

remote_count=$(aws s3api list-objects-v2 --bucket "$AWS_WEB_BUCKET" --prefix "$release_prefix" \
  --query "length(Contents || \`[]\`)" --output text)
test "$remote_count" = "$local_count" || fail 'S3 对象数量与已验证静态根不一致'

policy_json="$delivery_evidence/response-headers-policy.json"
aws cloudfront get-response-headers-policy-config \
  --id "$AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID" --output json > "$policy_json"
policy_etag=$(jq -er '.ETag | select(test("^[A-Za-z0-9_-]+$"))' "$policy_json") || \
  fail '无法取得 Response Headers Policy ETag'
jq -e --arg csp "$csp" --arg etag "$policy_etag" '
  .ETag == $etag and
  .ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.Override == true and
  .ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy == $csp
' "$policy_json" >/dev/null || fail 'Terraform 管理的 CloudFront CSP 与 Web digest 不一致'

distribution_before=$(aws cloudfront get-distribution-config \
  --id "$AWS_CLOUDFRONT_DISTRIBUTION_ID" --output json)
distribution_etag_before=$(printf '%s\n' "$distribution_before" | \
  jq -er '.ETag | select(test("^[A-Za-z0-9_-]+$"))') || fail '无法取得 CloudFront distribution ETag'
router_function_arn="arn:aws:cloudfront::${AWS_ACCOUNT_ID}:function/${AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME}"
expected_origin="${AWS_WEB_BUCKET}.s3.${AWS_REGION}.amazonaws.com"
printf '%s\n' "$distribution_before" | jq -e \
  --arg policy "$AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID" --arg router "$router_function_arn" \
  --arg origin "$expected_origin" '
    .DistributionConfig.Enabled == true and
    .DistributionConfig.DefaultRootObject == "index.html" and
    .DistributionConfig.Origins.Quantity == 1 and
    .DistributionConfig.Origins.Items[0].Id == "private-web-s3" and
    .DistributionConfig.Origins.Items[0].DomainName == $origin and
    .DistributionConfig.Origins.Items[0].OriginPath == "" and
    (.DistributionConfig.Origins.Items[0].OriginAccessControlId | type == "string" and length > 0) and
    .DistributionConfig.DefaultCacheBehavior.TargetOriginId == "private-web-s3" and
    .DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId == $policy and
    ([.DistributionConfig.DefaultCacheBehavior.FunctionAssociations.Items[]? |
      select(.EventType == "viewer-request" and .FunctionARN == $router)] | length) == 1 and
    ([.DistributionConfig.CacheBehaviors.Items[]? |
      select(.PathPattern == "releases/*" and .TargetOriginId == "private-web-s3" and
        .ResponseHeadersPolicyId == $policy)] | length) == 1
  ' >/dev/null || fail 'CloudFront distribution 未绑定固定私有 S3 origin、受控 CSP 或 viewer-request router'

distribution_json=$(aws cloudfront get-distribution --id "$AWS_CLOUDFRONT_DISTRIBUTION_ID" --output json)
printf '%s\n' "$distribution_json" | jq -e --arg etag "$distribution_etag_before" \
  --arg domain "$AWS_CLOUDFRONT_DOMAIN_NAME" '
    .ETag == $etag and .Distribution.Status == "Deployed" and .Distribution.DomainName == $domain
  ' >/dev/null || fail 'CloudFront distribution 域名、状态或 ETag 不一致'

router_json=$(aws cloudfront describe-function --name "$AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME" \
  --stage LIVE --output json)
printf '%s\n' "$router_json" | jq -e --arg router "$router_function_arn" \
  --arg kvs "$AWS_CLOUDFRONT_KVS_ARN" '
    .FunctionSummary.FunctionMetadata.FunctionARN == $router and
    .FunctionSummary.FunctionMetadata.Stage == "LIVE" and
    .FunctionSummary.FunctionConfig.Runtime == "cloudfront-js-2.0" and
    .FunctionSummary.FunctionConfig.KeyValueStoreAssociations.Quantity == 1 and
    .FunctionSummary.FunctionConfig.KeyValueStoreAssociations.Items[0].KeyValueStoreARN == $kvs
  ' >/dev/null || fail 'LIVE router function 与固定 KeyValueStore 关联不一致'

verify_csp_header() {
  headers_file=$1
  HEADERS_FILE="$headers_file" EXPECTED_CSP="$csp" node -e '
    const { readFileSync } = require("node:fs");
    const lines = readFileSync(process.env.HEADERS_FILE, "utf8").split(/\r?\n/);
    const values = lines.filter((line) => /^content-security-policy\s*:/i.test(line))
      .map((line) => line.replace(/^[^:]+:\s*/, ""));
    if (values.length !== 1 || values[0] !== process.env.EXPECTED_CSP) process.exit(1);
  '
}

preview_headers="$delivery_evidence/release-preview-headers.txt"
preview_manifest="$delivery_evidence/release-preview-manifest.json"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --retry 4 \
  --dump-header "$preview_headers" \
  --output "$preview_manifest" \
  "https://${AWS_CLOUDFRONT_DOMAIN_NAME}/${release_prefix}release-manifest.json"
test "$(sha256sum "$preview_manifest" | awk '{ print $1 }')" = \
  "$(sha256sum "$static_root/release-manifest.json" | awk '{ print $1 }')" || \
  fail 'CloudFront 不可变 release 预览字节与上传内容不一致'
verify_csp_header "$preview_headers" || fail 'CloudFront 不可变 release 预览 CSP 不一致'

kvs_before="$delivery_evidence/kvs-before.json"
aws cloudfront-keyvaluestore describe-key-value-store \
  --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" --output json > "$kvs_before"
kvs_etag_before=$(jq -er --arg arn "$AWS_CLOUDFRONT_KVS_ARN" '
  select(.KvsARN == $arn and .Status == "READY") | .ETag | select(test("^[A-Za-z0-9_-]+$"))
' "$kvs_before") || fail 'CloudFront KeyValueStore 尚未 READY 或 ARN 不一致'

keys_before="$delivery_evidence/kvs-keys-before.json"
aws cloudfront-keyvaluestore list-keys --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
  --output json > "$keys_before"
previous_count=$(jq '[.Items[]? | select(.Key == "active-release")] | length' "$keys_before")
case "$previous_count" in
  0) previous_release=none ;;
  1)
    previous_release=$(jq -er '.Items[] | select(.Key == "active-release") | .Value |
      select(test("^sha256:[0-9a-f]{64}$"))' "$keys_before") || \
      fail 'active-release 旧值不是规范 release ID'
    ;;
  *) fail 'KeyValueStore 中存在重复 active-release' ;;
esac

manual_intervention() {
  intervention_stage=$1
  intervention_reason=$2
  observed_release=${3:-unknown}
  intervention_file="$delivery_evidence/kvs-manual-intervention.env"
  {
    printf 'SCHEMA=%s\n' 'slots-game/web-release-manual-intervention/v1'
    printf 'STAGE=%s\n' "$intervention_stage"
    printf 'RELEASE_ID=%s\n' "$release_id"
    printf 'PREVIOUS_RELEASE=%s\n' "$previous_release"
    printf 'OBSERVED_ACTIVE_RELEASE=%s\n' "$observed_release"
    printf 'ACTION=%s\n' 'freeze-and-authoritatively-reconcile'
  } > "$intervention_file"
  chmod 0600 "$intervention_file"
  fail "$intervention_reason；状态未被安全证明，已停止自动写入，需要立即人工处置"
}

# get-key 是第一权威读；仅当 key 不存在或该读取失败时，再用完整 list-keys 区分
# “确实没有 active-release”和“控制面不可读”。任何重复、畸形或双重读取失败都返回未知。
read_active_release_authoritatively() {
  authoritative_output=$1
  authoritative_error="${authoritative_output%.json}.stderr"
  authoritative_list="${authoritative_output%.json}-list.json"
  authoritative_active_release=unknown
  if aws cloudfront-keyvaluestore get-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
    --key active-release --output json > "$authoritative_output" 2> "$authoritative_error"; then
    authoritative_active_release=$(jq -er '
      select(.Key == "active-release") | .Value |
      select(test("^sha256:[0-9a-f]{64}$"))
    ' "$authoritative_output") || return 1
    return 0
  fi
  if ! aws cloudfront-keyvaluestore list-keys --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
    --output json > "$authoritative_list" 2>> "$authoritative_error"; then
    return 1
  fi
  authoritative_count=$(jq -er '
    (.Items // []) as $items |
    select(($items | type) == "array") |
    [$items[] | select(.Key == "active-release")] | length
  ' "$authoritative_list") || return 1
  case "$authoritative_count" in
    0) authoritative_active_release=none ;;
    1)
      authoritative_active_release=$(jq -er '
        (.Items // [])[] | select(.Key == "active-release") | .Value |
        select(test("^sha256:[0-9a-f]{64}$"))
      ' "$authoritative_list") || return 1
      ;;
    *) authoritative_active_release=unknown; return 1 ;;
  esac
}

read_ready_kvs_etag() {
  ready_output=$1
  ready_error="${ready_output%.json}.stderr"
  authoritative_kvs_etag=unknown
  if ! aws cloudfront-keyvaluestore describe-key-value-store \
    --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" --output json > "$ready_output" 2> "$ready_error"; then
    return 1
  fi
  authoritative_kvs_etag=$(jq -er --arg arn "$AWS_CLOUDFRONT_KVS_ARN" '
    select(.KvsARN == $arn and .Status == "READY") | .ETag |
    select(test("^[A-Za-z0-9_-]+$"))
  ' "$ready_output") || return 1
}

is_previous_release() {
  test "$1" = "$previous_release"
}

write_promotion_status() {
  {
    printf 'PROMOTION_COMMAND_STATUS=%s\n' "$promotion_command_status"
    printf 'PROMOTION_FENCE_STATUS=%s\n' "$promotion_fence_status"
    printf 'KVS_ETAG_BEFORE=%s\n' "$kvs_etag_before"
    printf 'KVS_ETAG_AFTER=%s\n' "${kvs_etag_after:-unknown}"
    printf 'OBSERVED_ACTIVE_RELEASE=%s\n' "${authoritative_active_release:-unknown}"
  } > "$delivery_evidence/kvs-promotion-status.env"
  chmod 0600 "$delivery_evidence/kvs-promotion-status.env"
}

promotion_json="$delivery_evidence/kvs-promotion.json"
promotion_stderr="$delivery_evidence/kvs-promotion.stderr"
promotion_command_status=success
promotion_fence_status=not-required
if aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
  --if-match "$kvs_etag_before" --key active-release --value "$release_id" \
  --output json > "$promotion_json" 2> "$promotion_stderr"; then
  if ! kvs_etag_after=$(jq -er '.ETag | select(test("^[A-Za-z0-9_-]+$"))' \
    "$promotion_json"); then
    promotion_command_status=invalid-response
  fi
else
  promotion_command_status=error
fi

# CLI 非零或响应损坏并不证明服务端未写入。一次立即回读到旧值也不能证明超时请求
# 不会稍后提交，因此必须用原 ETag 做一次 CAS fence，并只读对账到 ETag 确认推进。
active_json="$delivery_evidence/kvs-active-after.json"
if ! read_active_release_authoritatively "$active_json"; then
  manual_intervention promotion-reconciliation \
    'KVS 切换后无法权威读取 active-release' unknown
fi

if test "$promotion_command_status" != success && \
  is_previous_release "$authoritative_active_release"; then
  ambiguous_kvs="$delivery_evidence/kvs-ambiguous-before-fence.json"
  if ! read_ready_kvs_etag "$ambiguous_kvs"; then
    manual_intervention promotion-fence \
      '切换结果不确定且无法读取 CAS fence 前的 READY KVS ETag' \
      "$authoritative_active_release"
  fi

  if test "$authoritative_kvs_etag" = "$kvs_etag_before"; then
    promotion_fence_json="$delivery_evidence/kvs-promotion-fence.json"
    promotion_fence_stderr="$delivery_evidence/kvs-promotion-fence.stderr"
    promotion_fence_status=success
    if test "$previous_release" = none; then
      # 首次发布没有可写回的旧值；用相同目标重试消费原 ETag，随后仍必须权威对账。
      if ! aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
        --if-match "$kvs_etag_before" --key active-release --value "$release_id" \
        --output json > "$promotion_fence_json" 2> "$promotion_fence_stderr"; then
        promotion_fence_status=error-reconcile-required
      fi
    elif ! aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
      --if-match "$kvs_etag_before" --key active-release --value "$previous_release" \
      --output json > "$promotion_fence_json" 2> "$promotion_fence_stderr"; then
      # 条件写回旧值会推进 ETag；原超时请求随后只能收到 precondition failure。
      promotion_fence_status=error-reconcile-required
    fi
  else
    promotion_fence_status=etag-already-advanced
  fi

  fence_resolved=false
  fence_attempt=1
  while test "$fence_attempt" -le 30; do
    fence_active="$delivery_evidence/kvs-active-after-fence-${fence_attempt}.json"
    if ! read_active_release_authoritatively "$fence_active"; then
      manual_intervention promotion-fence \
        'CAS fence 后无法权威读取 active-release，拒绝继续自动写入' unknown
    fi
    fence_kvs="$delivery_evidence/kvs-after-fence-${fence_attempt}.json"
    if ! read_ready_kvs_etag "$fence_kvs"; then
      manual_intervention promotion-fence \
        'CAS fence 后无法读取 READY KVS ETag，拒绝继续自动写入' \
        "$authoritative_active_release"
    fi
    if test "$authoritative_kvs_etag" != "$kvs_etag_before"; then
      fence_release_first=$authoritative_active_release
      fence_etag_first=$authoritative_kvs_etag
      # Key 与 store ETag 是两个 API；二次读取相同 pair，防止迟到写恰好落在两次读取之间。
      fence_confirm_active="$delivery_evidence/kvs-active-after-fence-${fence_attempt}-confirm.json"
      if ! read_active_release_authoritatively "$fence_confirm_active"; then
        manual_intervention promotion-fence \
          'CAS fence 确认读无法取得 active-release，拒绝使用撕裂快照' unknown
      fi
      fence_release_confirm=$authoritative_active_release
      fence_confirm_kvs="$delivery_evidence/kvs-after-fence-${fence_attempt}-confirm.json"
      if ! read_ready_kvs_etag "$fence_confirm_kvs"; then
        manual_intervention promotion-fence \
          'CAS fence 确认读无法取得 READY KVS ETag，拒绝使用撕裂快照' \
          "$fence_release_confirm"
      fi
      fence_etag_confirm=$authoritative_kvs_etag
      if test "$fence_release_first" = "$fence_release_confirm" && \
        test "$fence_etag_first" = "$fence_etag_confirm"; then
        fence_resolved=true
        break
      fi
    fi
    fence_attempt=$((fence_attempt + 1))
    sleep 2
  done
  test "$fence_resolved" = true || \
    manual_intervention promotion-fence \
      'CAS fence 在时限内未推进原 ETag，迟到写入风险仍未消除' \
      "$authoritative_active_release"

  kvs_etag_after=$authoritative_kvs_etag
  if is_previous_release "$authoritative_active_release"; then
    promotion_command_status="${promotion_command_status}-fenced-not-applied"
    write_promotion_status
    fail 'KVS 切换命令结果不确定，但 CAS fence 已推进原 ETag 且 active-release 保持旧状态；迟到写入已被阻断'
  fi
  if test "$authoritative_active_release" != "$release_id"; then
    manual_intervention promotion-fence \
      'CAS fence 推进后 active-release 既不是目标 release 也不是保存的旧状态' \
      "$authoritative_active_release"
  fi
fi

if test "$authoritative_active_release" != "$release_id"; then
  manual_intervention promotion-reconciliation \
    'KVS 切换响应与权威 active-release 不一致，不能证明本次发布拥有当前状态' \
    "$authoritative_active_release"
fi

kvs_after="$delivery_evidence/kvs-after.json"
if ! read_ready_kvs_etag "$kvs_after"; then
  manual_intervention promotion-reconciliation \
    'active-release 已是目标 release，但无法取得 READY KVS ETag' "$release_id"
fi
if test "$promotion_command_status" = success; then
  test "$authoritative_kvs_etag" = "$kvs_etag_after" || \
    manual_intervention promotion-reconciliation \
      'KVS 切换响应 ETag 与权威状态不一致，可能存在并发写入' "$release_id"
else
  kvs_etag_after=$authoritative_kvs_etag
  promotion_command_status="${promotion_command_status}-reconciled-applied"
fi

write_promotion_status

promotion_valid=true

public_headers="$delivery_evidence/public-root-headers.txt"
public_manifest="$delivery_evidence/public-root-manifest.json"
public_ready=false
attempt=1
while test "$attempt" -le 30; do
  if curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --dump-header "$public_headers" --output "$public_manifest" \
    "https://${AWS_CLOUDFRONT_DOMAIN_NAME}/release-manifest.json?release-check=${release_id#sha256:}" &&
    jq -e --arg release "$release_id" '.releaseId == $release' "$public_manifest" >/dev/null 2>&1 &&
    verify_csp_header "$public_headers"; then
    public_ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 10
done
test "$public_ready" = true || promotion_valid=false

if test "$promotion_valid" != true; then
  pre_rollback_active="$delivery_evidence/kvs-active-before-rollback.json"
  if ! read_active_release_authoritatively "$pre_rollback_active"; then
    manual_intervention rollback-precondition \
      '公网验证失败后无法权威确认 active-release，拒绝盲目回退' unknown
  fi
  if test "$authoritative_active_release" != "$release_id"; then
    if is_previous_release "$authoritative_active_release"; then
      manual_intervention rollback-precondition \
        '公网验证期间 active-release 已被恢复或并发修改，自动发布不拥有当前 ETag' \
        "$authoritative_active_release"
    fi
    manual_intervention rollback-precondition \
      '公网验证失败且 active-release 已变为其他 release，拒绝覆盖并发状态' \
      "$authoritative_active_release"
  fi

  pre_rollback_kvs="$delivery_evidence/kvs-before-rollback.json"
  if ! read_ready_kvs_etag "$pre_rollback_kvs"; then
    manual_intervention rollback-precondition \
      '公网验证失败且无法取得自动回退 ETag' "$release_id"
  fi
  latest_etag=$authoritative_kvs_etag
  test "$latest_etag" = "$kvs_etag_after" || \
    manual_intervention rollback-precondition \
      '发布验证失败且 KVS 已被并发修改，拒绝覆盖新状态' "$release_id"

  rollback_json="$delivery_evidence/kvs-rollback.json"
  rollback_stderr="$delivery_evidence/kvs-rollback.stderr"
  rollback_command_status=success
  if test "$previous_release" = none; then
    if ! aws cloudfront-keyvaluestore delete-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
      --if-match "$latest_etag" --key active-release --output json > \
      "$rollback_json" 2> "$rollback_stderr"; then
      rollback_command_status=error
    fi
  elif ! aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN" \
    --if-match "$latest_etag" --key active-release --value "$previous_release" \
    --output json > "$rollback_json" 2> "$rollback_stderr"; then
    rollback_command_status=error
  fi
  if test "$rollback_command_status" = success; then
    if ! rollback_etag=$(jq -er '.ETag | select(test("^[A-Za-z0-9_-]+$"))' \
      "$rollback_json"); then
      rollback_command_status=invalid-response
    fi
  fi

  rollback_active="$delivery_evidence/kvs-active-after-rollback.json"
  if ! read_active_release_authoritatively "$rollback_active"; then
    manual_intervention rollback-reconciliation \
      '回退命令完成后无法权威读取 active-release，拒绝再次写入' unknown
  fi
  if ! is_previous_release "$authoritative_active_release"; then
    manual_intervention rollback-reconciliation \
      '回退命令未恢复保存的旧状态，拒绝重试或覆盖当前状态' \
      "$authoritative_active_release"
  fi

  rollback_state="$delivery_evidence/kvs-after-rollback.json"
  if ! read_ready_kvs_etag "$rollback_state"; then
    manual_intervention rollback-reconciliation \
      'active-release 已恢复旧状态，但无法取得 READY KVS ETag' \
      "$authoritative_active_release"
  fi
  if test "$rollback_command_status" = success; then
    test "$authoritative_kvs_etag" = "$rollback_etag" || \
      manual_intervention rollback-reconciliation \
        '自动回退响应 ETag 与权威状态不一致' "$authoritative_active_release"
  else
    test "$authoritative_kvs_etag" != "$latest_etag" || \
      manual_intervention rollback-reconciliation \
        '回退响应不确定且 KVS ETag 未推进，不能证明迟到回退是否仍在途' \
        "$authoritative_active_release"
    rollback_etag=$authoritative_kvs_etag
    rollback_command_status="${rollback_command_status}-reconciled-applied"
  fi

  {
    printf 'ROLLBACK_COMMAND_STATUS=%s\n' "$rollback_command_status"
    printf 'ROLLBACK_ETAG=%s\n' "$rollback_etag"
    printf 'RESTORED_ACTIVE_RELEASE=%s\n' "$authoritative_active_release"
  } > "$delivery_evidence/kvs-rollback-status.env"
  chmod 0600 "$delivery_evidence/kvs-rollback-status.env"

  rollback_headers="$delivery_evidence/public-rollback-headers.txt"
  rollback_body="$delivery_evidence/public-rollback-body.txt"
  rollback_public_ready=false
  attempt=1
  while test "$attempt" -le 30; do
    if test "$previous_release" = none; then
      rollback_status=$(curl --silent --show-error --proto '=https' --tlsv1.2 \
        --dump-header "$rollback_headers" --output "$rollback_body" --write-out '%{http_code}' \
        "https://${AWS_CLOUDFRONT_DOMAIN_NAME}/release-manifest.json?rollback-check=${release_id#sha256:}") || \
        rollback_status=''
      if test "$rollback_status" = 503 && \
        grep -F -x 'release is not ready' "$rollback_body" >/dev/null 2>&1; then
        rollback_public_ready=true
        break
      fi
    elif curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --dump-header "$rollback_headers" --output "$rollback_body" \
      "https://${AWS_CLOUDFRONT_DOMAIN_NAME}/release-manifest.json?rollback-check=${release_id#sha256:}" && \
      jq -e --arg release "$previous_release" '.releaseId == $release' \
        "$rollback_body" >/dev/null 2>&1 && \
      verify_csp_header "$rollback_headers"; then
      rollback_public_ready=true
      break
    fi
    attempt=$((attempt + 1))
    sleep 10
  done
  test "$rollback_public_ready" = true || \
    fail 'KVS 已回退但 CloudFront 公网读路径未在时限内恢复，需要立即人工处置'
  fail 'KVS 切换后的 API 或公网回读失败，已按 ETag 回退并确认公网恢复原 active-release'
fi

{
  printf 'RELEASE_ID=%s\n' "$release_id"
  printf 'RELEASE_PREFIX=%s\n' "$release_prefix"
  printf 'WEB_IMAGE=%s\n' "$web_image_reference"
  printf 'CONFIGURATION_SHA256=%s\n' "$configuration_sha256"
  printf 'CLOUDFRONT_CSP_SHA256=%s\n' "$csp_sha256"
  printf 'RESPONSE_HEADERS_POLICY_ETAG=%s\n' "$policy_etag"
  printf 'DISTRIBUTION_ETAG=%s\n' "$distribution_etag_before"
  printf 'ROUTER_FUNCTION_ARN=%s\n' "$router_function_arn"
  printf 'KVS_ARN=%s\n' "$AWS_CLOUDFRONT_KVS_ARN"
  printf 'KVS_ETAG_BEFORE=%s\n' "$kvs_etag_before"
  printf 'KVS_ETAG_AFTER=%s\n' "$kvs_etag_after"
  printf 'PREVIOUS_RELEASE=%s\n' "$previous_release"
} > "$delivery_evidence/web-release.env"
chmod 0600 "$delivery_evidence/web-release.env"

printf '%s\n' "Web release $release_id 已写入不可变前缀并通过 KVS ETag 切换接口发布。"
