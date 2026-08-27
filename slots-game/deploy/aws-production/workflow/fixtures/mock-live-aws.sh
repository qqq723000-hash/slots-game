#!/bin/sh

# 只模拟平台实时门禁读取的 EKS Pod Identity API，不连接 AWS。
set -eu

fail() {
  printf '%s\n' "AWS 平台 fixture 调用错误：$*" >&2
  exit 2
}

argument_value() {
  expected_name=$1
  shift
  while test "$#" -gt 0; do
    if test "$1" = "$expected_name"; then
      test "$#" -ge 2 || fail "$expected_name 缺少值"
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  fail "缺少参数 $expected_name"
}

test "$#" -ge 2 || fail '参数不足'
if test "$1" = s3api; then
  operation=$2
  shift 2
  bucket=$(argument_value --bucket "$@")
  if test "$operation" = get-public-access-block; then
    expected_owner=$(argument_value --expected-bucket-owner "$@")
    region=$(argument_value --region "$@")
    test "$bucket" = slots-production || fail 'CloudFront origin bucket 不匹配'
    test "$expected_owner" = 123456789012 || fail 'CloudFront origin bucket owner 不匹配'
    test "$region" = ap-southeast-1 || fail 'CloudFront origin bucket region 不匹配'
    test "${MOCK_PLATFORM_MODE:-valid}" != cloudfront-origin-public-access-block-missing || exit 254
    jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
      {PublicAccessBlockConfiguration: {
        BlockPublicAcls: ($mode != "cloudfront-origin-public-acls-enabled"),
        IgnorePublicAcls: ($mode != "cloudfront-origin-public-acls-enabled"),
        BlockPublicPolicy: ($mode != "cloudfront-origin-public-policy-enabled"),
        RestrictPublicBuckets: ($mode != "cloudfront-origin-public-policy-enabled")
      }}
    '
    exit 0
  fi
  if test "$operation" = get-bucket-policy; then
    expected_owner=$(argument_value --expected-bucket-owner "$@")
    region=$(argument_value --region "$@")
    test "$bucket" = slots-production || fail 'CloudFront origin bucket policy identity 不匹配'
    test "$expected_owner" = 123456789012 || fail 'CloudFront origin bucket policy owner 不匹配'
    test "$region" = ap-southeast-1 || fail 'CloudFront origin bucket policy region 不匹配'
    test "${MOCK_PLATFORM_MODE:-valid}" != cloudfront-origin-bucket-policy-missing || exit 254
    policy=$(jq -nc --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
      {Version: "2012-10-17", Statement: (([
        {
          Sid: "AllowCloudFrontOacRead", Effect: "Allow", Action: "s3:GetObject",
          Resource: "arn:aws:s3:::slots-production/*",
          Principal: {Service: "cloudfront.amazonaws.com"},
          Condition: {StringEquals: {"AWS:SourceArn": (if $mode == "cloudfront-origin-source-arn-drift"
            then "arn:aws:cloudfront::123456789012:distribution/EFOREIGN"
            else "arn:aws:cloudfront::123456789012:distribution/E1234567890ABC" end)}}
        },
        {
          Sid: "DenyUnconditionalReleaseWrites", Effect: "Deny", Action: "s3:PutObject",
          Resource: (if $mode == "cloudfront-release-prefix-writable" then "arn:aws:s3:::slots-production/*"
            else "arn:aws:s3:::slots-production/releases/*" end),
          Principal: "*", Condition: (if $mode == "cloudfront-release-unconditional-write-allowed"
            then {Null: {"s3:if-none-match-disabled": "true"}}
            else {Bool: {"s3:ObjectCreationOperation": "true"}, Null: {"s3:if-none-match": "true"}} end)
        },
        {
          Sid: "DenyInsecureTransport", Effect: "Deny", Action: "s3:*",
          Resource: ["arn:aws:s3:::slots-production", "arn:aws:s3:::slots-production/*"],
          Principal: "*", Condition: {Bool: {"aws:SecureTransport": "false"}}
        }
      ] | (if $mode == "cloudfront-release-write-deny-missing" then
        map(select(.Sid != "DenyUnconditionalReleaseWrites")) else . end)) +
      (if $mode == "cloudfront-origin-external-principal" then [{
        Sid: "ExternalRead", Effect: "Allow", Action: "s3:GetObject",
        Resource: "arn:aws:s3:::slots-production/*",
        Principal: {AWS: "arn:aws:iam::999999999999:root"}
      }] else [] end))}
    ')
    jq -n --arg policy "$policy" '{Policy: $policy}'
    exit 0
  fi
  key=$(argument_value --key "$@")
  version_id=$(argument_value --version-id "$@")
  region=$(argument_value --region "$@")
  test "$bucket" = slots-waf-evidence || fail 'WAF evidence bucket 不匹配'
  case "$key" in
    production/api-managed-rules.json|production/api-launch-rate.json) ;;
    *) fail 'WAF evidence key 不匹配' ;;
  esac
  test "$version_id" = fixture-version-1 || fail 'WAF evidence version 不匹配'
  test "$region" = ap-southeast-1 || fail 'WAF evidence region 不匹配'
  evidence_file=${MOCK_WAF_EVIDENCE_FILE:-}
  if test "${MOCK_PLATFORM_MODE:-valid}" = waf-managed-block-evidence-tampered; then
    evidence_file=${MOCK_WAF_EVIDENCE_TAMPERED_FILE:-}
  fi
  if test -z "$evidence_file" || ! test -f "$evidence_file"; then
    fail 'WAF evidence fixture 缺失'
  fi
  content_length=$(wc -c <"$evidence_file" | tr -d ' ')
  case "$operation" in
    head-object)
      jq -n --arg version "$version_id" --argjson length "$content_length" \
        --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
          {
            VersionId: $version,
            ContentLength: $length,
            ServerSideEncryption: (if $mode == "waf-managed-block-evidence-unencrypted" then "AES256" else "aws:kms" end),
            SSEKMSKeyId: (if $mode == "waf-managed-block-evidence-wrong-kms"
              then "arn:aws:kms:ap-southeast-1:123456789012:key/33333333-3333-4333-8333-333333333333"
              else "arn:aws:kms:ap-southeast-1:123456789012:key/22222222-2222-4222-8222-222222222222" end),
            ObjectLockMode: (if $mode == "waf-managed-block-evidence-unlocked" then "GOVERNANCE" else "COMPLIANCE" end),
            ObjectLockRetainUntilDate: "2999-01-01T00:00:00Z"
          }
        '
      ;;
    get-object)
      destination=
      for argument in "$@"; do destination=$argument; done
      test -n "$destination" || fail 'WAF evidence 下载目标缺失'
      cp "$evidence_file" "$destination"
      jq -n --arg version "$version_id" '{VersionId: $version}'
      ;;
    *) fail '只允许读取 versioned WAF evidence object' ;;
  esac
  exit 0
