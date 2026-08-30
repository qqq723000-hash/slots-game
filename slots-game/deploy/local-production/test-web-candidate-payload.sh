#!/bin/sh
# 使用固定 Nginx 基础镜像真实构建最小 Web 候选，证明上游默认页面不会混入发布清单。
# English: Really build a minimal web candidate using a fixed Nginx base image, proving that upstream default
# pages don't get mixed into the release manifest.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
dockerfile="$script_dir/Dockerfile.web"
static_verifier="$repository_root/deploy/supply-chain/verify-web-static-root.mjs"
base_image='nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979'

command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker CLI is required.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js is required.' >&2; exit 1; }
docker image inspect "$base_image" >/dev/null 2>&1 || {
  printf '%s\n' 'The fixed Nginx base image must be preloaded; this test does not pull mutable state.' >&2
  exit 1
}

test_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-local-web-payload.XXXXXX")
context_root="$test_root/context"
candidate_static_root="$test_root/candidate-static"
candidate_image="slots-local-web-payload-contract:test-${test_root##*.}-$$"
candidate_image_iidfile="$test_root/candidate-image.id"
candidate_image_id=''
candidate_image_tag_owned=false
base_container_id=''
candidate_container_id=''

cleanup() {
  trap - HUP INT TERM
  if [ -n "$base_container_id" ]; then
    docker rm --force "$base_container_id" >/dev/null 2>&1 || true
    base_container_id=''
  fi
  if [ -n "$candidate_container_id" ]; then
    docker rm --force "$candidate_container_id" >/dev/null 2>&1 || true
    candidate_container_id=''
  fi
  if [ "$candidate_image_tag_owned" = true ]; then
    current_tag_id=$(docker image inspect --format '{{.Id}}' "$candidate_image" 2>/dev/null || true)
    if [ "$current_tag_id" = "$candidate_image_id" ]; then
      docker image rm "$candidate_image" >/dev/null 2>&1 || true
    fi
  fi
  case "$test_root" in
    */slots-local-web-payload.*) rm -rf -- "$test_root" ;;
    *) printf '%s\n' 'Refusing to remove an unexpected Web payload test directory.' >&2; return 1 ;;
  esac
}
handle_signal() {
  signal_status=$1
  trap - EXIT HUP INT TERM
  cleanup
  exit "$signal_status"
}
trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

mkdir -p "$context_root/web/dist" "$candidate_static_root"
TEST_WEB_ROOT="$context_root/web" \
RELEASE_MANIFEST_MODULE="$repository_root/web/scripts/release-manifest.mjs" \
node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const webRoot = process.env.TEST_WEB_ROOT;
const manifestModule = process.env.RELEASE_MANIFEST_MODULE;
if (!webRoot || !manifestModule) throw new Error("test fixture paths are required");
const { createReleaseManifest } = await import(pathToFileURL(manifestModule).href);
const distRoot = join(webRoot, "dist");
mkdirSync(distRoot, { recursive: true });
const payload = new Map([
  ["THIRD_PARTY_NOTICES.txt", "Fixture dependency notices.\n"],
  ["index.html", "<!doctype html><meta charset=\"utf-8\"><title>Payload contract</title>\n"],
]);
for (const [path, content] of payload) writeFileSync(join(distRoot, path), content, "utf8");
const files = [...payload].map(([path, content]) => ({
  path,
  bytes: Buffer.byteLength(content),
  sha256: createHash("sha256").update(content, "utf8").digest("hex"),
}));
const manifest = createReleaseManifest({
  version: "1.3.0",
  revision: "a".repeat(40),
  files,
  requireRevision: true,
});
writeFileSync(join(distRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(join(webRoot, "release-nginx.conf"), `server {
  listen 8080;
  server_name _;
  root /usr/share/nginx/html;
  location = /healthz { access_log off; return 200 "ok\\n"; }
  location / { try_files $uri /index.html; }
}
`, "utf8");
NODE

node "$static_verifier" "$context_root/web/dist" >/dev/null

# 该固定上游摘要确实包含默认 50x.html；若前提变化，测试必须显式复审而不是静默变绿。
# English: The fixed upstream digest does include the default 50x.html; if the prerequisite changes, the test
# must be explicitly reviewed instead of silently turning green.
base_container_id=$(docker create "$base_image")
docker cp "$base_container_id:/usr/share/nginx/html/50x.html" "$test_root/base-50x.html" >/dev/null
test -s "$test_root/base-50x.html"
docker rm "$base_container_id" >/dev/null
base_container_id=''

docker image inspect "$candidate_image" >/dev/null 2>&1 && {
  printf '%s\n' 'Refusing to overwrite an existing Web payload contract tag.' >&2
  exit 1
}
DOCKER_BUILDKIT=1 docker build --pull=false \
  --file "$dockerfile" \
  --build-arg OCI_IMAGE_CREATED=2026-01-01T00:00:00Z \
  --build-arg OCI_IMAGE_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --build-arg OCI_IMAGE_SOURCE=https://example.invalid/independent/slots-game \
  --build-arg OCI_IMAGE_VERSION=1.3.0 \
  --build-arg VITE_OPERATOR_RETURN_URL=/operator/ \
  --iidfile "$candidate_image_iidfile" \
  --tag "$candidate_image" \
  "$context_root" >/dev/null

candidate_image_id=$(node -e '
const { readFileSync } = require("node:fs");
const value = readFileSync(process.argv[1], "utf8");
if (!/^sha256:[0-9a-f]{64}\n?$/u.test(value)) process.exit(1);
process.stdout.write(value.endsWith("\n") ? value.slice(0, -1) : value);
' "$candidate_image_iidfile") || {
  printf '%s\n' 'The Web payload build did not return one canonical image ID.' >&2
  exit 1
}
tag_image_id=$(docker image inspect --format '{{.Id}}' "$candidate_image")
test "$tag_image_id" = "$candidate_image_id" || {
  printf '%s\n' 'The temporary Web payload tag does not select the image ID returned by BuildKit.' >&2
  exit 1
}
candidate_image_tag_owned=true
candidate_container_id=$(docker create "$candidate_image_id")
docker cp "$candidate_container_id:/usr/share/nginx/html/." "$candidate_static_root" >/dev/null
test ! -e "$candidate_static_root/50x.html" || {
  printf '%s\n' 'The Web candidate retained the inherited Nginx 50x.html.' >&2
  exit 1
}
node "$static_verifier" "$candidate_static_root" >/dev/null

printf '%s\n' 'Local Web candidate payload contract passed: inherited defaults removed and every served file is manifest-bound.'
