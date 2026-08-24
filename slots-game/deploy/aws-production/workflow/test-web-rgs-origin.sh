#!/bin/sh

# 纯本地负向夹具：已签名 Web 配置只能指向当前 Helm release 的唯一 API Ingress Origin。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_directory/verify-web-rgs-origin.rb"
mock_kubectl="$script_directory/fixtures/mock-live-kubectl.sh"
temporary_parent=${TMPDIR:-/tmp}
temporary_root=$(mktemp -d "${temporary_parent%/}/slots-web-rgs-origin.XXXXXX")

fail() {
  printf '%s\n' "AWS Web RGS Origin fixture：$*" >&2
  exit 1
}

cleanup() {
  case "$temporary_root" in
    "${temporary_parent%/}"/slots-web-rgs-origin.*) rm -rf -- "$temporary_root" ;;
    *) fail "拒绝清理异常路径 $temporary_root" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

delivery="$temporary_root/delivery.json"
evidence="$temporary_root/evidence"
mkdir -m 0700 "$evidence"
printf '%s\n' '{"helm_release_name":"slots"}' > "$delivery"

write_identity() {
  base_url=$1
  printf "default-src 'self'; connect-src 'self' %s; frame-ancestors https://host.example.com;\n" \
    "$base_url" > "$evidence/cloudfront-content-security-policy.txt"
  csp_sha256=$(sha256sum "$evidence/cloudfront-content-security-policy.txt" | awk '{ print $1 }')
  {
    printf 'WEB_IMAGE_DIGEST=sha256:%064d\n' 1
    printf 'CONFIGURATION_SHA256=%064d\n' 2
    printf 'RELEASE_ID=sha256:%064d\n' 3
    printf 'RELEASE_REVISION=%040d\n' 4
    printf 'CLOUDFRONT_CSP_SHA256=%s\n' "$csp_sha256"
  } > "$evidence/aws-web-delivery.env"
}

expect_rejected() {
  label=$1
  base_url=$2
  write_identity "$base_url"
  if KUBECTL_BIN="$mock_kubectl" ruby "$verifier" "$delivery" slots-production "$evidence" \
    >/dev/null 2>&1; then
    fail "$label 被错误接受"
  fi
}

write_identity https://api.example.com
KUBECTL_BIN="$mock_kubectl" ruby "$verifier" "$delivery" slots-production "$evidence" >/dev/null || \
  fail '与实际 Ingress 一致的 RGS Origin 被错误拒绝'

expect_rejected 'foreign RGS Origin' https://foreign.example.com
expect_rejected '带 path 的 RGS URL' https://api.example.com/client
expect_rejected '带 query 的 RGS URL' 'https://api.example.com?target=foreign'
expect_rejected '带 userinfo 的 RGS URL' https://user@api.example.com
expect_rejected '带显式端口的 RGS URL' https://api.example.com:443

printf '%s\n' 'AWS Web RGS Origin 正负向夹具通过。'
