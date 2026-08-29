#!/bin/sh

# 由 test-web-release-switch-faults.sh 通过 aws/curl/sleep 三个符号链接调用。
# English: Called by test-web-release-switch-faults.sh through three aws/curl/sleep symbolic links.
set -eu

fail() {
  printf '%s\n' "Web release mock 失败：$*" >&2
  exit 97
}

test -n "${MOCK_WEB_STATE_DIRECTORY:-}" || fail 'MOCK_WEB_STATE_DIRECTORY 未配置'
test -n "${MOCK_WEB_SCENARIO:-}" || fail 'MOCK_WEB_SCENARIO 未配置'

state_file="$MOCK_WEB_STATE_DIRECTORY/active-release"
etag_file="$MOCK_WEB_STATE_DIRECTORY/etag"
events_file="$MOCK_WEB_STATE_DIRECTORY/events.log"
promotion_attempted="$MOCK_WEB_STATE_DIRECTORY/promotion-attempted"
delayed_promotion_pending="$MOCK_WEB_STATE_DIRECTORY/delayed-promotion-pending"
s3_directory="$MOCK_WEB_STATE_DIRECTORY/s3"

command_name=${0##*/}

argument_value() {
  requested_name=$1
  shift
  while test "$#" -gt 0; do
    if test "$1" = "$requested_name"; then
      test "$#" -ge 2 || fail "$requested_name 缺少参数值"
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

has_argument() {
  requested_name=$1
  shift
  for argument in "$@"; do
    test "$argument" = "$requested_name" && return 0
  done
  return 1
}

metadata_value() {
  requested_name=$1
  metadata=$2
  printf '%s\n' "$metadata" | tr ',' '\n' | sed -n "s/^${requested_name}=//p"
}

read_active_release() {
  test -f "$state_file" || fail 'active-release 状态文件不存在'
  sed -n '1p' "$state_file"
}

write_active_release() {
  printf '%s\n' "$1" > "$state_file"
  printf '%s\n' "$2" > "$etag_file"
}

case "$command_name" in
  sleep)
    exit 0
    ;;
  curl)
    output_file=$(argument_value --output "$@") || fail 'curl 缺少 --output'
    headers_file=$(argument_value --dump-header "$@") || fail 'curl 缺少 --dump-header'
    write_out=$(argument_value --write-out "$@" 2>/dev/null || true)
    request_url=
    for argument in "$@"; do
      case "$argument" in https://*) request_url=$argument ;; esac
    done
    test -n "$request_url" || fail 'curl 缺少 HTTPS URL'

    case "$request_url" in
      */releases/*/release-manifest.json)
        printf 'content-security-policy: %s\r\n\r\n' "$MOCK_WEB_CSP" > "$headers_file"
        printf '{"releaseId":"%s"}\n' "$MOCK_WEB_RELEASE_ID" > "$output_file"
        printf '%s\n' 'immutable-preview' >> "$events_file"
        ;;
      *release-check=*)
        printf '%s\n' 'public-target' >> "$events_file"
        printf 'content-security-policy: %s\r\n\r\n' "$MOCK_WEB_CSP" > "$headers_file"
        case "$MOCK_WEB_SCENARIO" in
          applied-then-error-public-failure|applied-then-error-first-release)
            printf '{"releaseId":"sha256:%064d"}\n' 0 > "$output_file"
            ;;
          *) printf '{"releaseId":"%s"}\n' "$MOCK_WEB_RELEASE_ID" > "$output_file" ;;
        esac
        ;;
      *rollback-check=*)
        active_release=$(read_active_release)
        if test "$active_release" = none; then
          printf '%s\n' 'public-rollback-503' >> "$events_file"
          printf 'content-type: text/plain\r\n\r\n' > "$headers_file"
          printf '%s\n' 'release is not ready' > "$output_file"
          test "$write_out" = '%{http_code}' && printf '%s' 503
        else
          printf '%s\n' 'public-rollback-release' >> "$events_file"
          printf 'content-security-policy: %s\r\n\r\n' "$MOCK_WEB_CSP" > "$headers_file"
          printf '{"releaseId":"%s"}\n' "$active_release" > "$output_file"
        fi
        ;;
      *) fail "未知 curl URL：$request_url" ;;
    esac
    exit 0
    ;;
  aws)
    test "$#" -ge 2 || fail 'aws mock 缺少 service/operation'
    service=$1
    operation=$2
    shift 2
    case "$service/$operation" in
      s3api/list-objects-v2)
        prefix=$(argument_value --prefix "$@") || fail 'list-objects-v2 缺少 --prefix'
        prefix_directory="$s3_directory/$prefix"
        if test -d "$prefix_directory"; then
          object_count=$(find "$prefix_directory" -type f -name '*.head.json' | wc -l | tr -d '[:space:]')
        else
          object_count=0
        fi
        jq -n --argjson count "$object_count" '{Contents: [range(0; $count) | {Key: tostring}]}'
        ;;
      s3api/put-object)
        key=$(argument_value --key "$@") || fail 'put-object 缺少 --key'
        body=$(argument_value --body "$@") || fail 'put-object 缺少 --body'
        content_type=$(argument_value --content-type "$@") || fail 'put-object 缺少 --content-type'
        cache_control=$(argument_value --cache-control "$@") || fail 'put-object 缺少 --cache-control'
        checksum_algorithm=$(argument_value --checksum-algorithm "$@") || \
          fail 'put-object 缺少 --checksum-algorithm'
        checksum_sha256=$(argument_value --checksum-sha256 "$@") || \
          fail 'put-object 缺少 --checksum-sha256'
        metadata=$(argument_value --metadata "$@") || fail 'put-object 缺少 --metadata'
        encryption=$(argument_value --server-side-encryption "$@") || \
          fail 'put-object 缺少 --server-side-encryption'
        kms_key=$(argument_value --ssekms-key-id "$@") || fail 'put-object 缺少 --ssekms-key-id'
        if_none_match=$(argument_value --if-none-match "$@") || fail 'put-object 缺少 --if-none-match'
        test "$checksum_algorithm" = SHA256 || fail 'put-object checksum algorithm 不是 SHA256'
        test "$if_none_match" = '*' || fail 'put-object 未使用 If-None-Match 通配条件'
        test "$encryption" = aws:kms || fail 'put-object 未使用 aws:kms'

        object_body="$s3_directory/$key.body"
        object_head="$s3_directory/$key.head.json"
        mkdir -p "$(dirname "$object_body")"
        if test -f "$object_head"; then
          printf '%s\n' 's3-existing' >> "$events_file"
          printf '%s\n' 'PreconditionFailed: object already exists' >&2
          exit 80
        fi

        put_attempt_file="$MOCK_WEB_STATE_DIRECTORY/s3-put-attempts"
        put_attempt=0
        test ! -f "$put_attempt_file" || put_attempt=$(sed -n '1p' "$put_attempt_file")
        put_attempt=$((put_attempt + 1))
        printf '%s\n' "$put_attempt" > "$put_attempt_file"
        if test "$MOCK_WEB_SCENARIO" = upload-interrupt && test "$put_attempt" -eq 2; then
          printf '%s\n' 's3-interrupted' >> "$events_file"
          printf '%s\n' 'simulated upload interruption before server apply' >&2
          exit 81
        fi

        release_metadata=$(metadata_value release-id "$metadata")
        image_metadata=$(metadata_value web-image-digest "$metadata")
        configuration_metadata=$(metadata_value configuration-sha256 "$metadata")
        csp_metadata=$(metadata_value csp-sha256 "$metadata")
        content_length=$(wc -c < "$body" | tr -d '[:space:]')
        cp "$body" "$object_body"
        jq -n \
          --arg release "$release_metadata" \
          --arg image "$image_metadata" \
          --arg configuration "$configuration_metadata" \
          --arg csp "$csp_metadata" \
          --arg checksum "$checksum_sha256" \
          --argjson content_length "$content_length" \
          --arg content_type "$content_type" \
          --arg cache "$cache_control" \
          --arg encryption "$encryption" \
          --arg kms "$kms_key" \
          '{Metadata:{"release-id":$release,"web-image-digest":$image,"configuration-sha256":$configuration,"csp-sha256":$csp},ChecksumSHA256:$checksum,ContentLength:$content_length,ContentType:$content_type,CacheControl:$cache,ServerSideEncryption:$encryption,SSEKMSKeyId:$kms}' \
          > "$object_head"
        printf '%s\n' 's3-put' >> "$events_file"
        jq -n --arg checksum "$checksum_sha256" '{ChecksumSHA256:$checksum}'
        ;;
      s3api/head-object)
        key=$(argument_value --key "$@") || fail 'head-object 缺少 --key'
        checksum_mode=$(argument_value --checksum-mode "$@") || fail 'head-object 缺少 --checksum-mode'
        test "$checksum_mode" = ENABLED || fail 'head-object 未启用 checksum mode'
        object_head="$s3_directory/$key.head.json"
        test -f "$object_head" || {
          printf '%s\n' 'NoSuchKey: object does not exist' >&2
          exit 82
        }
        cat "$object_head"
        ;;
      cloudfront/get-response-headers-policy-config)
        jq -n --arg csp "$MOCK_WEB_CSP" \
          '{ETag:"policy-etag",ResponseHeadersPolicyConfig:{SecurityHeadersConfig:{ContentSecurityPolicy:{Override:true,ContentSecurityPolicy:$csp}}}}'
        ;;
      cloudfront/get-distribution-config)
        jq -n \
          --arg origin "${AWS_WEB_BUCKET}.s3.${AWS_REGION}.amazonaws.com" \
          --arg policy "$AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID" \
          --arg router "arn:aws:cloudfront::${AWS_ACCOUNT_ID}:function/${AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME}" \
          --arg response "arn:aws:cloudfront::${AWS_ACCOUNT_ID}:function/${AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME%-release-request}-release-response" \
          --arg scenario "$MOCK_WEB_SCENARIO" '
            def empty_associations: {Quantity: 0};
            def methods: {Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"],
              CachedMethods: {Quantity: 2, Items: ["GET", "HEAD"]}};
            def ordered: {
              PathPattern: "releases/*", TargetOriginId: "private-web-s3",
              ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: methods, Compress: true,
              CachePolicyId: "cache-policy-fixture", ResponseHeadersPolicyId: $policy,
              FunctionAssociations: empty_associations, LambdaFunctionAssociations: empty_associations
            };
            {ETag:"distribution-etag",DistributionConfig:{
              Enabled:true,DefaultRootObject:"index.html",
              Origins:{Quantity:1,Items:[{Id:"private-web-s3",DomainName:$origin,OriginPath:"",OriginAccessControlId:"oac-fixture"}]},
              DefaultCacheBehavior:{
                TargetOriginId:"private-web-s3", ViewerProtocolPolicy:"redirect-to-https",
                AllowedMethods: methods, Compress:true, CachePolicyId:"cache-policy-fixture",
                ResponseHeadersPolicyId:$policy,
                FunctionAssociations:{
                  Quantity:(if $scenario == "cloudfront-extra-function-association" then 3 else 2 end),
                  Items: ([
                    {EventType:"viewer-request",FunctionARN:$router},
                    {EventType:"viewer-response",FunctionARN:$response}
                  ] + (if $scenario == "cloudfront-extra-function-association" then
                    [{EventType:"origin-request",FunctionARN:"arn:aws:cloudfront::123456789012:function/foreign"}]
                    else [] end))
                },
                LambdaFunctionAssociations:(if $scenario == "cloudfront-lambda-association" then
                  {Quantity:1,Items:[{EventType:"viewer-request",LambdaFunctionARN:"arn:aws:lambda:us-east-1:123456789012:function:foreign:1"}]}
                  else empty_associations end)
              },
              CacheBehaviors:{
                Quantity:(if $scenario == "cloudfront-extra-cache-behavior" then 2 else 1 end),
                Items:([ordered] + (if $scenario == "cloudfront-extra-cache-behavior" then
                  [ordered + {PathPattern:"admin/*"}] else [] end))
              }
            }}
          '
        ;;
      cloudfront/get-distribution)
        jq -n --arg domain "$AWS_CLOUDFRONT_DOMAIN_NAME" \
          '{ETag:"distribution-etag",Distribution:{Status:"Deployed",DomainName:$domain}}'
        ;;
      cloudfront/describe-function)
        jq -n \
          --arg router "arn:aws:cloudfront::${AWS_ACCOUNT_ID}:function/${AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME}" \
          --arg kvs "$AWS_CLOUDFRONT_KVS_ARN" \
          '{FunctionSummary:{FunctionMetadata:{FunctionARN:$router,Stage:"LIVE"},FunctionConfig:{Runtime:"cloudfront-js-2.0",KeyValueStoreAssociations:{Quantity:1,Items:[{KeyValueStoreARN:$kvs}]}}}}'
        ;;
      cloudfront-keyvaluestore/describe-key-value-store)
        etag=$(sed -n '1p' "$etag_file")
        if has_argument --query "$@"; then
          printf '%s\n' "$etag"
        else
          jq -n --arg arn "$AWS_CLOUDFRONT_KVS_ARN" --arg etag "$etag" \
            '{KvsARN:$arn,Status:"READY",ETag:$etag}'
        fi
        ;;
      cloudfront-keyvaluestore/list-keys)
        if test "$MOCK_WEB_SCENARIO" = lookup-error && test -f "$promotion_attempted"; then
          printf '%s\n' 'simulated list-keys lookup error' >&2
          exit 71
        fi
        active_release=$(read_active_release)
        if test "$active_release" = none; then
          printf '%s\n' '{"Items":[]}'
        else
          jq -n --arg release "$active_release" '{Items:[{Key:"active-release",Value:$release}]}'
        fi
        ;;
      cloudfront-keyvaluestore/get-key)
        if test "$MOCK_WEB_SCENARIO" = lookup-error && test -f "$promotion_attempted"; then
          printf '%s\n' 'simulated get-key lookup error' >&2
          exit 72
        fi
        active_release=$(read_active_release)
        if test "$active_release" = none; then
          printf '%s\n' 'ResourceNotFound: active-release' >&2
          exit 73
        fi
        jq -n --arg release "$active_release" '{Key:"active-release",Value:$release}'
        ;;
      cloudfront-keyvaluestore/put-key)
        value=$(argument_value --value "$@") || fail 'put-key 缺少 --value'
        if test "$value" = "$MOCK_WEB_RELEASE_ID"; then
          if test "$MOCK_WEB_SCENARIO" = delayed-apply-after-read && \
            test ! -f "$promotion_attempted"; then
            : > "$promotion_attempted"
            : > "$delayed_promotion_pending"
            printf '%s\n' 'promotion-put' >> "$events_file"
            printf '%s\n' 'simulated delayed post-timeout server apply' >&2
            exit 76
          fi
          : > "$promotion_attempted"
          printf '%s\n' 'promotion-put' >> "$events_file"
          case "$MOCK_WEB_SCENARIO" in
            not-applied-error)
              printf '%s\n' 'simulated pre-apply put-key error' >&2
              exit 74
              ;;
            *)
              write_active_release "$MOCK_WEB_RELEASE_ID" 'etag-after-promotion'
              printf '%s\n' 'simulated post-apply put-key response loss' >&2
              exit 75
              ;;
          esac
        fi
        if test -f "$delayed_promotion_pending"; then
          rm -f "$delayed_promotion_pending"
          write_active_release "$MOCK_WEB_RELEASE_ID" 'etag-after-delayed-promotion'
          printf '%s\n' 'delayed-promotion-applied' >> "$events_file"
          printf '%s\n' 'PreconditionFailed: delayed promotion consumed the old ETag' >&2
          exit 77
        fi
        if test "$(read_active_release)" = "$value"; then
          printf '%s\n' 'promotion-fence' >> "$events_file"
        else
          printf '%s\n' 'rollback-put' >> "$events_file"
        fi
        write_active_release "$value" 'etag-after-rollback'
        printf '%s\n' '{"ETag":"etag-after-rollback"}'
        ;;
      cloudfront-keyvaluestore/delete-key)
        printf '%s\n' 'rollback-delete' >> "$events_file"
        write_active_release none 'etag-after-rollback'
        printf '%s\n' '{"ETag":"etag-after-rollback"}'
        ;;
      *) fail "未知 AWS 调用：$service/$operation" ;;
    esac
    exit 0
    ;;
  *) fail "未知 mock 命令名：$command_name" ;;
esac
