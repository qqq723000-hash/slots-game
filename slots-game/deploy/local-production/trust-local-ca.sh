#!/bin/sh
# 把本部署的专用 CA 设为 macOS 登录钥匙串中的 SSL 信任根。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_state

test "${1:-}" = --confirm && test "${2:-}" = slots-local-production-ca || {
  printf '%s\n' '用法: trust-local-ca.sh --confirm slots-local-production-ca' >&2
  exit 2
}
command -v security >/dev/null 2>&1
command -v openssl >/dev/null 2>&1

ca_file="$secrets_root/local-production-root-ca.pem"
server_certificate="$secrets_root/ingress-server.pem"
keychain="$HOME/Library/Keychains/login.keychain-db"
test -s "$ca_file" && test -s "$server_certificate" && test -f "$keychain"
openssl verify -CAfile "$ca_file" "$ca_file" >/dev/null

security add-trusted-cert -r trustRoot -p ssl -k "$keychain" "$ca_file"
security verify-cert -c "$server_certificate" -p ssl -s slots.localhost -k "$keychain" >/dev/null
printf '%s\n' '本地生产 CA 已加入 macOS 登录钥匙串，slots.localhost TLS 验证通过。'
