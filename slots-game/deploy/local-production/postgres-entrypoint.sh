#!/bin/sh

set -eu

# TLS 运行副本与 PGDATA 共用专属数据卷，根文件系统可保持只读。
tls_dir=/var/lib/postgresql/data/tls
mkdir -p "$tls_dir"
cp /run/postgres-input/postgres-server.pem "$tls_dir/server.crt"
cp /run/postgres-input/postgres-server-key.pem "$tls_dir/server.key"
cp /run/postgres-input/local-production-root-ca.pem "$tls_dir/root-ca.pem"
chown -R postgres:postgres "$tls_dir"
chmod 0700 "$tls_dir"
chmod 0600 "$tls_dir/server.key"
chmod 0644 "$tls_dir/server.crt" "$tls_dir/root-ca.pem"

exec /usr/local/bin/docker-entrypoint.sh "$@"