fi
if test "$1" = elasticache; then
  operation=$2
  shift 2
  for argument in "$@"; do
    test "$argument" != --no-paginate || fail 'Valkey 实时回读禁止关闭 AWS CLI 自动分页'
  done
  region=$(argument_value --region "$@")
  test "$region" = ap-southeast-1 || fail 'Valkey region 不匹配'
  mode=${MOCK_PLATFORM_MODE:-valid}
  case "$operation" in
    describe-replication-groups)
      replication_group_id=$(argument_value --replication-group-id "$@")
      test "$replication_group_id" = slots-prod-primary-valkey || fail 'Valkey replication group ID 不匹配'
      jq -n --arg mode "$mode" '{ReplicationGroups: [{
        ReplicationGroupId: "slots-prod-primary-valkey",
        Status: (if $mode == "valkey-replication-pending" then "modifying" else "available" end),
        PendingModifiedValues: (if $mode == "valkey-replication-pending"
          then {CacheNodeType: "cache.r7g.large"} else {} end),
        MemberClusters: [
          "slots-prod-primary-valkey-001",
          "slots-prod-primary-valkey-002",
          "slots-prod-primary-valkey-003"
        ]
      }]}'
      ;;
    describe-cache-clusters)
      jq -n --arg mode "$mode" '
        def cluster($id): {
          CacheClusterId: $id,
          ReplicationGroupId: "slots-prod-primary-valkey",
          Engine: "valkey",
          EngineVersion: "7.2",
          CacheClusterStatus: "available",
          PendingModifiedValues: (if $mode == "valkey-cluster-pending" then {EngineVersion: "8.0"} else {} end),
          CacheParameterGroup: {
            CacheParameterGroupName: (if $mode == "valkey-parameter-group-drift"
              then "default.valkey7" else "slots-prod-primary-valkey-noeviction" end),
            ParameterApplyStatus: (if $mode == "valkey-parameter-applying" then "applying" else "in-sync" end),
            CacheNodeIdsToReboot: (if $mode == "valkey-parameter-applying" then ["0001"] else [] end)
          }
        };
        {CacheClusters: ((if $mode == "valkey-target-after-page" then [
          (cluster("decoy-valkey-001") | .ReplicationGroupId = "other-replication-group"),
          (cluster("decoy-valkey-002") | .ReplicationGroupId = "other-replication-group")
        ] else [] end) + [
          cluster("slots-prod-primary-valkey-001"),
          cluster("slots-prod-primary-valkey-002"),
          cluster("slots-prod-primary-valkey-003")
        ])}
      '
      ;;
    describe-cache-parameters)
      parameter_group_name=$(argument_value --cache-parameter-group-name "$@")
      test "$parameter_group_name" = slots-prod-primary-valkey-noeviction || fail 'Valkey parameter group 不匹配'
      jq -n --arg mode "$mode" '{Parameters: ((if $mode == "valkey-target-after-page" then [{
        ParameterName: "active-defrag-cycle-min",
        ParameterValue: "1",
        Source: "system",
        DataType: "integer",
        AllowedValues: "1-75",
        IsModifiable: true,
        ChangeType: "immediate"
      }] else [] end) + [{
        ParameterName: "maxmemory-policy",
        ParameterValue: (if $mode == "valkey-eviction-policy-drift" then "volatile-lru" else "noeviction" end),
        Source: "user",
        DataType: "string",
        AllowedValues: "volatile-lru,noeviction",
        IsModifiable: true,
        ChangeType: "immediate"
      }])}'
      ;;
    *) fail '只允许回读 Valkey replication/cache/parameter 状态' ;;
  esac
  exit 0
