#!/bin/sh

# 本脚本只从调用方已完成 Cosign/attestation 验证并按 digest 拉取的 Web 镜像提取 S3 输入。
# 它不会接受 tag，也不会读取工作区 web/dist；docker create 只建立文件系统视图，不启动镜像。
set -eu
umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
static_verifier="$script_dir/verify-web-static-root.mjs"

fail() {
  printf '%s\n' "AWS Web static extraction: $*" >&2
  exit 1
}

test "$#" -eq 4 || fail 'usage: extract-aws-web-static-root.sh IMAGE@SHA256 STATIC_ROOT EVIDENCE_DIR CONFIGURATION_SHA256'
image_reference=$1
static_root=$2
evidence_dir=$3
configuration_sha256=$4

case "$image_reference" in
  *@sha256:*) image_digest=${image_reference##*@} ;;
  *) fail 'Web image must be addressed by an immutable sha256 digest, never a tag' ;;
esac
printf '%s\n' "$image_reference" | \
  grep -Eq '^[a-z0-9][a-z0-9.-]*([:][0-9]{1,5})?/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$' || \
  fail 'Web image reference is not canonical'
printf '%s\n' "$configuration_sha256" | grep -Eq '^[0-9a-f]{64}$' || \
  fail 'CONFIGURATION_SHA256 must be a lowercase SHA-256 digest'

command -v docker >/dev/null 2>&1 || fail 'docker is required to inspect the verified OCI digest'
command -v node >/dev/null 2>&1 || fail 'node is required to verify release-manifest'
command -v jq >/dev/null 2>&1 || fail 'jq is required to record release identity'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
test -f "$static_verifier" || fail 'static-root verifier is missing'
test ! -e "$static_root" || fail 'STATIC_ROOT must not already exist'
test ! -e "$evidence_dir" || fail 'EVIDENCE_DIR must not already exist'
mkdir -m 0755 "$static_root"
mkdir -m 0700 "$evidence_dir"

# 只接受调用方预先拉取并验证的本地 digest；本脚本不隐式 pull，也不以 tag 重新解析目标。
docker image inspect "$image_reference" >/dev/null 2>&1 || \
  fail 'verified immutable Web image is not present locally'
container_id=$(docker create "$image_reference") || fail 'cannot create a filesystem view of the verified Web image'
cleanup() {
  docker rm --force "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker cp "$container_id:/usr/share/nginx/html/." "$static_root" || \
  fail 'cannot extract the Web static root from the verified digest'
docker cp "$container_id:/etc/nginx/conf.d/default.conf" "$evidence_dir/release-nginx.conf" || \
  fail 'cannot extract the release CSP configuration from the verified digest'
node "$static_verifier" "$static_root" >/dev/null

# CloudFront Response Headers Policy 必须复制同一 OCI digest 内唯一的 CSP，不能另写第二套宽松策略。
# shellcheck disable=SC2016
CSP_CONFIG="$evidence_dir/release-nginx.conf" CSP_OUTPUT="$evidence_dir/cloudfront-content-security-policy.txt" \
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const source = readFileSync(process.env.CSP_CONFIG, "utf8");
    const matches = [...source.matchAll(/^[\t ]*add_header[\t ]+Content-Security-Policy[\t ]+"([^"\r\n]*)"[\t ]+always;[\t ]*$/gim)];
    if (matches.length !== 1) process.exit(1);
    const policy = matches[0][1];
    const directives = new Map();
    for (const segment of policy.split(";")) {
      const fields = segment.trim().split(/[\t ]+/);
      if (fields.length < 2 || directives.has(fields[0])) process.exit(1);
      directives.set(fields[0], fields.slice(1));
    }
    const required = ["default-src", "script-src", "style-src", "img-src", "font-src", "media-src", "connect-src", "worker-src", "object-src", "base-uri", "form-action", "trusted-types", "require-trusted-types-for", "frame-ancestors"];
    if (directives.size !== required.length || required.some((name) => !directives.has(name))) process.exit(1);
    const exact = new Map([
      ["default-src", "\u0027self\u0027"],
      ["script-src", "\u0027self\u0027 \u0027sha256-vUs+nbdxmdqOL3f/mZqTupLfHkYf373z+iYtj/+kHtM=\u0027"],
      ["style-src", "\u0027self\u0027 \u0027unsafe-inline\u0027"],
      ["img-src", "\u0027self\u0027 data: blob:"],
      ["font-src", "\u0027self\u0027"],
      ["media-src", "\u0027self\u0027 blob:"],
      ["worker-src", "\u0027self\u0027 blob:"],
      ["object-src", "\u0027none\u0027"],
      ["base-uri", "\u0027self\u0027"],
      ["form-action", "\u0027none\u0027"],
      ["trusted-types", "slots-game-static-html"],
      ["require-trusted-types-for", "\u0027script\u0027"],
    ]);
    if ([...exact].some(([name, value]) => directives.get(name).join(" ") !== value)) process.exit(1);
    const exactHttpsOrigin = (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
          && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "" && parsed.origin === value;
      } catch {
        return false;
      }
    };
    const connectSources = directives.get("connect-src");
    const frameSources = directives.get("frame-ancestors");
    if (connectSources.length !== 2 || connectSources[0] !== "\u0027self\u0027" || !exactHttpsOrigin(connectSources[1])) process.exit(1);
    if (frameSources.length !== 1 || !exactHttpsOrigin(frameSources[0])) process.exit(1);
    if (policy.includes("*") || /[\r\n\\]/.test(policy)) process.exit(1);
    writeFileSync(process.env.CSP_OUTPUT, `${policy}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  ' || fail 'release image does not contain one exact fail-closed CloudFront CSP'

release_id=$(jq -er '.releaseId | select(test("^sha256:[0-9a-f]{64}$"))' "$static_root/release-manifest.json") || \
  fail 'release manifest has no canonical release ID'
release_revision=$(jq -er '.revision | select(test("^[0-9a-f]{40}$|^[0-9a-f]{64}$"))' "$static_root/release-manifest.json") || \
  fail 'release manifest has no complete source revision'
csp_sha256=$(sha256sum "$evidence_dir/cloudfront-content-security-policy.txt" | awk '{ print $1 }')
{
  printf 'WEB_IMAGE_DIGEST=%s\n' "$image_digest"
  printf 'CONFIGURATION_SHA256=%s\n' "$configuration_sha256"
  printf 'RELEASE_ID=%s\n' "$release_id"
  printf 'RELEASE_REVISION=%s\n' "$release_revision"
  printf 'CLOUDFRONT_CSP_SHA256=%s\n' "$csp_sha256"
} > "$evidence_dir/aws-web-delivery.env"

trap - EXIT HUP INT TERM
cleanup
printf '%s\n' "AWS Web 静态根已从 $image_digest 提取并逐文件校验；CONFIGURATION_SHA256=$configuration_sha256。"
