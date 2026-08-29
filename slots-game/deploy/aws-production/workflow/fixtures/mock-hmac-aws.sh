#!/usr/bin/env bash
# HMAC 停机证据测试专用 AWS CLI；所有对象都保存在测试临时目录。
# English: HMAC outage evidence test-specific AWS CLI; all objects are saved in the test temporary directory.
set -euo pipefail

service=${1:-}
operation=${2:-}
shift 2 || true

argument() {
  target=$1
  shift
  while test "$#" -gt 0; do
    if test "$1" = "$target"; then
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

marker_identity() {
  key=$1
  case "$key" in
    "$AWS_HMAC_QUIESCE_CANCELLATION_PREFIX"/*.json) marker_type=cancellation ;;
    "$AWS_HMAC_QUIESCE_COMPLETION_PREFIX"/*.json) marker_type=completion ;;
    *) return 1 ;;
  esac
  marker_hash=${key##*/}
  marker_hash=${marker_hash%.json}
  printf '%s\n' "$marker_hash" | grep -Eq '^[0-9a-f]{64}$' || return 1
  marker_path="$MOCK_HMAC_STATE_DIR/${marker_type}-marker-${marker_hash}"
}

case "$service/$operation" in
  sts/get-caller-identity)
    jq -n --arg account "$AWS_ACCOUNT_ID" --arg role "${AWS_HMAC_QUIESCE_ROLE_ARN##*/}" \
      --arg run "$GITHUB_RUN_ID" '{
        Account: $account,
        Arn: ("arn:aws:sts::" + $account + ":assumed-role/" + $role + "/slots-hmac-quiesce-" + $run),
        UserId: "fixture"
      }'
    ;;
  eks/describe-cluster)
    status=ACTIVE
    private_access=true
    public_access=false
    cluster_arn="arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${AWS_EKS_CLUSTER_NAME}"
    case "${MOCK_HMAC_AWS_MODE:-}" in
      inactive-cluster) status=UPDATING ;;
      public-cluster-endpoint) public_access=true ;;
      wrong-cluster-arn)
        cluster_arn="arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/other-cluster"
        ;;
    esac
    jq -n --arg arn "$cluster_arn" --arg status "$status" \
      --argjson private_access "$private_access" --argjson public_access "$public_access" '{
        cluster: {
          arn: $arn,
          status: $status,
          resourcesVpcConfig: {
            endpointPrivateAccess: $private_access,
            endpointPublicAccess: $public_access
          }
        }
      }'
    ;;
  eks/update-kubeconfig)
    kubeconfig=$(argument --kubeconfig "$@")
    printf '%s\n' 'fixture' > "$kubeconfig"
    ;;
  s3api/get-bucket-versioning)
    printf '%s\n' 'Enabled'
    ;;
  s3api/head-object)
    key=$(argument --key "$@")
    version=$(argument --version-id "$@" 2>/dev/null || true)
    if test "$key" = "$AWS_TERRAFORM_DELIVERY_KEY"; then
      test -z "$version" || test "$version" = delivery-version-1
      kms=$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN
      delivery_sha=$(sha256sum "$MOCK_HMAC_DELIVERY_FILE" | awk '{ print $1 }')
      test "${MOCK_HMAC_AWS_MODE:-}" != wrong-delivery-kms || kms=arn:aws:kms:us-east-1:123456789012:key/ffffffff-ffff-ffff-ffff-ffffffffffff
      jq -n --arg kms "$kms" --arg target "$TARGET_ENVIRONMENT" --arg account "$AWS_ACCOUNT_ID" \
        --arg region "$AWS_REGION" --arg delivery_sha "$delivery_sha" '{
          VersionId: "delivery-version-1", ContentLength: 4096,
          ContentType: "application/json", CacheControl: "no-store",
          ServerSideEncryption: "aws:kms", SSEKMSKeyId: $kms,
          Metadata: {
            "schema-version": "1", "content-sha256": $delivery_sha, "target-environment": $target,
            "aws-account-id": $account, "aws-region": $region
          }
        }'
    elif test "$key" = "$AWS_HMAC_QUIESCE_EVIDENCE_KEY"; then
      test "$version" = evidence-version-1
      test -f "$MOCK_HMAC_STATE_DIR/evidence.json"
      metadata=$(cat "$MOCK_HMAC_STATE_DIR/evidence-metadata")
      content_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*content-sha256=\([^,]*\).*/\1/p')
      observed=$(printf '%s\n' "$metadata" | sed -n 's/.*observed-at=\([^,]*\).*/\1/p')
      expires=$(printf '%s\n' "$metadata" | sed -n 's/.*expires-at=\([^,]*\).*/\1/p')
      repository_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*producer-repository-sha256=\([^,]*\).*/\1/p')
      workflow_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*producer-workflow-ref-sha256=\([^,]*\).*/\1/p')
      role_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*producer-role-arn-sha256=\([^,]*\).*/\1/p')
      source_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*source-sha=\([^,]*\).*/\1/p')
      kms=$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN
      test "${MOCK_HMAC_AWS_MODE:-}" != wrong-evidence-kms || kms=arn:aws:kms:us-east-1:123456789012:key/ffffffff-ffff-ffff-ffff-ffffffffffff
      jq -n --arg kms "$kms" --arg sha "$content_sha" --arg target "$TARGET_ENVIRONMENT" \
        --arg account "$AWS_ACCOUNT_ID" --arg region "$AWS_REGION" \
        --arg repository_sha "$repository_sha" --arg workflow_sha "$workflow_sha" \
        --arg role_sha "$role_sha" --arg source_sha "$source_sha" \
        --arg observed "$observed" --arg expires "$expires" '{
          VersionId: "evidence-version-1", ContentLength: 8192,
          ContentType: "application/json", CacheControl: "no-store",
          ServerSideEncryption: "aws:kms", SSEKMSKeyId: $kms,
          Metadata: {
            "schema-version": "slots-hmac-quiesce-v1", "content-sha256": $sha,
            "target-environment": $target, "aws-account-id": $account, "aws-region": $region,
            "producer-repository-sha256": $repository_sha,
            "producer-workflow-ref-sha256": $workflow_sha,
            "producer-role-arn-sha256": $role_sha,
            "workflow-run-id": "9001", "workflow-run-attempt": "1", "source-sha": $source_sha,
            "observed-at": $observed, "expires-at": $expires
          }
        }'
    else
      marker_identity "$key"
      type=$marker_type
      marker_file="${marker_path}.json"
      marker_metadata="${marker_path}.metadata"
      if ! test -f "$marker_file"; then
        printf '%s\n' 'An error occurred (404) when calling the HeadObject operation: Not Found' >&2
        exit 254
      fi
      marker_version="$type-$marker_hash-version-1"
      test -z "$version" || test "$version" = "$marker_version"
      metadata=$(cat "$marker_metadata")
      content_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*content-sha256=\([^,]*\).*/\1/p')
      reference_sha=$(printf '%s\n' "$metadata" | sed -n 's/.*evidence-reference-sha256=\([^,]*\).*/\1/p')
      jq -n --arg version "$marker_version" --arg kms "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN" \
        --arg sha "$content_sha" --arg target "$TARGET_ENVIRONMENT" --arg type "$type" \
        --arg reference_sha "$reference_sha" '{
          VersionId: $version, ContentLength: 1024, ContentType: "application/json",
          CacheControl: "no-store", ServerSideEncryption: "aws:kms", SSEKMSKeyId: $kms,
          Metadata: {"schema-version": "slots-hmac-marker-v1", "content-sha256": $sha,
            "target-environment": $target, "marker-type": $type,
            "evidence-reference-sha256": $reference_sha}
        }'
    fi
    ;;
  s3api/get-object)
    key=$(argument --key "$@")
    version=$(argument --version-id "$@")
    output=${!#}
    if test "$key" = "$AWS_TERRAFORM_DELIVERY_KEY"; then
      test "$version" = delivery-version-1
      cp "$MOCK_HMAC_DELIVERY_FILE" "$output"
    elif test "$key" = "$AWS_HMAC_QUIESCE_EVIDENCE_KEY"; then
      test "$version" = evidence-version-1
      cp "$MOCK_HMAC_STATE_DIR/evidence.json" "$output"
    else
      marker_identity "$key"
      type=$marker_type
      test "$version" = "$type-$marker_hash-version-1"
      cp "${marker_path}.json" "$output"
    fi
    jq -n --arg version "$version" '{VersionId: $version}'
    ;;
  s3api/put-object)
    test "${MOCK_HMAC_AWS_MODE:-}" != put-failure || exit 45
    key=$(argument --key "$@")
    body=$(argument --body "$@")
    metadata=$(argument --metadata "$@")
    if test "$key" = "$AWS_HMAC_QUIESCE_EVIDENCE_KEY"; then
      cp "$body" "$MOCK_HMAC_STATE_DIR/evidence.json"
      printf '%s\n' "$metadata" > "$MOCK_HMAC_STATE_DIR/evidence-metadata"
      jq -n '{VersionId: "evidence-version-1", SSEKMSKeyId: env.AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN}'
    else
      test "${MOCK_HMAC_AWS_MODE:-}" != marker-put-failure || exit 46
      marker_identity "$key"
      type=$marker_type
      test ! -f "${marker_path}.json" || {
        printf '%s\n' 'An error occurred (PreconditionFailed) when calling PutObject' >&2
        exit 254
      }
      cp "$body" "${marker_path}.json"
      printf '%s\n' "$metadata" > "${marker_path}.metadata"
      jq -n --arg version "$type-$marker_hash-version-1" '{VersionId: $version}'
    fi
    ;;
  *)
    printf '%s\n' "未实现的 mock AWS 调用：$service $operation $*" >&2
    exit 64
    ;;
esac