fi
if test "$1" = wafv2; then
  operation=$2
  shift 2
  region=$(argument_value --region "$@")
  case "$operation" in
    get-web-acl)
      name=$(argument_value --name "$@")
      scope=$(argument_value --scope "$@")
      id=$(argument_value --id "$@")
      if test "$scope" = CLOUDFRONT; then
        test "$region" = us-east-1 || fail 'CloudFront WAF home region 不匹配'
        test "$name" = slots-prod-primary-web || fail 'CloudFront WAF 名称不匹配'
        test "$id" = 11111111-1111-4111-8111-111111111111 || fail 'CloudFront WAF ID 不匹配'
        jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
          def managed($name; $priority; $group; $version): {
            Name: $name, Priority: $priority,
            OverrideAction: (if $mode == "cloudfront-managed-stage-drift" and $name == "common"
              then {None: {}} else {Count: {}} end),
            Statement: {ManagedRuleGroupStatement: ({VendorName: "AWS", Name: $group,
              Version: (if $mode == "cloudfront-managed-version-drift" and $name == "common"
                then "Version_9.9" else $version end)} +
              (if $name != "common" then {}
               elif $mode == "cloudfront-managed-excluded-rules" then {ExcludedRules: [{Name: "SizeRestrictions_BODY"}]}
               elif $mode == "cloudfront-managed-action-override" then {RuleActionOverrides: [{Name: "SizeRestrictions_BODY", ActionToUse: {Count: {}}}]}
               elif $mode == "cloudfront-managed-scope-down" then {ScopeDownStatement: {ByteMatchStatement: {SearchString: "/safe"}}}
               else {} end))},
            VisibilityConfig: {
              CloudWatchMetricsEnabled: (($mode == "cloudfront-rule-metrics-disabled" and $name == "common") | not),
              MetricName: (if $mode == "cloudfront-rule-metric-name-drift" and $name == "common"
                then "foreign_metric" else ("slots_prod_primary_web_" + ($name | gsub("-"; "_"))) end),
              SampledRequestsEnabled: ($mode == "cloudfront-sampled-requests-enabled")}
          };
          {WebACL: {
            Name: "slots-prod-primary-web",
            ARN: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/slots-prod-primary-web/11111111-1111-4111-8111-111111111111",
            DefaultAction: {Allow: {}}, Rules: [
              managed("amazon-ip-reputation"; 10; "AWSManagedRulesAmazonIpReputationList"; "Version_1.0"),
              managed("common"; 20; "AWSManagedRulesCommonRuleSet"; "Version_2.1"),
              managed("known-bad-inputs"; 30; "AWSManagedRulesKnownBadInputsRuleSet"; "Version_1.0"),
              {Name: "web-rate-limit", Priority: 100,
                Action: (if $mode == "cloudfront-rate-stage-drift" then {Block: {}} else {Count: {}} end),
                Statement: {RateBasedStatement: ({AggregateKeyType: "IP", EvaluationWindowSec: 60,
                  Limit: (if $mode == "cloudfront-waf-rate-drift" then 999999 else 12000 end)} +
                  (if $mode == "cloudfront-rate-scope-down" then
                    {ScopeDownStatement: {ByteMatchStatement: {SearchString: "/assets"}}} else {} end))},
                VisibilityConfig: {
                  CloudWatchMetricsEnabled: ($mode != "cloudfront-rule-metrics-disabled"),
                  MetricName: (if $mode == "cloudfront-rule-metric-name-drift" then "foreign_metric"
                    else "slots_prod_primary_web_web_rate" end),
                  SampledRequestsEnabled: ($mode == "cloudfront-sampled-requests-enabled")}}
            ], VisibilityConfig: {
              CloudWatchMetricsEnabled: ($mode != "cloudfront-web-acl-metrics-disabled"),
              MetricName: (if $mode == "cloudfront-web-acl-metric-name-drift" then "foreign_metric"
                else "slots_prod_primary_web" end),
              SampledRequestsEnabled: ($mode == "cloudfront-sampled-requests-enabled")}
          }}
        '
        exit 0
      fi
      test "$region" = ap-southeast-1 || fail '区域 WAF region 不匹配'
      test "$name" = slots-prod-primary-api || fail '区域 WAF 名称不匹配'
      test "$scope" = REGIONAL || fail '区域 WAF scope 不匹配'
      test "$id" = 00000000-0000-4000-8000-000000000000 || fail '区域 WAF ID 不匹配'
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
          def managed($name; $priority; $group; $version): {
            Name: $name, Priority: $priority,
            OverrideAction: (if (($mode == "waf-managed-stage-drift" and $name == "common") or
              ($mode | startswith("waf-managed-block-evidence-")))
              then {None: {}} else {Count: {}} end),
          Statement: {ManagedRuleGroupStatement: ({VendorName: "AWS", Name: $group,
            Version: (if $mode == "waf-managed-version-drift" and $name == "common"
              then "Version_9.9" else $version end)} +
            (if $name != "common" then {}
             elif $mode == "waf-managed-excluded-rules" then {ExcludedRules: [{Name: "SizeRestrictions_BODY"}]}
             elif $mode == "waf-managed-action-override" then {RuleActionOverrides: [{Name: "SizeRestrictions_BODY", ActionToUse: {Count: {}}}]}
             elif $mode == "waf-managed-scope-down" then {ScopeDownStatement: {ByteMatchStatement: {SearchString: "/safe"}}}
             else {} end))},
          VisibilityConfig: {
            CloudWatchMetricsEnabled: (($mode == "waf-rule-metrics-disabled" and $name == "common") | not),
            MetricName: (if $mode == "waf-rule-metric-name-drift" and $name == "common"
              then "foreign_metric" else ("slots_prod_primary_api_" + ($name | gsub("-"; "_"))) end),
            SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}
        };
        def size_rule($name; $priority; $component; $code): {
          Name: $name, Priority: $priority,
          Action: (if $component == "Headers" and $mode != "waf-header-stage-drift"
            then {Count: {}} else {Block: {CustomResponse: {ResponseCode: $code}}} end),
          Statement: {SizeConstraintStatement: {
            ComparisonOperator: "GT", Size: 8192,
            FieldToMatch: (if $component == "Headers" then {Headers: {
              MatchScope: (if $mode == "waf-header-match-scope-drift" then "KEY" else "ALL" end),
              MatchPattern: (if $mode == "waf-header-match-pattern-drift" then
                {IncludedHeaders: ["content-type"]} else {All: {}} end),
              OversizeHandling: "MATCH"
            }} else {Body: {OversizeHandling: "MATCH"}} end),
            TextTransformations: [{Priority: 0,
              Type: (if (($mode == "waf-body-size-transform-drift" and $component == "Body") or
                ($mode == "waf-header-size-transform-drift" and $component == "Headers"))
                then "COMPRESS_WHITE_SPACE" else "NONE" end)}]
          }},
          VisibilityConfig: {CloudWatchMetricsEnabled: true,
            MetricName: (if $component == "Body" then "slots_prod_primary_api_body_size"
              else "slots_prod_primary_api_header_size" end),
            SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}
        };
        def health_block: {
          Name: "public-healthz-block", Priority: 1,
          Action: {Block: {CustomResponse: {ResponseCode: 404}}},
          Statement: {ByteMatchStatement: {
            FieldToMatch: {UriPath: {}}, PositionalConstraint: "EXACTLY",
            SearchString: (if $mode == "waf-public-healthz-drift" then "/readyz" else "/healthz" end),
            TextTransformations: [{Priority: 0, Type: "NONE"}]
          }},
          VisibilityConfig: {CloudWatchMetricsEnabled: true, MetricName: "slots_prod_primary_api_public_healthz_block",
            SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}
        };
        def protocol_surface_block: {
          Name: "public-protocol-surface-block", Priority: 5,
          Action: {Block: {CustomResponse: {ResponseCode: 404}}},
          Statement: {NotStatement: {Statement: {AndStatement: {Statements: [
            {OrStatement: {Statements: [
              {ByteMatchStatement: {FieldToMatch: {UriPath: {}}, PositionalConstraint: "STARTS_WITH",
                SearchString: "/client/", TextTransformations: [{Priority: 0, Type: "NONE"}]}},
              {ByteMatchStatement: {FieldToMatch: {UriPath: {}}, PositionalConstraint: "STARTS_WITH",
                SearchString: (if $mode == "waf-protocol-surface-drift" then "/" else "/operator/" end),
                TextTransformations: [{Priority: 0, Type: "NONE"}]}}
            ]}},
            {OrStatement: {Statements: ["GET", "OPTIONS", "POST"] | map({ByteMatchStatement: {
              FieldToMatch: {Method: {}}, PositionalConstraint: "EXACTLY", SearchString: .,
              TextTransformations: [{Priority: 0, Type: "NONE"}]
            }})}}
          ]}}}},
          VisibilityConfig: {CloudWatchMetricsEnabled: true, MetricName: "slots_prod_primary_api_protocol_surface_block",
            SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}
        };
        def rate_rule($name; $priority; $limit; $path; $position): {
          Name: $name, Priority: $priority,
          Action: (if (["waf-rate-stage-drift", "waf-rate-block-valid", "waf-rate-block-browser-response-drift"] |
            index($mode)) and $name == "launch-rate-limit"
            then {Block: {CustomResponse: {ResponseCode: 429,
              ResponseHeaders: [
                {Name: "Retry-After", Value: "30"},
                {Name: "Access-Control-Allow-Origin", Value: "*"},
                {Name: "Access-Control-Expose-Headers", Value: "Retry-After, X-RGS-Edge-Error"},
                {Name: "X-RGS-Edge-Error", Value: (if $mode == "waf-rate-block-browser-response-drift"
                  then "UNKNOWN" else "RATE_LIMITED" end)}
              ]}}}
            else {Count: {}} end),
          Statement: {RateBasedStatement: {
            AggregateKeyType: "IP", EvaluationWindowSec: 60, Limit: $limit,
            ScopeDownStatement: {AndStatement: {Statements: [
              {ByteMatchStatement: {
                FieldToMatch: {UriPath: {}}, PositionalConstraint: $position,
                SearchString: $path, TextTransformations: [{Priority: 0, Type: "NONE"}]
              }},
              {ByteMatchStatement: {
                FieldToMatch: {Method: {}}, PositionalConstraint: "EXACTLY",
                SearchString: (if $mode == "waf-low-rate-method-drift" and $name == "launch-rate-limit"
                  then "OPTIONS" else "POST" end),
                TextTransformations: [{Priority: 0, Type: "NONE"}]
              }}
            ]}}
          }},
          VisibilityConfig: {CloudWatchMetricsEnabled: true,
            MetricName: ("slots_prod_primary_api_" + ($name | sub("-rate-limit$"; "_rate") | gsub("-"; "_"))),
            SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}
        };
        [
          managed("amazon-ip-reputation"; 10; "AWSManagedRulesAmazonIpReputationList"; "Version_1.0"),
          managed("common"; 20; "AWSManagedRulesCommonRuleSet"; "Version_2.1"),
          managed("known-bad-inputs"; 30; "AWSManagedRulesKnownBadInputsRuleSet"; "Version_1.0"),
          managed("sqli"; 40; "AWSManagedRulesSQLiRuleSet"; "Version_1.1"),
          health_block,
          protocol_surface_block,
          size_rule("body-size-limit"; 50; "Body"; 413),
          size_rule("header-size-limit"; 60; "Headers"; 431),
          rate_rule("launch-rate-limit"; 100; 120;
            (if $mode == "waf-low-rate-scope-widened" then "/operator/" else "/operator/v1/launches" end);
            (if $mode == "waf-low-rate-scope-widened" then "STARTS_WITH" else "EXACTLY" end)),
          rate_rule("spin-rate-limit"; 110; 600; "/client/v1/spins"; "EXACTLY"),
          {Name: "public-api-rate-limit", Priority: 120,
            Action: {Count: {}},
            Statement: {RateBasedStatement: {AggregateKeyType: "IP", EvaluationWindowSec: 60, Limit: 12000,
              ScopeDownStatement: {AndStatement: {Statements: [
                {OrStatement: {Statements: [
                  {ByteMatchStatement: {FieldToMatch: {UriPath: {}}, PositionalConstraint: "STARTS_WITH",
                    SearchString: "/client/", TextTransformations: [{Priority: 0, Type: "NONE"}]}},
                  {ByteMatchStatement: {FieldToMatch: {UriPath: {}}, PositionalConstraint: "STARTS_WITH",
                    SearchString: "/operator/", TextTransformations: [{Priority: 0, Type: "NONE"}]}}
                ]}},
                {OrStatement: {Statements: (if $mode == "waf-public-rate-method-drift"
                  then ["GET", "POST"] else ["GET", "OPTIONS", "POST"] end) |
                  map({ByteMatchStatement: {FieldToMatch: {Method: {}}, PositionalConstraint: "EXACTLY",
                    SearchString: ., TextTransformations: [{Priority: 0, Type: "NONE"}]}})}}
              ]}}}},
            VisibilityConfig: {CloudWatchMetricsEnabled: true, MetricName: "slots_prod_primary_api_public_api_rate",
              SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}}
        ] |
        (if $mode == "waf-rule-drift" then map(select(.Name != "spin-rate-limit"))
        elif $mode == "waf-unknown-allow-rule" then . + [{
          Name: "unknown-allow-all", Priority: 0, Action: {Allow: {}},
          Statement: {ByteMatchStatement: {FieldToMatch: {UriPath: {}}, PositionalConstraint: "STARTS_WITH",
            SearchString: "/", TextTransformations: [{Priority: 0, Type: "NONE"}]}},
          VisibilityConfig: {CloudWatchMetricsEnabled: true, MetricName: "slots_prod_primary_api_unknown_allow_all",
            SampledRequestsEnabled: false}
        }]
        elif $mode == "waf-priority-drift" then map(if .Name == "body-size-limit" then .Priority = 0 else . end)
        else . end) as $rules |
        {WebACL: {
          Name: "slots-prod-primary-api",
          ARN: "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/slots-prod-primary-api/00000000-0000-4000-8000-000000000000",
          DefaultAction: {Allow: {}}, Rules: $rules,
          VisibilityConfig: {
            CloudWatchMetricsEnabled: ($mode != "waf-web-acl-metrics-disabled"),
            MetricName: (if $mode == "waf-web-acl-metric-name-drift" then "foreign_metric"
              else "slots_prod_primary_api" end),
            SampledRequestsEnabled: ($mode == "waf-sampled-requests-enabled")}
        }}
      '
      ;;
    get-web-acl-for-resource)
      resource_arn=$(argument_value --resource-arn "$@")
      test "$region" = ap-southeast-1 || fail 'ALB WAF association region 不匹配'
      test "$resource_arn" = arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/slots-prod-primary-api/4444444444444444 || \
        fail 'ALB ARN 不匹配'
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        {WebACL: {
          ARN: (if $mode == "alb-waf-drift"
            then "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/other/99999999-9999-4999-8999-999999999999"
            else "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/slots-prod-primary-api/00000000-0000-4000-8000-000000000000" end)
        }}
      '
      ;;
    get-logging-configuration)
      resource_arn=$(argument_value --resource-arn "$@")
      if test "$resource_arn" = arn:aws:wafv2:us-east-1:123456789012:global/webacl/slots-prod-primary-web/11111111-1111-4111-8111-111111111111; then
        test "$region" = us-east-1 || fail 'CloudFront WAF logging region 不匹配'
        jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
          {LoggingConfiguration: {
            ResourceArn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/slots-prod-primary-web/11111111-1111-4111-8111-111111111111",
            LogDestinationConfigs: ["arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-slots-production-web"],
            RedactedFields: ([
              {SingleHeader: {Name: "authorization"}},
              {SingleHeader: {Name: "cookie"}}
            ] + (if $mode == "cloudfront-logging-query-visible" then [] else [{QueryString: {}}] end)),
            LoggingFilter: {DefaultBehavior: "DROP", Filters: [{
              Behavior: (if $mode == "cloudfront-logging-behavior-drift" then "DROP" else "KEEP" end),
              Requirement: (if $mode == "cloudfront-logging-requirement-drift" then "MEETS_ALL" else "MEETS_ANY" end),
              Conditions: [{ActionCondition: {Action: "BLOCK"}}, {ActionCondition: {Action: "COUNT"}}]}]}
          }}
        '
        exit 0
      fi
      test "$region" = ap-southeast-1 || fail '区域 WAF logging region 不匹配'
      test "$resource_arn" = arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/slots-prod-primary-api/00000000-0000-4000-8000-000000000000 || \
        fail '区域 WAF logging ARN 不匹配'
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        ["authorization", "cookie", "idempotency-key", "signature", "signature-input", "x-nonce", "x-rgs-signature"] |
        (if $mode == "waf-logging-unredacted" then map(select(. != "authorization")) else . end) as $headers |
        (if $mode == "waf-logging-query-visible" then [] else [{QueryString: {}}] end) as $query_fields |
        {LoggingConfiguration: {
          ResourceArn: "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/slots-prod-primary-api/00000000-0000-4000-8000-000000000000",
          LogDestinationConfigs: ["arn:aws:logs:ap-southeast-1:123456789012:log-group:aws-waf-logs-slots-prod-primary-api"],
          RedactedFields: ([$headers[] | {SingleHeader: {Name: .}}] + $query_fields),
          LoggingFilter: {DefaultBehavior: "DROP", Filters: [{
            Behavior: (if $mode == "waf-logging-behavior-drift" then "DROP" else "KEEP" end),
            Requirement: (if $mode == "waf-logging-requirement-drift" then "MEETS_ALL" else "MEETS_ANY" end),
            Conditions: [{ActionCondition: {Action: "BLOCK"}}, {ActionCondition: {Action: "COUNT"}}]}]}
        }}
      '
      ;;
    *) fail '未知 WAFv2 API' ;;
  esac
  exit 0
