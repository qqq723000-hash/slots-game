#!/bin/sh
# shellcheck disable=SC1003,SC2016
# 本契约刻意匹配 Docker/Make 中的字面量 `$` 与行尾反斜杠，不允许 shell 提前展开。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
dockerfile="$script_dir/Dockerfile"
dockerignore="$script_dir/Dockerfile.dockerignore"
nginx_conf="$script_dir/nginx.conf"
policy_verifier="$script_dir/content-security-policy.mjs"
policy_verifier_test="$script_dir/content-security-policy.test.mjs"
release_renderer="$script_dir/render-release-nginx.mjs"
release_renderer_test="$script_dir/render-release-nginx.test.mjs"
release_manifest="$repo_root/web/scripts/release-manifest.mjs"
deterministic_build_verifier="$repo_root/web/scripts/verify-deterministic-release-build.mjs"
third_party_notice_generator="$repo_root/web/scripts/generate-third-party-notices.mjs"
third_party_notice_test="$repo_root/web/scripts/test-third-party-notices.mjs"
third_party_notice="$repo_root/web/public/THIRD_PARTY_NOTICES.txt"
third_party_override_manifest="$repo_root/web/third-party-licenses/overrides.json"
spine_license="$repo_root/web/third-party-licenses/SPINE-LICENSE"
replica_verifier="$script_dir/verify-replica-consistency.mjs"
replica_verifier_test="$script_dir/verify-replica-consistency.test.mjs"
browser_smoke="$repo_root/web/scripts/verify-production-browser-bootstrap.mjs"
browser_smoke_contract_test="$repo_root/web/tests/production-browser-bootstrap-contract.test.ts"
operations_readme="$script_dir/README.md"
frontend_workflow="$repo_root/../.github/workflows/frontend-conformance.yml"

fail() {
  printf '%s\n' "web container contract: $*" >&2
  exit 1
}

require_fixed() {
  needle=$1
  file=$2
  grep -F -- "$needle" "$file" >/dev/null || fail "missing '$needle' in ${file#"$repo_root/"}"
}

require_regex() {
  expression=$1
  file=$2
  grep -E -- "$expression" "$file" >/dev/null || fail "missing /$expression/ in ${file#"$repo_root/"}"
}

require_line() {
  line=$1
  file=$2
  grep -F -x -- "$line" "$file" >/dev/null || fail "missing exact line '$line' in ${file#"$repo_root/"}"
}

for required_file in \
  "$dockerfile" \
  "$dockerignore" \
  "$nginx_conf" \
  "$policy_verifier" \
  "$policy_verifier_test" \
  "$release_renderer" \
  "$release_renderer_test" \
  "$release_manifest" \
  "$deterministic_build_verifier" \
  "$third_party_notice_generator" \
  "$third_party_notice_test" \
  "$third_party_notice" \
  "$third_party_override_manifest" \
  "$spine_license" \
  "$replica_verifier" \
  "$replica_verifier_test" \
  "$browser_smoke" \
  "$browser_smoke_contract_test" \
  "$operations_readme" \
  "$frontend_workflow"
do
  test -f "$required_file" || fail "missing ${required_file#"$repo_root/"}"
done

require_regex '^ARG NODE_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' "$dockerfile"
require_regex '^ARG NGINX_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' "$dockerfile"
require_fixed '"build:determinism-check": "node scripts/verify-deterministic-release-build.mjs"' "$repo_root/web/package.json"
require_fixed '"licenses:generate": "node scripts/generate-third-party-notices.mjs --write"' "$repo_root/web/package.json"
require_fixed '"licenses:check": "node scripts/generate-third-party-notices.mjs --check"' "$repo_root/web/package.json"
require_fixed '"licenses:check-artifacts": "node scripts/generate-third-party-notices.mjs --check-artifacts"' "$repo_root/web/package.json"
require_fixed '"licenses:test": "node scripts/test-third-party-notices.mjs"' "$repo_root/web/package.json"
require_fixed 'vite build && npm run licenses:check-artifacts && node scripts/finalize-production-assets.mjs' "$repo_root/web/package.json"
require_fixed '"prebuild": "npm run licenses:check && npm run assets:provenance-check"' "$repo_root/web/package.json"
require_fixed '"pretest": "npm run licenses:test && npm run licenses:check && npm run assets:provenance-check"' "$repo_root/web/package.json"
require_fixed 'run: npm run build:determinism-check' "$frontend_workflow"
require_fixed 'new Set(["index.html", "favicon.ico", "THIRD_PARTY_NOTICES.txt"])' "$repo_root/web/scripts/finalize-production-assets.mjs"
require_fixed 'npm run licenses:generate' "$operations_readme"
require_fixed '/THIRD_PARTY_NOTICES.txt' "$operations_readme"

