#!/bin/sh
# RGS 迁移完成后再授予只读备份角色，避免备份进程持有 owner/superuser。
# English: Grant the read-only backup role after the RGS migration is completed to prevent the backup process
# from holding owner/superuser.
set -eu

admin_password="$(sed -n '1p' /run/postgres-input/postgres-admin.password)"
test -n "$admin_password"
export PGPASSWORD="$admin_password"
psql "host=postgres port=5432 dbname=rgs user=postgres sslmode=verify-full sslrootcert=/run/postgres-input/local-production-root-ca.pem" \
  --set=ON_ERROR_STOP=1 <<'SQL'
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM rgs_backup;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM rgs_backup;
GRANT USAGE ON SCHEMA public TO rgs_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rgs_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rgs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE rgs_migrator IN SCHEMA public GRANT SELECT ON TABLES TO rgs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE rgs_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO rgs_backup;
SQL

psql "host=postgres port=5432 dbname=local_operator user=postgres sslmode=verify-full sslrootcert=/run/postgres-input/local-production-root-ca.pem" \
  --set=ON_ERROR_STOP=1 <<'SQL'
REVOKE ALL PRIVILEGES ON DATABASE local_operator FROM rgs_backup;
GRANT CONNECT ON DATABASE local_operator TO rgs_backup;
REVOKE TEMPORARY ON DATABASE local_operator FROM rgs_backup;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM rgs_backup;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM rgs_backup;
GRANT USAGE ON SCHEMA public TO rgs_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rgs_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rgs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE local_operator_owner IN SCHEMA public GRANT SELECT ON TABLES TO rgs_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE local_operator_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO rgs_backup;
SQL
unset PGPASSWORD admin_password