fi
if test "$1" = elbv2; then
  operation=$2
  shift 2
  region=$(argument_value --region "$@")
  test "$region" = ap-southeast-1 || fail 'ELBv2 region 不匹配'
  case "$operation" in
    describe-load-balancers)
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        {LoadBalancers: [{
          LoadBalancerArn: "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/slots-prod-primary-api/4444444444444444",
          DNSName: "slots-prod-primary-api-123456.ap-southeast-1.elb.amazonaws.com",
          Scheme: "internet-facing", Type: "application", IpAddressType: "ipv4", State: {Code: "active"},
          SecurityGroups: [(if $mode == "alb-security-group-drift" then "sg-99999999999999999" else "sg-00000000000000001" end)],
          AvailabilityZones: [
            {ZoneName: "ap-southeast-1a", SubnetId: "subnet-00000000000000001"},
            {ZoneName: "ap-southeast-1b", SubnetId: "subnet-00000000000000002"},
            {ZoneName: "ap-southeast-1c", SubnetId: (if $mode == "alb-subnet-drift"
              then "subnet-99999999999999999" else "subnet-00000000000000003" end)}
          ]
        }]}
      '
      ;;
    describe-listeners)
      load_balancer_arn=$(argument_value --load-balancer-arn "$@")
      test "$load_balancer_arn" = arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/slots-prod-primary-api/4444444444444444 || fail 'listener ALB ARN 不匹配'
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        {Listeners: [
          {ListenerArn: "listener-http", Port: 80, Protocol: "HTTP", DefaultActions: [{
            Type: "redirect", RedirectConfig: ({Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301"} +
              (if $mode == "alb-http-redirect-host-drift" then {Host: "attacker.example"} else {} end))
          }]},
          {ListenerArn: "listener-https", Port: (if $mode == "alb-listener-drift" then 8443 else 443 end),
            Protocol: "HTTPS",
            SslPolicy: (if $mode == "alb-tls-policy-drift" then "ELBSecurityPolicy-2016-08"
              else "ELBSecurityPolicy-TLS13-1-2-2021-06" end),
            Certificates: [{CertificateArn: (if $mode == "alb-certificate-drift"
              then "arn:aws:acm:ap-southeast-1:123456789012:certificate/99999999-9999-4999-8999-999999999999"
              else "arn:aws:acm:ap-southeast-1:123456789012:certificate/00000000-0000-4000-8000-000000000000" end)}],
            DefaultActions: [{Type: "fixed-response", FixedResponseConfig: {StatusCode: "404"}}]}
        ]}
      '
      ;;
    describe-rules)
      listener_arn=$(argument_value --listener-arn "$@")
      case "$listener_arn" in
        listener-http)
          jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
            {Rules: ([
              {RuleArn: "listener-rule-http-default", Priority: "default", IsDefault: true,
                Conditions: [], Actions: [{Type: "redirect",
                  RedirectConfig: ({Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301"} +
                    (if $mode == "alb-http-rule-redirect-path-drift" then {Path: "/capture"}
                    elif $mode == "alb-http-rule-redirect-query-drift" then {Query: "token=forwarded"}
                    else {} end))}]}
            ] + (if $mode == "alb-http-extra-rule" then [{
              RuleArn: "listener-rule-http-extra", Priority: "1", IsDefault: false,
              Conditions: [{Field: "path-pattern", PathPatternConfig: {Values: ["/*"]}}],
              Actions: [{Type: "forward",
                TargetGroupArn: "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/k8s-slots-rgs/5555555555555555"}]
            }] else [] end))}
          '
          ;;
        listener-https)
          jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
            {Rules: ([
          {
            RuleArn: "listener-rule-api", Priority: "1", IsDefault: false,
            Conditions: [{Field: "host-header", HostHeaderConfig: {Values: [
              (if $mode == "alb-host-rule-drift" then "wrong.example.com" else "api.example.com" end)
            ]}}, {Field: "path-pattern", PathPatternConfig: {Values: [
              (if $mode == "alb-path-rule-drift" then "/operator/*" else "/*" end)
            ]}}],
            Actions: [{Type: "forward", TargetGroupArn: (if $mode == "alb-target-rule-drift"
              then "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/wrong/9999999999999999"
              else "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/k8s-slots-rgs/5555555555555555" end)}]
          },
          {RuleArn: "listener-rule-default", Priority: "default", IsDefault: true,
            Conditions: [], Actions: [(if $mode == "alb-https-default-forward" then {
              Type: "forward",
              TargetGroupArn: "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/k8s-slots-rgs/5555555555555555"
            } else {Type: "fixed-response", FixedResponseConfig: {StatusCode: "404"}} end)]}
        ] + (if $mode == "alb-https-extra-rule" then [{
          RuleArn: "listener-rule-extra", Priority: "2", IsDefault: false,
          Conditions: [{Field: "host-header", HostHeaderConfig: {Values: ["alternate.example.com"]}},
            {Field: "path-pattern", PathPatternConfig: {Values: ["/*"]}}],
          Actions: [{Type: "forward",
            TargetGroupArn: "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/k8s-slots-rgs/5555555555555555"}]
        }] else [] end))}
          '
          ;;
        *) fail 'listener ARN 不匹配' ;;
      esac
      ;;
    describe-load-balancer-attributes)
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        {Attributes: [
          {Key: "deletion_protection.enabled", Value: "true"},
          {Key: "waf.fail_open.enabled", Value: (if $mode == "alb-waf-fail-open" then "true" else "false" end)},
          {Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true"},
          {Key: "routing.http.desync_mitigation_mode", Value: (if $mode == "alb-attribute-drift" then "defensive" else "strictest" end)},
          {Key: "routing.http2.enabled", Value: "true"},
          {Key: "idle_timeout.timeout_seconds", Value: "30"},
          {Key: "client_keep_alive.seconds", Value: "300"},
          {Key: "access_logs.s3.enabled", Value: "true"},
          {Key: "access_logs.s3.bucket", Value: (if $mode == "alb-log-bucket-drift"
            then "attacker-alb-access-logs" else "company-alb-access-logs" end)},
          {Key: "access_logs.s3.prefix", Value: (if $mode == "alb-log-prefix-drift"
            then "foreign-environment" else "slots-production" end)}
        ]}
      '
      ;;
    describe-target-groups)
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        {TargetGroups: [{
          TargetGroupArn: "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/k8s-slots-rgs/5555555555555555",
          VpcId: "vpc-00000000000000001", TargetType: "ip", Protocol: "HTTP", Port: 8080,
          HealthCheckProtocol: "HTTP",
          HealthCheckPort: (if $mode == "alb-health-port-drift" then "8080" else "8081" end),
          HealthCheckPath: "/healthz", Matcher: {HttpCode: "200"}
        }]}
      '
      ;;
    describe-target-health)
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        {TargetHealthDescriptions: [
          {
            Target: {Id: "10.30.10.10", Port: 8080},
            TargetHealth: {State: (if $mode == "alb-target-unhealthy" then "unhealthy" else "healthy" end)}
          },
          {
            Target: {Id: "10.30.10.9", Port: 8080},
            TargetHealth: {State: (if $mode == "alb-stale-target-unhealthy" then "unhealthy" else "draining" end)}
          }
        ]}
      '
      ;;
    *) fail '未知 ELBv2 API' ;;
  esac
  exit 0