# 生产声明必须覆盖新增的 CSP 兼容运行库与 Spine 特殊许可，且不得混入开发工具。
require_fixed '@pixi/unsafe-eval@6.5.2 | 声明：MIT' "$third_party_notice"
require_fixed '@pixi-spine/base@3.1.0 | 声明：SEE SPINE-LICENSE' "$third_party_notice"
require_fixed '@pixi-spine/runtime-4.1@3.1.0 | 声明：SEE SPINE-LICENSE' "$third_party_notice"
require_fixed 'vite@8.1.5 [构建器运行码贡献者：Vite 将 modulepreload 与动态加载辅助代码写入生产浏览器分块。] | 声明：MIT' "$third_party_notice"
require_fixed 'rolldown@1.1.5 [构建器运行码贡献者：Rolldown 将 CommonJS 包装、属性复制和 ESM 互操作辅助代码写入生产浏览器分块。] | 声明：MIT' "$third_party_notice"
require_fixed 'Copyright (c) 2013-2020, Esoteric Software LLC' "$third_party_notice"
require_fixed 'Copyright (c) 2013-2019 Mathew Groves, Chad Engler' "$third_party_notice"
require_fixed 'Copyright (c) 2024-present VoidZero Inc. & Contributors' "$third_party_notice"
require_fixed 'Copyright (c) 2017 [these people](https://github.com/rollup/rollup/graphs/contributors)' "$third_party_notice"
require_fixed 'Copyright (c) 2020 Evan Wallace' "$third_party_notice"
require_fixed 'Vite 将 modulepreload 与动态加载辅助代码写入生产浏览器分块。' "$third_party_override_manifest"
require_fixed 'Rolldown 将 CommonJS 包装、属性复制和 ESM 互操作辅助代码写入生产浏览器分块。' "$third_party_override_manifest"
require_fixed '"integrity": "sha512-t9z29cJjXf/vxQ8dyhCSpt6H6aSwHTk8cT5I3iy6SMXuFpk5mB6PL6XfC8PCwrPTx93udwKUm9HRteAlTGBLiA=="' "$third_party_override_manifest"
require_fixed '"licenseSha256": "23ecfff35a5a2e80d92142f75228912c3b1abc4b5a8337a821ff4397e2f9f734"' "$third_party_override_manifest"
require_fixed '"licenseSha256": "743d64c1f8a673ddcfd1740aa81672eac950ad7e63f6ba2d7c39f91dd57c5b99"' "$third_party_override_manifest"
require_fixed '"sourceRevision": "f09947ab017d6df74299f691853dcfc4f4f0f86e"' "$third_party_override_manifest"
require_fixed '"rolldown-commonjs-interop"' "$third_party_override_manifest"
for development_package in vitest typescript ajv; do
  if grep -E "^- ${development_package}@" "$third_party_notice" >/dev/null; then
    fail "development-only package leaked into THIRD_PARTY_NOTICES.txt: $development_package"
  fi
done
require_fixed '"licenseSha256": "ae6ec834a618890360d86e5f576b0c69eec21309478ddc2dcc2689043d061ee4"' "$third_party_override_manifest"
require_fixed '"sourceRevision": "d625529c0edbbeaec7a9209ce299eff284f015d7"' "$third_party_override_manifest"
test "$(grep -F -c '"licenseSha256": "ae6ec834a618890360d86e5f576b0c69eec21309478ddc2dcc2689043d061ee4"' "$third_party_override_manifest")" -eq 2 \
  || fail 'both pixi-spine packages must bind the reviewed Spine license digest'

