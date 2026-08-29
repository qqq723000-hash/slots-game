#!/usr/bin/env bash
# 发布或检查固定版本的 HMAC 证据取消/完成标记，阻止已结束证据重放。
# English: Issue or check a fixed version of HMAC evidence cancellation/completion flags, preventing completed
# evidence replay.
set -euo pipefail

test "$#" -ge 2 || {
  printf '%s\n' '用法: hmac-evidence-marker.sh <check|publish> <cancellation|completion|all> <evidence.json>' >&2
  exit 1
}
operation=$1
marker_type=$2
evidence_file=${3:-}
AWS_BIN=${AWS_BIN:-aws}
temporary_directory=$(mktemp -d "${RUNNER_TEMP:-/tmp}/slots-hmac-marker.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf '%s\n' "HMAC 证据 marker 失败：$*" >&2
  exit 1
}

test -f "$evidence_file" || fail '找不到固定证据文件'
evidence_version=$INPUT_EVIDENCE_VERSION_ID
evidence_sha=$INPUT_EVIDENCE_SHA256
test "${#evidence_version}" -le 1024
printf '%s\n' "$evidence_version" | grep -Eq '^[A-Za-z0-9._~+/=-]+$' || fail '证据 VersionId 格式错误'
printf '%s\n' "$evidence_sha" | grep -Eq '^[0-9a-f]{64}$' || fail '证据 SHA-256 格式错误'
test "$(sha256sum "$evidence_file" | awk '{ print $1 }')" = "$evidence_sha" || fail '证据文件 SHA-256 不匹配'
reference_hash=$(printf '%s\n%s' "$evidence_version" "$evidence_sha" | sha256sum | awk '{ print $1 }')

key_for() {
  prefix=''
  case "$1" in
    cancellation) prefix=$AWS_HMAC_QUIESCE_CANCELLATION_PREFIX ;;
    completion) prefix=$AWS_HMAC_QUIESCE_COMPLETION_PREFIX ;;
    *) fail 'marker 类型不合法' ;;
  esac
  printf '%s/%s.json\n' "${prefix%/}" "$reference_hash"
}

read_marker() {
  type=$1
  key=$(key_for "$type")
  head_file="$temporary_directory/$type-head.json"
  error_file="$temporary_directory/$type-head.error"
  if ! "$AWS_BIN" s3api head-object --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
    --key "$key" --output json > "$head_file" 2> "$error_file"; then
    grep -Eq '(404|NoSuchKey|Not Found)' "$error_file" || fail "无法失败闭合地读取 $type marker"
    return 1
  fi
  version=$(jq -er '.VersionId | select(. != "null")' "$head_file")
  marker_file="$temporary_directory/$type.json"
  "$AWS_BIN" s3api get-object --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" --key "$key" \
    --version-id "$version" "$marker_file" >/dev/null
  marker_sha=$(sha256sum "$marker_file" | awk '{ print $1 }')
  jq -e --arg version "$version" --arg kms "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN" \
    --arg sha "$marker_sha" --arg environment "$TARGET_ENVIRONMENT" --arg type "$type" \
    --arg reference_hash "$reference_hash" '
      .VersionId == $version and .ContentLength > 0 and .ContentType == "application/json" and
      .CacheControl == "no-store" and .ServerSideEncryption == "aws:kms" and .SSEKMSKeyId == $kms and
      .Metadata["schema-version"] == "slots-hmac-marker-v1" and
      .Metadata["content-sha256"] == $sha and .Metadata["target-environment"] == $environment and
      .Metadata["marker-type"] == $type and
      .Metadata["evidence-reference-sha256"] == $reference_hash
    ' "$head_file" >/dev/null || fail "$type marker metadata 不可信"
  canonical="$temporary_directory/$type-canonical.json"
  jq -S -c '.' "$marker_file" > "$canonical"
  cmp -s "$marker_file" "$canonical" || fail "$type marker 不是规范化 JSON"
  jq -e --arg type "$type" --arg bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
    --arg key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" --arg evidence_version "$evidence_version" \
    --arg evidence_sha "$evidence_sha" --arg environment "$TARGET_ENVIRONMENT" \
    --arg repository "$GITHUB_REPOSITORY" '
      .schema_version == "slots-game/hmac-quiesce-marker/v1" and .marker_type == $type and
      .evidence_reference == {
        bucket: $bucket, key: $key, version_id: $evidence_version, sha256: $evidence_sha
      } and .target_environment == $environment and
      (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) and
      .producer.repository == $repository and
      (.producer.run_id | type == "string" and test("^[1-9][0-9]*$")) and
      (.producer.run_attempt | type == "string" and test("^[1-9][0-9]*$")) and
      (.producer.source_sha | type == "string" and test("^[0-9a-f]{40}$")) and
      (keys | sort) == ["created_at", "evidence_reference", "marker_type", "producer", "schema_version", "target_environment"]
    ' "$marker_file" >/dev/null || fail "$type marker 内容不可信"
}

publish_marker() {
  type=$1
  key=$(key_for "$type")
  if read_marker "$type"; then
    jq -er '.VersionId' "$temporary_directory/$type-head.json"
    return 0
  fi
  marker_file="$temporary_directory/$type.json"
  created_at=$(ruby -rtime -e 'puts Time.now.utc.iso8601')
  jq -n -S -c --arg type "$type" --arg bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
    --arg key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" --arg version "$evidence_version" \
    --arg sha "$evidence_sha" --arg created "$created_at" --arg repository "$GITHUB_REPOSITORY" \
    --arg run_id "$GITHUB_RUN_ID" --arg run_attempt "$GITHUB_RUN_ATTEMPT" --arg source "$GITHUB_SHA" \
    --arg environment "$TARGET_ENVIRONMENT" '{
      schema_version: "slots-game/hmac-quiesce-marker/v1", marker_type: $type,
      evidence_reference: {bucket: $bucket, key: $key, version_id: $version, sha256: $sha},
      producer: {repository: $repository, run_id: $run_id, run_attempt: $run_attempt, source_sha: $source},
      target_environment: $environment, created_at: $created
    }' > "$marker_file"
  marker_sha=$(sha256sum "$marker_file" | awk '{ print $1 }')
  put_file="$temporary_directory/$type-put.json"
  "$AWS_BIN" s3api put-object --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" --key "$key" \
    --body "$marker_file" --content-type application/json --cache-control no-store \
    --server-side-encryption aws:kms --ssekms-key-id "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN" \
    --if-none-match '*' \
    --metadata "schema-version=slots-hmac-marker-v1,content-sha256=${marker_sha},target-environment=${TARGET_ENVIRONMENT},marker-type=${type},evidence-reference-sha256=${reference_hash}" \
    --output json > "$put_file"
  version=$(jq -er '.VersionId | select(. != "null")' "$put_file")
  read_marker "$type" || fail "$type marker 发布后不可读"
  printf '%s\n' "$version"
}

case "$operation/$marker_type" in
  check/all)
    if read_marker cancellation; then fail '证据已经取消，禁止重放'; fi
    if read_marker completion; then fail '证据已经完成，禁止重放'; fi
    printf '%s\n' 'HMAC evidence cancellation/completion marker 均不存在。'
    ;;
  check/cancellation|check/completion)
    if read_marker "$marker_type"; then fail "证据已经存在 $marker_type marker，禁止继续"; fi
    printf '%s\n' "HMAC evidence $marker_type marker 不存在。"
    ;;
  publish/cancellation|publish/completion)
    publish_marker "$marker_type"
    ;;
  *) fail 'marker 操作不合法' ;;
esac