fi
if test "$1" = ec2; then
  operation=$2
  shift 2
  test "$operation" = describe-security-group-rules || fail '只允许读取 SG rules'
  region=$(argument_value --region "$@")
  filter=$(argument_value --filters "$@")
  test "$region" = ap-southeast-1 || fail 'EC2 region 不匹配'
  test "$filter" = Name=group-id,Values=sg-00000000000000001 || fail 'SG filter 不匹配'
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    [
      {SecurityGroupRuleId: "sgr-ingress-http", GroupId: "sg-00000000000000001", IsEgress: false,
        IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIpv4: "0.0.0.0/0"},
      {SecurityGroupRuleId: "sgr-egress-api", GroupId: "sg-00000000000000001", IsEgress: true,
        IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, CidrIpv4: "10.30.0.0/16"},
      {SecurityGroupRuleId: "sgr-egress-health", GroupId: "sg-00000000000000001", IsEgress: true,
        IpProtocol: "tcp", FromPort: 8081, ToPort: 8081,
        CidrIpv4: (if $mode == "alb-egress-health-internet" then "0.0.0.0/0" else "10.30.0.0/16" end)}
    ] |
    (if $mode == "alb-egress-health-missing" then map(select(.SecurityGroupRuleId != "sgr-egress-health")) else . end) |
    {SecurityGroupRules: .}
  '
  exit 0