# Dockerfile 专用 ignore 优先于仓库 ignore。允许列表刻意收窄，避免 `COPY web/` 把抓包、
# 开发者 node_modules 或旧 dist 发送给 BuildKit。
test "$(sed -n '1p' "$dockerignore")" = "**" || fail "Dockerfile.dockerignore must default-deny with **"
for allow in \
  '!web/' \
  '!web/package.json' \
  '!web/package-lock.json' \
  '!web/index.html' \
  '!web/tsconfig.json' \
  '!web/vite.config.ts' \
  '!web/scripts/' \
  '!web/scripts/finalize-production-assets.mjs' \
  '!web/scripts/generate-third-party-notices.mjs' \
  '!web/scripts/release-manifest.mjs' \
  '!web/scripts/test-third-party-notices.mjs' \
  '!web/scripts/verify-production-javascript-bundles.mjs' \
  '!web/scripts/verify-release-asset-approval.mjs' \
  '!web/src/' \
  '!web/src/**' \
  '!web/public/' \
  '!web/public/**' \
  '!web/third-party-licenses/' \
  '!web/third-party-licenses/SPINE-LICENSE' \
  '!web/third-party-licenses/overrides.json' \
  '!deploy/' \
  '!deploy/web/' \
  '!deploy/web/nginx.conf' \
  '!deploy/web/content-security-policy.mjs' \
  '!deploy/web/render-release-nginx.mjs'
do
  require_line "$allow" "$dockerignore"
done
test "$(grep -c '^!' "$dockerignore")" -eq 25 || fail "Dockerfile.dockerignore has an unreviewed re-include rule"

if grep -E '^!(captures|web/(node_modules|dist)|server|docs)(/|$)' "$dockerignore" >/dev/null; then
  fail "forbidden build-context tree is re-included"
fi
if grep -E '^!web/\*\*([[:space:]]|$)' "$dockerignore" >/dev/null; then
  fail "broad web/** re-include would admit node_modules and dist"
fi
if grep -E '^!web/scripts/\*\*([[:space:]]|$)' "$dockerignore" >/dev/null; then
  fail "broad web/scripts/** re-include would admit unreviewed build scripts"
fi

# Docker ARG 在这里按 Dockerfile 字面量校验，不能让当前 shell 展开。
# shellcheck disable=SC2016
require_line 'FROM ${NODE_IMAGE} AS dependencies' "$dockerfile"
require_line 'FROM dependencies AS static-conformance-build' "$dockerfile"
require_line 'RUN --network=none npm run build' "$dockerfile"
require_fixed 'test -s /src/web/dist/THIRD_PARTY_NOTICES.txt && \' "$dockerfile"
require_fixed 'cmp /src/web/public/THIRD_PARTY_NOTICES.txt /src/web/dist/THIRD_PARTY_NOTICES.txt' "$dockerfile"
require_line 'FROM dependencies AS release-config-build' "$dockerfile"
require_line 'FROM release-config-build AS release-build' "$dockerfile"
for build_arg in \
  VITE_RGS_BASE_URL \
  VITE_RGS_BET_OPTIONS_MINOR \
  VITE_RGS_DEFAULT_BET_MINOR \
  VITE_RGS_HOST_ORIGIN
do
  require_line "ARG $build_arg" "$dockerfile"
  test "$(grep -F -x -c -- "ARG $build_arg" "$dockerfile")" -eq 1 \
    || fail "$build_arg must be declared exactly once"
done
for release_identity_arg in WEB_RELEASE_VERSION WEB_RELEASE_REVISION
do
  test "$(grep -F -x -c -- "ARG $release_identity_arg" "$dockerfile")" -eq 2 \
    || fail "$release_identity_arg must be declared in release-config-build and runtime"
done
release_config_network_none_line=$(printf '%s\134' 'RUN --network=none ')
require_line "$release_config_network_none_line" "$dockerfile"
require_fixed '--mount=type=secret,id=release_asset_approval,required=true,target=/run/secrets/release_asset_approval' "$dockerfile"
require_fixed 'node ./src/validateReleaseRgsBuildConfig.mjs &&' "$dockerfile"
require_line 'COPY deploy/web/nginx.conf deploy/web/content-security-policy.mjs deploy/web/render-release-nginx.mjs /src/release-web/' "$dockerfile"
require_fixed 'node /src/release-web/render-release-nginx.mjs \' "$dockerfile"
require_fixed '--input /src/release-web/nginx.conf \' "$dockerfile"
require_fixed '--output /src/web/release-nginx.conf \' "$dockerfile"
require_fixed '--rgs-base-url "$VITE_RGS_BASE_URL" \' "$dockerfile"
require_fixed '--host-origin "$VITE_RGS_HOST_ORIGIN" && \' "$dockerfile"
require_fixed 'WEB_RELEASE_REQUIRE_IDENTITY=1 \' "$dockerfile"
require_fixed 'WEB_RELEASE_VERSION="$WEB_RELEASE_VERSION" \' "$dockerfile"
require_fixed 'WEB_RELEASE_REVISION="$WEB_RELEASE_REVISION" \' "$dockerfile"
require_fixed 'npm run build' "$dockerfile"
require_fixed 'RELEASE_ASSET_APPROVAL_FILE=/run/secrets/release_asset_approval \' "$dockerfile"
require_fixed 'node ./scripts/verify-release-asset-approval.mjs' "$dockerfile"