fi
if test "$1" = cloudfront; then
  if test "$2" = get-response-headers-policy-config; then
    shift 2
    policy_id=$(argument_value --id "$@")
    test "$policy_id" = 22222222-2222-4222-8222-222222222222 || \
      fail 'CloudFront Response Headers Policy ID 不匹配'
    jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
      {ETag: "fixture-policy-etag", ResponseHeadersPolicyConfig: {
        Name: "slots-prod-primary-web-security",
        SecurityHeadersConfig: ({
          ContentSecurityPolicy: {
            Override: true,
            ContentSecurityPolicy: "default-src \u0027self\u0027; object-src \u0027none\u0027; frame-ancestors https://operator.example.com;"
          }
        } + (if $mode == "cloudfront-frame-options-sameorigin" then
          {FrameOptions: {Override: true, FrameOption: "SAMEORIGIN"}} else {} end))
      }}
    '
    exit 0
  fi
  test "$2" = get-distribution || fail '只允许读取 CloudFront distribution'
  shift 2
  distribution_id=$(argument_value --id "$@")
  test "$distribution_id" = E1234567890ABC || fail 'CloudFront distribution ID 不匹配'
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    def empty_associations: {Quantity: 0};
    def methods: {Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"],
      CachedMethods: {Quantity: 2, Items: ["GET", "HEAD"]}};
    def ordered_behavior: {
      PathPattern: "releases/*",
      TargetOriginId: "private-web-s3",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: methods,
      Compress: true,
      CachePolicyId: "11111111-1111-4111-8111-111111111111",
      ResponseHeadersPolicyId: "22222222-2222-4222-8222-222222222222",
      FunctionAssociations: empty_associations,
      LambdaFunctionAssociations: empty_associations
    };
    {Distribution: {
      Id: "E1234567890ABC",
      DomainName: "d111111abcdef8.cloudfront.net",
      Status: "Deployed",
      DistributionConfig: {
        Enabled: true,
        HttpVersion: (if $mode == "cloudfront-http-version-drift" then "http2" else "http2and3" end),
        DefaultRootObject: "index.html",
        Aliases: {Quantity: 1, Items: ["slots.production.example.com"]},
        WebACLId: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/slots-prod-primary-web/11111111-1111-4111-8111-111111111111",
        Origins: {Quantity: 1, Items: [{
          Id: "private-web-s3",
          DomainName: "slots-production.s3.ap-southeast-1.amazonaws.com",
          OriginPath: "",
          OriginAccessControlId: (if $mode == "cloudfront-origin-bypass" then "" else "E123OAC456" end)
        }]},
        DefaultCacheBehavior: {
          TargetOriginId: "private-web-s3",
          ViewerProtocolPolicy: "redirect-to-https",
          AllowedMethods: methods,
          Compress: true,
          CachePolicyId: "11111111-1111-4111-8111-111111111111",
          ResponseHeadersPolicyId: "22222222-2222-4222-8222-222222222222",
          FunctionAssociations: {Quantity: (if $mode == "cloudfront-extra-function-association" then 3 else 2 end), Items: ([
            {EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::123456789012:function/slots-prod-primary-release-request"},
            {EventType: "viewer-response", FunctionARN: (if $mode == "cloudfront-response-function-drift"
              then "arn:aws:cloudfront::123456789012:function/foreign-response"
              else "arn:aws:cloudfront::123456789012:function/slots-prod-primary-release-response" end)}
          ] + (if $mode == "cloudfront-extra-function-association" then
            [{EventType: "origin-request", FunctionARN: "arn:aws:cloudfront::123456789012:function/foreign"}] else [] end))},
          LambdaFunctionAssociations: (if $mode == "cloudfront-lambda-association" then
            {Quantity: 1, Items: [{EventType: "viewer-request", LambdaFunctionARN: "arn:aws:lambda:us-east-1:123456789012:function:foreign:1", IncludeBody: false}]}
            else empty_associations end)
        },
        CacheBehaviors: {Quantity: (if $mode == "cloudfront-extra-cache-behavior" then 2 else 1 end),
          Items: ([ordered_behavior] + (if $mode == "cloudfront-extra-cache-behavior" then
            [ordered_behavior + {PathPattern: "admin/*"}] else [] end))},
        Logging: {Enabled: true, IncludeCookies: false,
          Bucket: "slots-production-cloudfront-logs.s3.amazonaws.com", Prefix: "cloudfront/"},
        ViewerCertificate: {
          ACMCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-4333-8333-333333333333",
          MinimumProtocolVersion: "TLSv1.2_2021", SSLSupportMethod: "sni-only"
        }
      }
    }}
  '
  exit 0
fi
if test "$1" = rds; then
  test "$2" = describe-db-instances || fail '只允许回读受合同约束的 RDS 实例'
  shift 2
  region=$(argument_value --region "$@")
  identifier=$(argument_value --db-instance-identifier "$@")
  test "$region" = ap-southeast-1 || fail 'RDS 区域不匹配'
  test "$identifier" = slots-prod-primary-postgresql-reader || fail 'RDS 只读副本 identity 不匹配'
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    {DBInstances: (if $mode == "rds-reader-missing" then [] else [{
      DBInstanceIdentifier: "slots-prod-primary-postgresql-reader",
      DBInstanceArn: "arn:aws:rds:ap-southeast-1:123456789012:db:slots-prod-primary-postgresql-reader",
      DBInstanceStatus: (if $mode == "rds-reader-status-drift" then "modifying" else "available" end),
      ReadReplicaSourceDBInstanceIdentifier: (if $mode == "rds-reader-source-drift" then
        "foreign-postgresql" else "slots-prod-primary-postgresql" end),
      Endpoint: {
        Address: (if $mode == "rds-reader-endpoint-drift" then
          "foreign.abcdefghijkl.ap-southeast-1.rds.amazonaws.com" else
          "slots-prod-primary-postgresql-reader.abcdefghijkl.ap-southeast-1.rds.amazonaws.com" end),
        Port: 5432
      },
      Engine: "postgres",
      EngineVersion: (if $mode == "rds-reader-engine-version-drift" then "16.9" else "17.5" end),
      DBInstanceClass: (if $mode == "rds-reader-instance-class-drift" then
        "db.r7g.2xlarge" else "db.r7g.xlarge" end),
      StorageType: (if $mode == "rds-reader-storage-type-drift" then "gp2" else "gp3" end),
      AllocatedStorage: (if $mode == "rds-reader-allocated-storage-drift" then 499 else 500 end),
      MaxAllocatedStorage: (if $mode == "rds-reader-max-storage-drift" then 1000 else 2000 end),
      PubliclyAccessible: ($mode == "rds-reader-public"),
      MultiAZ: ($mode != "rds-reader-multi-az-drift"),
      DBSubnetGroup: {DBSubnetGroupName: (if $mode == "rds-reader-subnet-drift" then
        "foreign-subnet-group" else "slots-prod-primary-postgresql" end)},
      DBParameterGroups: [{
        DBParameterGroupName: (if $mode == "rds-reader-parameter-drift" then
          "foreign-parameter-group" else "slots-prod-primary-postgresql-20260825000000000000000001" end),
        ParameterApplyStatus: (if $mode == "rds-reader-parameter-pending" then "applying" else "in-sync" end)
      }],
      VpcSecurityGroups: [{
        VpcSecurityGroupId: (if $mode == "rds-reader-security-group-drift" then
          "sg-01111111111111111" else "sg-0fedcba9876543210" end),
        Status: "active"
      }],
      StorageEncrypted: ($mode != "rds-reader-unencrypted"),
      KmsKeyId: (if $mode == "rds-reader-kms-drift" then
        "arn:aws:kms:ap-southeast-1:123456789012:key/33333333-3333-4333-8333-333333333333" else
        "arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111" end),
      BackupRetentionPeriod: (if $mode == "rds-reader-backup-drift" then 0 else 35 end),
      DeletionProtection: ($mode != "rds-reader-deletion-protection-drift"),
      IAMDatabaseAuthenticationEnabled: true,
      AutoMinorVersionUpgrade: false,
      MonitoringInterval: 60,
      PerformanceInsightsEnabled: true,
      EnabledCloudwatchLogsExports: (if $mode == "rds-reader-log-export-drift" then
        ["postgresql"] else ["postgresql", "upgrade"] end),
      PendingModifiedValues: (if $mode == "rds-reader-pending-modification" then
        {DBInstanceClass: "db.r7g.2xlarge"} else {} end)
    }] end)}
  '
  exit 0
fi
if test "$1" = logs; then
  test "$2" = describe-metric-filters || fail '只允许读取受合同约束的 CloudWatch Logs metric filter'
  shift 2
  region=$(argument_value --region "$@")
  log_group=$(argument_value --log-group-name "$@")
  filter_prefix=$(argument_value --filter-name-prefix "$@")
  test "$region" = ap-southeast-1 || fail 'CloudWatch Logs 区域不匹配'
  test "$log_group" = /aws/rds/instance/slots-prod-primary-postgresql/postgresql || fail 'RDS PostgreSQL 日志组不匹配'
  test "$filter_prefix" = slots-prod-primary-postgresql-deadlock-detected || fail 'RDS deadlock filter 前缀不匹配'
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    {metricFilters: (if $mode == "rds-deadlock-filter-missing" then [] else [{
      filterName: "slots-prod-primary-postgresql-deadlock-detected",
      logGroupName: (if $mode == "rds-deadlock-filter-log-group-drift" then
        "/aws/rds/instance/foreign-postgresql/postgresql" else
        "/aws/rds/instance/slots-prod-primary-postgresql/postgresql" end),
      filterPattern: (if $mode == "rds-deadlock-filter-pattern-drift" then
        "\"deadlock_detected\"" else "\"deadlock detected\"" end),
      metricTransformations: [{
        metricName: (if $mode == "rds-deadlock-filter-metric-name-drift" then
          "foreign-deadlock-detected" else "slots-prod-primary-postgresql-deadlock-detected" end),
        metricNamespace: (if $mode == "rds-deadlock-filter-namespace-drift" then
          "AWS/RDS" else "Slots/RDSLogEvents" end),
        metricValue: (if $mode == "rds-deadlock-filter-value-drift" then "0" else "1" end),
        defaultValue: (if $mode == "rds-deadlock-filter-default-drift" then 1 else 0 end),
        unit: (if $mode == "rds-deadlock-filter-unit-drift" then "Bytes" else "Count" end),
        dimensions: (if $mode == "rds-deadlock-filter-dimension-drift" then
          {DBInstanceIdentifier: "slots-prod-primary-postgresql"} else {} end)
      }]
    }] end)}
  '
  exit 0
fi
if test "$1" = cloudwatch; then
  test "$2" = describe-alarms || fail '只允许读取受合同约束的 CloudWatch 告警'
  shift 2
  region=$(argument_value --region "$@")
  test "$region" = ap-southeast-1 || fail 'CloudWatch 区域不匹配'
  case " $* " in
    *" --alarm-name-prefix "*)
      alarm_prefix=$(argument_value --alarm-name-prefix "$@")
      if test "$alarm_prefix" = slots-prod-primary-postgresql-reader-; then
        jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
          def reader_alarm($name; $metric; $statistic; $unit; $threshold; $comparison; $missing): {
            AlarmName: $name,
            ActionsEnabled: ($mode != "rds-reader-alarm-action-drift"),
            AlarmActions: (if $mode == "rds-reader-alarm-action-drift" then [] else
              ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"] end),
            OKActions: ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"],
            InsufficientDataActions: [],
            Namespace: "AWS/RDS",
            MetricName: (if $mode == "rds-reader-alarm-metric-drift" and $metric == "ReplicaLag" then
              "ReadLatency" else $metric end),
            Statistic: (if $mode == "rds-reader-alarm-statistic-drift" and $metric == "ReplicaLag" then
              "Average" else $statistic end),
            Unit: $unit,
            ComparisonOperator: $comparison,
            Period: 60,
            EvaluationPeriods: 3,
            DatapointsToAlarm: 2,
            Threshold: (if $mode == "rds-reader-alarm-threshold-drift" and $metric == "ReplicaLag" then
              $threshold + 1 else $threshold end),
            TreatMissingData: (if $mode == "rds-reader-alarm-missing-data-drift" and $metric == "ReplicaLag" then
              "notBreaching" else $missing end),
            Dimensions: [{Name: "DBInstanceIdentifier", Value:
              (if $mode == "rds-reader-alarm-dimension-drift" and $metric == "ReplicaLag" then
                "foreign-reader" else "slots-prod-primary-postgresql-reader" end)}]
          };
          [
            reader_alarm("slots-prod-primary-postgresql-reader-cpu-high"; "CPUUtilization"; "Average"; "Percent"; 65; "GreaterThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-connections-high"; "DatabaseConnections"; "Maximum"; "Count"; 400; "GreaterThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-read-latency-high"; "ReadLatency"; "Average"; "Seconds"; 0.015; "GreaterThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-disk-queue-high"; "DiskQueueDepth"; "Maximum"; "Count"; 64; "GreaterThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-swap-usage-high"; "SwapUsage"; "Maximum"; "Bytes"; 1073741824; "GreaterThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-freeable-memory-low"; "FreeableMemory"; "Minimum"; "Bytes"; 4294967296; "LessThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-free-storage-low"; "FreeStorageSpace"; "Minimum"; "Bytes"; 107374182400; "LessThanOrEqualToThreshold"; "notBreaching"),
            reader_alarm("slots-prod-primary-postgresql-reader-replica-lag-high"; "ReplicaLag"; "Maximum"; "Seconds"; 30; "GreaterThanOrEqualToThreshold"; "breaching")
          ] | (if $mode == "rds-reader-alarm-missing" then
            map(select(.MetricName != "ReplicaLag")) else . end) | {MetricAlarms: .}
        '
        exit 0
      fi
      test "$alarm_prefix" = slots-prod-primary-postgresql- || fail 'RDS 告警名称前缀不匹配'
      jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
        def rds_alarm($name; $metric; $statistic; $unit; $threshold; $comparison; $evaluations; $datapoints): {
          AlarmName: $name,
          ActionsEnabled: ($mode != "rds-alarm-action-drift"),
          AlarmActions: (if $mode == "rds-alarm-action-drift" then [] else
            ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"] end),
          OKActions: ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"],
          InsufficientDataActions: [],
          Namespace: (if $metric == "Deadlocks" then
            (if $mode == "rds-deadlock-alarm-namespace-drift" then "AWS/RDS" else "Slots/RDSLogEvents" end)
            else "AWS/RDS" end),
          MetricName: (if $metric == "Deadlocks" then
            (if $mode == "rds-deadlock-alarm-metric-name-drift" then "foreign-deadlock-detected"
              else "slots-prod-primary-postgresql-deadlock-detected" end)
            else $metric end),
          Statistic: (if $mode == "rds-deadlock-statistic-drift" and $metric == "Deadlocks" then "Average" else $statistic end),
          Unit: $unit,
          ComparisonOperator: $comparison,
          Period: 60,
          EvaluationPeriods: (if $mode == "rds-deadlock-window-drift" and $metric == "Deadlocks" then 3 else $evaluations end),
          DatapointsToAlarm: (if $mode == "rds-deadlock-window-drift" and $metric == "Deadlocks" then 2 else $datapoints end),
          Threshold: $threshold,
          TreatMissingData: (if $mode == "rds-alarm-missing-data-drift" then "breaching" else "notBreaching" end),
          Dimensions: (if $metric == "Deadlocks" then
            (if $mode == "rds-deadlock-alarm-dimension-drift" then
              [{Name: "DBInstanceIdentifier", Value: "slots-prod-primary-postgresql"}] else [] end)
            else [{Name: "DBInstanceIdentifier", Value:
              (if $mode == "rds-alarm-dimension-drift" then "foreign-postgresql" else "slots-prod-primary-postgresql" end)}] end)
        };
        def rds_math_source($id; $metric; $unit): {
          Id: $id,
          ReturnData: (if $mode == "rds-math-source-return-data-drift" and $id == "m1" then true else false end),
          MetricStat: {
            Metric: {
              Namespace: (if $mode == "rds-math-source-namespace-drift" and $id == "m1" then
                "AWS/EC2" else "AWS/RDS" end),
              MetricName: (if $mode == "rds-alarm-metric-drift" and $metric == "ReadIOPS" then
                "ReplicaLag" else $metric end),
              Dimensions: [{Name: "DBInstanceIdentifier", Value:
                (if $mode == "rds-math-source-dimension-drift" and $id == "m1" then
                  "foreign-postgresql" else "slots-prod-primary-postgresql" end)}]
            },
            Period: (if $mode == "rds-math-source-period-drift" and $id == "m1" then 300 else 60 end),
            Stat: (if $mode == "rds-math-source-statistic-drift" and $id == "m1" then "Sum" else "Average" end),
            Unit: (if $mode == "rds-alarm-unit-drift" and $id == "m1" then "Count" else $unit end)
          }
        };
        def rds_math_alarm($name; $threshold; $unit; $label; $read_metric; $write_metric): {
          AlarmName: $name,
          ActionsEnabled: ($mode != "rds-alarm-action-drift"),
          AlarmActions: (if $mode == "rds-alarm-action-drift" then [] else
            ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"] end),
          OKActions: ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"],
          InsufficientDataActions: [],
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          EvaluationPeriods: 3,
          DatapointsToAlarm: 2,
          Threshold: (if $mode == "rds-alarm-threshold-drift" and ($name | endswith("total-throughput-high"))
            then $threshold + 1 else $threshold end),
          TreatMissingData: (if $mode == "rds-alarm-missing-data-drift" then "breaching" else "notBreaching" end),
          Metrics: ([
            {Id: "e1", Expression: (if $mode == "rds-math-expression-drift" then "m1" else "m1 + m2" end),
              Label: $label, ReturnData: ($mode != "rds-math-expression-return-data-drift")},
            rds_math_source("m1"; $read_metric; $unit),
            rds_math_source("m2"; $write_metric; $unit)
          ] + (if $mode == "rds-math-extra-query" then
            [{Id: "m3", ReturnData: false, MetricStat: {Metric: {Namespace: "AWS/RDS", MetricName: "ReplicaLag",
              Dimensions: [{Name: "DBInstanceIdentifier", Value: "slots-prod-primary-postgresql"}]},
              Period: 60, Stat: "Average", Unit: "Seconds"}}] else [] end))
        };
        [
          rds_alarm("slots-prod-primary-postgresql-cpu-high"; "CPUUtilization"; "Average"; "Percent"; 65; "GreaterThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-connections-high"; "DatabaseConnections"; "Maximum"; "Count"; 400; "GreaterThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-read-latency-high"; "ReadLatency"; "Average"; "Seconds"; 0.015; "GreaterThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-write-latency-high"; "WriteLatency"; "Average"; "Seconds"; 0.015; "GreaterThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-disk-queue-high"; "DiskQueueDepth"; "Maximum"; "Count"; 64; "GreaterThanOrEqualToThreshold"; 3; 2),
          rds_math_alarm("slots-prod-primary-postgresql-total-iops-high"; 9600; "Count/Second"; "Total RDS IOPS"; "ReadIOPS"; "WriteIOPS"),
          rds_math_alarm("slots-prod-primary-postgresql-total-throughput-high"; 419430400; "Bytes/Second"; "Total RDS throughput"; "ReadThroughput"; "WriteThroughput"),
          rds_alarm("slots-prod-primary-postgresql-swap-usage-high"; "SwapUsage"; "Maximum"; "Bytes"; 1073741824; "GreaterThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-freeable-memory-low"; "FreeableMemory"; "Minimum"; "Bytes"; 4294967296; "LessThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-free-storage-low"; "FreeStorageSpace"; "Minimum"; "Bytes"; 107374182400; "LessThanOrEqualToThreshold"; 3; 2),
          rds_alarm("slots-prod-primary-postgresql-deadlocks"; "Deadlocks"; "Sum"; "Count"; 1; "GreaterThanOrEqualToThreshold"; 1; 1)
        ] | (if $mode == "rds-alarm-missing" then map(select(.AlarmName != "slots-prod-primary-postgresql-deadlocks")) else . end) |
        {MetricAlarms: .}
      '
      exit 0
      ;;
  esac
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    def alarm($name; $metric; $threshold): {
      AlarmName: $name,
      ActionsEnabled: ($mode != "waf-alarm-disabled"),
      AlarmActions: ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"],
      OKActions: ["arn:aws:sns:ap-southeast-1:123456789012:slots-prod-primary-alerts"],
      Namespace: "AWS/WAFV2",
      MetricName: (if $mode == "waf-alarm-metric-name-drift" and ($name | endswith("allowed-request-cost"))
        then "BlockedRequests" else $metric end),
      Statistic: (if $mode == "waf-alarm-statistic-drift" then "Average" else "Sum" end),
      ComparisonOperator: (if $mode == "waf-alarm-comparison-drift" then "LessThanThreshold"
        else "GreaterThanOrEqualToThreshold" end),
      Period: 60, EvaluationPeriods: 1, DatapointsToAlarm: 1,
      Threshold: $threshold, TreatMissingData: "notBreaching",
      Dimensions: [
        {Name: "Region", Value: "ap-southeast-1"},
        {Name: "Rule", Value: "ALL"},
        {Name: "WebACL", Value: (if $mode == "waf-alarm-metric-dimension-drift"
          then "slots-prod-primary-api" else "slots_prod_primary_api" end)}
      ]
    };
    {MetricAlarms: [
      alarm("slots-prod-primary-waf-allowed-request-cost"; "AllowedRequests"; 100000),
      alarm("slots-prod-primary-waf-blocked-requests"; "BlockedRequests"; 1000)
    ]}
  '
  exit 0
fi
if test "$1" = iam; then
  test "$2" = get-role-policy || fail '只允许读取 Cluster Autoscaler 内联策略'
  shift 2
  role_name=$(argument_value --role-name "$@")
  policy_name=$(argument_value --policy-name "$@")
  test "$role_name" = slots-cluster-autoscaler || fail 'Cluster Autoscaler role 名不匹配'
  test "$policy_name" = scale-managed-node-groups || fail 'Cluster Autoscaler policy 名不匹配'
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    [
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeAutoScalingInstances",
      "autoscaling:DescribeLaunchConfigurations",
      "autoscaling:DescribeScalingActivities",
      "autoscaling:DescribeTags",
      "ec2:DescribeImages",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:GetInstanceTypesFromInstanceRequirements",
      "eks:DescribeNodegroup"
    ] as $expected |
    (if $mode == "autoscaler-policy-missing-describe-tags" then
      [$expected[] | select(. != "autoscaling:DescribeTags")]
    elif $mode == "autoscaler-policy-wildcard" then
      ["autoscaling:*"]
    else $expected end) as $actions |
    {RoleName: "slots-cluster-autoscaler", PolicyName: "scale-managed-node-groups",
      PolicyDocument: {Version: "2012-10-17", Statement: [{Sid: "ReadCapacityMetadata",
        Effect: "Allow", Action: $actions, Resource: "*"}]}}
  '
  exit 0
fi
test "$1" = eks || fail '只允许 EKS、WAF、CloudFront、CloudWatch 或固定 IAM 只读 API'
operation=$2
shift 2
cluster_name=$(argument_value --cluster-name "$@")
test "$cluster_name" = slots-prod-primary || fail '集群名不匹配'

case "$operation" in
  describe-addon)
    addon_name=$(argument_value --addon-name "$@")
    region=$(argument_value --region "$@")
    test "$region" = ap-southeast-1 || fail 'EKS add-on区域不匹配'
    case "$addon_name" in
      metrics-server)
        status=ACTIVE
        if test "${MOCK_PLATFORM_MODE:-valid}" = metrics-server-degraded; then
          status=DEGRADED
        fi
        jq -n --arg status "$status" '
          {addon: {addonName: "metrics-server", addonVersion: "v0.7.2-eksbuild.1", status: $status}}
        '
        ;;
      vpc-cni)
        status=ACTIVE
        enabled=true
        if test "${MOCK_PLATFORM_MODE:-valid}" = vpc-cni-degraded; then
          status=DEGRADED
        fi
        if test "${MOCK_PLATFORM_MODE:-valid}" = vpc-cni-network-policy-disabled; then
          enabled=false
        fi
        jq -n --arg status "$status" --arg enabled "$enabled" '
          {addon: {
            addonName: "vpc-cni",
            addonVersion: "v1.18.3-eksbuild.2",
            status: $status,
            configurationValues: ({enableNetworkPolicy: $enabled} | tojson)
          }}
        '
        ;;
      amazon-cloudwatch-observability)
        status=ACTIVE
        if test "${MOCK_PLATFORM_MODE:-valid}" = cloudwatch-observability-degraded; then
          status=DEGRADED
        fi
        jq -n --arg status "$status" --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
          {addon: {
            addonName: "amazon-cloudwatch-observability",
            addonVersion: "v2.3.0-eksbuild.1",
            status: $status,
            configurationValues: ({
              agent: {config: {logs: {metrics_collected: {kubernetes: {
                enhanced_container_insights: ($mode != "cloudwatch-observability-config-drift")
              }}}}},
              containerLogs: {enabled: ($mode != "cloudwatch-container-logs-disabled")}
            } | tojson)
          }}
        '
        ;;
      *) fail 'EKS add-on 名称不匹配' ;;
    esac
    ;;
  list-pod-identity-associations)
    namespace=$(argument_value --namespace "$@")
    service_account=$(argument_value --service-account "$@")
    case "$namespace/$service_account" in
      kube-system/cluster-autoscaler) association_id=pia-cluster-autoscaler ;;
      kube-system/aws-load-balancer-controller) association_id=pia-load-balancer ;;
      kube-system/aws-node) association_id=pia-vpc-cni ;;
      amazon-cloudwatch/cloudwatch-agent) association_id=pia-cloudwatch-agent ;;
      external-secrets/external-secrets) association_id=pia-external-secrets ;;
      monitoring/prometheus-agent) association_id=pia-prometheus-agent ;;
      *) fail '未知 Pod Identity 查询边界' ;;
    esac
    jq -n --arg association_id "$association_id" \
      '{associations: [{associationId: $association_id}]}'
    ;;
  describe-pod-identity-association)
    association_id=$(argument_value --association-id "$@")
    case "$association_id" in
      pia-cluster-autoscaler)
        namespace=kube-system
        service_account=cluster-autoscaler
        role_arn=arn:aws:iam::123456789012:role/slots-cluster-autoscaler
        ;;
      pia-load-balancer)
        namespace=kube-system
        service_account=aws-load-balancer-controller
        role_arn=arn:aws:iam::123456789012:role/slots-load-balancer-controller
        ;;
      pia-vpc-cni)
        namespace=kube-system
        service_account=aws-node
        role_arn=arn:aws:iam::123456789012:role/slots-vpc-cni
        ;;
      pia-cloudwatch-agent)
        namespace=amazon-cloudwatch
        service_account=cloudwatch-agent
        role_arn=arn:aws:iam::123456789012:role/slots-cloudwatch-agent
        ;;
      pia-external-secrets)
        namespace=external-secrets
        service_account=external-secrets
        role_arn=arn:aws:iam::123456789012:role/slots-external-secrets
        ;;
      pia-prometheus-agent)
        namespace=monitoring
        service_account=prometheus-agent
        role_arn=arn:aws:iam::123456789012:role/slots-prometheus-agent
        ;;
      *) fail '未知 Pod Identity association ID' ;;
    esac
    if test "${MOCK_PLATFORM_MODE:-valid}" = pod-identity-drift && \
      test "$association_id" = pia-external-secrets; then
      role_arn=arn:aws:iam::123456789012:role/forbidden-shared-role
    fi
    if test "${MOCK_PLATFORM_MODE:-valid}" = vpc-cni-pod-identity-drift && \
      test "$association_id" = pia-vpc-cni; then
      role_arn=arn:aws:iam::123456789012:role/forbidden-vpc-cni-role
    fi
    if test "${MOCK_PLATFORM_MODE:-valid}" = cloudwatch-pod-identity-drift && \
      test "$association_id" = pia-cloudwatch-agent; then
      role_arn=arn:aws:iam::123456789012:role/forbidden-cloudwatch-role
    fi
    jq -n --arg cluster "$cluster_name" --arg namespace "$namespace" \
      --arg service_account "$service_account" --arg role_arn "$role_arn" '
      {
        association: {
          clusterName: $cluster,
          namespace: $namespace,
          serviceAccount: $service_account,
          roleArn: $role_arn
        }
      }
    '
    ;;
  *) fail '未知 EKS API' ;;
esac