static_build_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]static-conformance-build$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "static-conformance-build" { capture = 0 }
  capture { print }
' "$dockerfile")
release_build_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]release-build$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "release-build" { capture = 0 }
  capture { print }
' "$dockerfile")
release_config_build_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]release-config-build$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "release-config-build" { capture = 0 }
  capture { print }
' "$dockerfile")
for build_arg in \
  VITE_RGS_BASE_URL \
  VITE_RGS_BET_OPTIONS_MINOR \
  VITE_RGS_DEFAULT_BET_MINOR \
  VITE_RGS_HOST_ORIGIN
do
  printf '%s\n' "$release_config_build_stage" | grep -F -x "ARG $build_arg" >/dev/null \
    || fail "$build_arg must be scoped to release-config-build"
  if printf '%s\n' "$static_build_stage" | grep -F "$build_arg" >/dev/null; then
    fail "static-conformance-build must not require $build_arg"
  fi
done
for release_identity_arg in WEB_RELEASE_VERSION WEB_RELEASE_REVISION
do
  printf '%s\n' "$release_config_build_stage" | grep -F -x "ARG $release_identity_arg" >/dev/null \
    || fail "$release_identity_arg must be scoped to release-config-build"
  if printf '%s\n' "$static_build_stage" | grep -F "$release_identity_arg" >/dev/null; then
    fail "static-conformance-build must not require $release_identity_arg"
  fi
done
if printf '%s\n' "$release_config_build_stage" | grep -F 'release_asset_approval' >/dev/null; then
  fail 'CI release configuration build must not consume or fabricate an asset approval'
fi
printf '%s\n' "$release_build_stage" | grep -F 'verify-release-asset-approval.mjs' >/dev/null \
  || fail 'release-build must retain the external asset approval gate'

config_nginx_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]config-conformance-nginx$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "config-conformance-nginx" { capture = 0 }
  capture { print }
' "$dockerfile")
config_conformance_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]config-conformance$/ { capture = 1 }
  capture && /^FROM[[:space:]]+/ && $NF != "config-conformance" { capture = 0 }
  capture { print }
' "$dockerfile")
printf '%s\n' "$config_nginx_stage" | grep -F 'COPY --from=release-config-build --chown=101:101 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf' >/dev/null \
  || fail 'config conformance must parse the generated release policy'
printf '%s\n' "$config_nginx_stage" | grep -F 'RUN --network=none nginx -t' >/dev/null \
  || fail 'config conformance must run nginx -t without network access'
printf '%s\n' "$config_nginx_stage" | grep -F '/usr/share/nginx/html/' >/dev/null && \
  fail 'config conformance nginx stage must never copy web release content'
printf '%s\n' "$config_conformance_stage" | grep -F 'FROM scratch AS config-conformance' >/dev/null \
  || fail 'config-conformance output must be a non-runnable scratch artifact'
printf '%s\n' "$config_conformance_stage" | grep -F 'CI_ONLY_NOT_RELEASE_EVIDENCE' >/dev/null \
  || fail 'config-conformance output must carry an explicit non-release marker'
if printf '%s\n' "$config_conformance_stage" | grep -Ei '/usr/share/nginx/html|release_asset_approval|COPY.*dist'; then
  fail 'config-conformance output must contain neither release content nor approval material'
fi

static_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]static-conformance$/ { capture = 1 }
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]runtime$/ { capture = 0 }
  capture { print }
' "$dockerfile")
runtime_stage=$(awk '
  /^FROM[[:space:]].*[[:space:]]AS[[:space:]]runtime$/ { capture = 1 }
  capture { print }
' "$dockerfile")
last_stage=$(awk '/^FROM[[:space:]]+/ { stage = $NF } END { print stage }' "$dockerfile")

# 下方 Docker ARG 刻意按字面量匹配。
# shellcheck disable=SC2016
printf '%s\n' "$static_stage" | grep -F 'FROM ${NGINX_IMAGE} AS static-conformance' >/dev/null || fail "missing isolated nginx static conformance stage"
printf '%s\n' "$static_stage" | grep -F 'org.opencontainers.image.title="CI_ONLY_STATIC_CONFORMANCE"' >/dev/null || fail "static conformance stage must carry a non-release label"
# shellcheck disable=SC2016
printf '%s\n' "$runtime_stage" | grep -F 'FROM ${NGINX_IMAGE} AS runtime' >/dev/null || fail "missing isolated nginx runtime stage"
test "$last_stage" = runtime || fail "runtime must remain the default final Docker target"
printf '%s\n' "$static_stage" | grep -F 'COPY --from=static-conformance-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/' >/dev/null || fail "static conformance must copy only its own root-owned dist into the web root"
printf '%s\n' "$static_stage" | grep -F 'COPY --chown=0:0 deploy/web/nginx.conf /etc/nginx/conf.d/default.conf' >/dev/null || fail "static conformance must retain the root-owned fail-closed nginx policy"
printf '%s\n' "$runtime_stage" | grep -F 'COPY --from=release-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/' >/dev/null || fail "runtime must copy only approval-gated root-owned dist into the web root"
printf '%s\n' "$runtime_stage" | grep -F 'COPY --from=release-build --chown=0:0 /src/web/dist/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt' >/dev/null || fail "runtime must expose the approved third-party notice at the image root"
printf '%s\n' "$runtime_stage" | grep -F 'cmp /THIRD_PARTY_NOTICES.txt /usr/share/nginx/html/THIRD_PARTY_NOTICES.txt' >/dev/null || fail "runtime must prove the image-root and served third-party notices are identical"
printf '%s\n' "$runtime_stage" | grep -F 'COPY --from=release-build --chown=0:0 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf' >/dev/null || fail "runtime must copy only the root-owned release-generated nginx policy"
printf '%s\n' "$runtime_stage" | grep -F 'RUN --network=none nginx -t' >/dev/null || fail "runtime must parse-check the generated nginx policy without network access"
printf '%s\n' "$runtime_stage" | grep -F 'org.opencontainers.image.version="${WEB_RELEASE_VERSION}"' >/dev/null || fail "runtime must expose the validated public release version label"
printf '%s\n' "$runtime_stage" | grep -F 'org.opencontainers.image.revision="${WEB_RELEASE_REVISION}"' >/dev/null || fail "runtime must expose the validated full revision label"
if printf '%s\n' "$runtime_stage" | grep -F 'COPY --chown=0:0 deploy/web/nginx.conf /etc/nginx/conf.d/default.conf' >/dev/null; then
  fail "runtime must not reuse the CI-only SAMEORIGIN policy"
fi

for final_stage in "$static_stage" "$runtime_stage"; do
  printf '%s\n' "$final_stage" | grep -F 'USER 101:101' >/dev/null || fail "final stage must declare non-root 101:101"
  test "$(printf '%s\n' "$final_stage" | awk '/^USER[[:space:]]+/ { user = $2 } END { print user }')" = '101:101' \
    || fail "final stage must leave 101:101 as the effective image user"
  printf '%s\n' "$final_stage" | grep -F 'chown 0:0 /etc/nginx/conf.d /usr/share/nginx/html && \' >/dev/null || fail "final stage must root-own configuration and release roots"
  printf '%s\n' "$final_stage" | grep -F 'chmod -R a-w /etc/nginx/conf.d /usr/share/nginx/html' >/dev/null || fail "final stage must remove runtime write access from configuration and release bytes"
  printf '%s\n' "$final_stage" | grep -F 'CMD ["wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/readyz"]' >/dev/null || fail "healthcheck must use the Alpine BusyBox wget client and /readyz"
  if printf '%s\n' "$final_stage" | grep -Ei 'COPY[[:space:]].*(server|captures|node_modules|\.env|secret|credential|private)' >/dev/null; then
    fail "final stage copies server, capture or credential material"
  fi
  if printf '%s\n' "$final_stage" | grep -Ei 'release_asset_approval|RELEASE_ASSET_APPROVAL_FILE|/run/secrets/' >/dev/null; then
    fail "final stage references the release approval secret"
  fi
  if printf '%s\n' "$final_stage" | grep -Ei '^(ARG|ENV)[[:space:]].*(dsn|password|secret|token|private|credential|wallet|hmac)' >/dev/null; then
    fail "final stage declares a credential-like ARG or ENV"
  fi
done

# CI 必须正向构建只含配置的 conformance 目标；固定测试 origin 不得成为 runtime 默认值或
# 被上传为素材/发布证据。
require_fixed '--target config-conformance' "$frontend_workflow"
require_fixed 'slots-web-config-conformance:ci-only-not-release-evidence' "$frontend_workflow"
require_fixed '--build-arg VITE_RGS_BASE_URL=https://rgs.ci.invalid' "$frontend_workflow"
require_fixed '--build-arg VITE_RGS_BET_OPTIONS_MINOR=100,200,500' "$frontend_workflow"
require_fixed '--build-arg VITE_RGS_DEFAULT_BET_MINOR=200' "$frontend_workflow"
require_fixed '--build-arg VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid' "$frontend_workflow"
require_fixed '--build-arg WEB_RELEASE_VERSION=0.0.0-ci' "$frontend_workflow"
require_fixed '--build-arg WEB_RELEASE_REVISION=0000000000000000000000000000000000000001' "$frontend_workflow"
require_fixed 'ci-only-not-release-evidence/release-nginx.conf' "$frontend_workflow"
require_fixed "connect-src 'self' https://rgs.ci.invalid" "$frontend_workflow"
require_fixed 'frame-ancestors https://operator.ci.invalid' "$frontend_workflow"
require_fixed 'config-conformance output unexpectedly contains web content' "$frontend_workflow"
require_fixed 'config-conformance output unexpectedly contains source, assets or build output' "$frontend_workflow"
require_fixed 'web-runtime-missing-approval.log' "$frontend_workflow"
require_fixed "grep -F 'release_asset_approval' web-runtime-missing-approval.log" "$frontend_workflow"
require_fixed 'stat -c %u:%g:%a /etc/nginx/conf.d/default.conf' "$frontend_workflow"
require_fixed 'stat -c %u:%g:%a /usr/share/nginx/html/index.html' "$frontend_workflow"
require_fixed 'docker run --detach --read-only \' "$frontend_workflow"
require_fixed '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m' "$frontend_workflow"
require_fixed '--tmpfs /var/cache/nginx:rw,noexec,nosuid,nodev,size=16m' "$frontend_workflow"
for fixed_argument in \
  '--build-arg VITE_RGS_BASE_URL=https://rgs.ci.invalid' \
  '--build-arg VITE_RGS_BET_OPTIONS_MINOR=100,200,500' \
  '--build-arg VITE_RGS_DEFAULT_BET_MINOR=200' \
  '--build-arg VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid'
do
  test "$(grep -F -c -- "$fixed_argument" "$frontend_workflow")" -eq 2 ||
    fail "both positive config and missing-approval gates must use $fixed_argument"
done
for fixed_identity_argument in \
  '--build-arg WEB_RELEASE_VERSION=0.0.0-ci' \
  '--build-arg WEB_RELEASE_REVISION=0000000000000000000000000000000000000001'
do
  test "$(grep -F -c -- "$fixed_identity_argument" "$frontend_workflow")" -eq 2 ||
    fail "both positive config and missing-approval gates must use $fixed_identity_argument"
done

# 下方 Nginx 变量刻意按字面量匹配。
# shellcheck disable=SC2016
require_fixed 'map "$status:$uri" $web_cache_control {' "$nginx_conf"
require_fixed 'default "no-store, max-age=0";' "$nginx_conf"
require_fixed '~^(?:200|206|304):/assets/[^/]+-[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]*\.(?:css|js)$' "$nginx_conf"
require_fixed '"public, max-age=31536000, immutable";' "$nginx_conf"
require_fixed '~^(?:200|304):/assets/(?:.+/)?(?:runtime-manifest|streaming-packages)\.json$ "no-store, max-age=0";' "$nginx_conf"
require_fixed '~^(?:200|206|304):/assets/ "no-cache";' "$nginx_conf"
# shellcheck disable=SC2016
require_fixed 'add_header Cache-Control $web_cache_control always;' "$nginx_conf"
require_fixed 'location = /index.html {' "$nginx_conf"
require_fixed 'location = /release-manifest.json {' "$nginx_conf"
require_fixed 'location ~* ^/assets/(.+/)?(runtime-manifest|streaming-packages)\.json$ {' "$nginx_conf"
require_fixed 'max_ranges 1;' "$nginx_conf"
# 下方 Nginx document-root 变量属于字面量契约。
# shellcheck disable=SC2016
require_fixed 'disable_symlinks if_not_owner from=$document_root;' "$nginx_conf"
require_fixed 'location = /healthz {' "$nginx_conf"
require_fixed 'return 200 "ok\n";' "$nginx_conf"
require_fixed 'location = /livez {' "$nginx_conf"
require_fixed 'return 200 "live\n";' "$nginx_conf"
require_fixed 'location = /readyz {' "$nginx_conf"
require_fixed 'if (!-f $document_root/index.html) { return 503 "not ready\n"; }' "$nginx_conf"
require_fixed 'if (!-f $document_root/release-manifest.json) { return 503 "not ready\n"; }' "$nginx_conf"
require_fixed 'return 200 "ready\n";' "$nginx_conf"
require_fixed 'add_header X-Content-Type-Options "nosniff" always;' "$nginx_conf"
require_fixed 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;' "$nginx_conf"
require_fixed 'add_header X-Frame-Options "SAMEORIGIN" always;' "$nginx_conf"
require_fixed 'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;' "$nginx_conf"
require_fixed 'add_header Content-Security-Policy ' "$nginx_conf"
require_fixed "script-src 'self';" "$nginx_conf"
require_fixed "connect-src 'self';" "$nginx_conf"
require_fixed "form-action 'none';" "$nginx_conf"
require_fixed 'trusted-types slots-game-static-html;' "$nginx_conf"
require_fixed "require-trusted-types-for 'script';" "$nginx_conf"
require_fixed 'result.trustedTypesEvidence?.enforcementSupported !== true' "$browser_smoke"
require_fixed 'source: TRUSTED_TYPES_POLICY_OBSERVATION_PROBE_SOURCE' "$browser_smoke"
require_fixed 'result.trustedTypesEvidence?.observerInstalled !== true' "$browser_smoke"
require_fixed 'result.trustedTypesEvidence?.staticHtmlPolicyNameObserved !== true' "$browser_smoke"
require_fixed 'result.trustedTypesEvidence?.staticHtmlPolicyCreateCount !== 1' "$browser_smoke"
require_fixed 'result.trustedTypesEvidence?.unexpectedPolicyCreateCount !== 0' "$browser_smoke"
require_fixed 'result.trustedTypesEvidence?.policyObservationCapabilityFree !== true' "$browser_smoke"
require_fixed 'result.trustedTypesEvidence?.policyObservationGlobalLocked !== true' "$browser_smoke"
require_fixed "!Reflect.has(policyObservation, 'policy')" "$browser_smoke"
require_fixed "!Reflect.has(policyObservation, 'factory')" "$browser_smoke"
require_fixed "!Reflect.has(policyObservation, 'createPolicy')" "$browser_smoke"
require_fixed "!Reflect.has(policyObservation, 'createHTML')" "$browser_smoke"
if grep -F 'slots-game.static-html-policy.v1' "$browser_smoke" >/dev/null \
    || grep -F 'staticHtmlMarker' "$browser_smoke" >/dev/null; then
  fail 'browser smoke must not depend on the removed global Trusted Types marker'
fi
if grep -F '?.policy?.createHTML' "$browser_smoke" >/dev/null; then
  fail 'browser smoke must not require or expose the Trusted Types policy capability'
fi
trusted_types_probe_line=$(grep -n -F 'source: TRUSTED_TYPES_POLICY_OBSERVATION_PROBE_SOURCE' "$browser_smoke" | head -n 1 | cut -d: -f1)
csp_probe_line=$(grep -n -F 'source: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE' "$browser_smoke" | head -n 1 | cut -d: -f1)
test "$trusted_types_probe_line" -lt "$csp_probe_line" ||
  fail 'Trusted Types policy observation must be installed before the document CSP probe'
require_fixed 'cspViolationCount: result.cspViolations.length' "$browser_smoke"
require_fixed 'policyCreateCount: result.trustedTypesEvidence.staticHtmlPolicyCreateCount' "$browser_smoke"
require_fixed 'acknowledgementCount: transactionEvidence.acknowledgementCount' "$browser_smoke"
require_fixed 'result.cspViolations.length > 0' "$browser_smoke"
require_fixed 'trustedTypesSink' "$browser_smoke"
require_fixed 'safeTrustedTypesSink' "$policy_verifier"
require_fixed 'safeSourceFile' "$policy_verifier"
require_fixed 'server_tokens off;' "$nginx_conf"

if grep -F 'location ^~ /assets/' "$nginx_conf" >/dev/null; then
  fail "^~ /assets/ would bypass manifest-specific locations"
fi
if grep -E "connect-src[^;]*(ws:|wss:|\*)" "$nginx_conf" >/dev/null; then
  fail "CSP connect-src must not permit wildcard WebSocket origins"
fi
if grep -E "script-src[^;]*('unsafe-eval'|'unsafe-inline'|\*|data:|blob:)" "$nginx_conf" >/dev/null; then
  fail "CSP script-src must allow only self"
fi
if grep -E "trusted-types[^;]*(\*|'allow-duplicates')" "$nginx_conf" >/dev/null; then
  fail "CSP trusted-types must allow only the reviewed static HTML policy"
fi

# Nginx 的 location 级 add_header 会取消继承的 server header，因此 Cache-Control
# 只能通过 URI map 在 server 级统一设置。
location_headers=$(awk '
  /^[[:space:]]*location[[:space:]]/ { in_location = 1 }
  in_location && /^[[:space:]]*add_header[[:space:]]/ { print }
  in_location && /^[[:space:]]*}/ { in_location = 0 }
' "$nginx_conf")
test -z "$location_headers" || fail "location-level add_header would hide inherited security headers"

if grep -E 'max_ranges[[:space:]]+0|disable_symlinks[[:space:]]+off' "$nginx_conf" >/dev/null; then
  fail "range requests or symlink protection are explicitly weakened"
fi

# 只有允许列表中的 public、源码和构建脚本输入可以进入 dist。Docker 介入前即拒绝高置信度
# 私钥/凭据文件；变量名和 API 协议字段本身不等同于秘密。
set -- \
  "$repo_root/web/public" \
  "$repo_root/web/src" \
  "$repo_root/web/index.html" \
  "$repo_root/web/package.json" \
  "$repo_root/web/package-lock.json" \
  "$repo_root/web/tsconfig.json" \
  "$repo_root/web/vite.config.ts" \
  "$repo_root/web/scripts/finalize-production-assets.mjs" \
  "$release_manifest" \
  "$repo_root/web/scripts/verify-production-javascript-bundles.mjs" \
  "$repo_root/web/scripts/verify-release-asset-approval.mjs" \
  "$policy_verifier" \
  "$release_renderer" \
  "$replica_verifier"
find "$@" -type l -print | grep . >/dev/null && fail "web build input contains a symbolic link"
find "$@" -type f \( \
  -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o \
  -name '*.p12' -o -name '*.pfx' -o -iname '*credential*' -o -iname '*secret*' \
\) -print | grep . >/dev/null && fail "web build input contains a credential-like file"
if grep -R -E -- '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' "$@" >/dev/null; then
  fail "web build input contains private key material"
fi
if grep -R -E -- 'AKIA[0-9A-Z]{16}|postgres(ql)?://[^[:space:]]+:[^[:space:]]+@' "$@" >/dev/null; then
  fail "web build input contains high-confidence credential material"
fi

# renderer 单测覆盖 CSP/XFO 语义重复、注释诱饵、URL 注入和 CLI 原子输出；这些检查
# 在 Docker daemon 不可用时仍必须执行，镜像内 nginx -t 则负责最终语法解析。
command -v node >/dev/null 2>&1 || fail "node is required to verify the release nginx renderer"
node --test "$policy_verifier_test" >/dev/null || fail "Content-Security-Policy semantic tests failed"
node --test "$release_renderer_test" >/dev/null || fail "release nginx renderer tests failed"
node --test "$replica_verifier_test" >/dev/null || fail "web replica consistency tests failed"

printf '%s\n' 'web container static contract: ok'
