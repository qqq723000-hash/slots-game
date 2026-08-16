#!/bin/sh

set -eu

migrator_password="$(sed -n '1p' /run/postgres-input/rgs-migrator.password)"
runtime_password="$(sed -n '1p' /run/postgres-input/rgs-runtime.password)"
backup_password="$(sed -n '1p' /run/postgres-input/postgres-backup.password)"
test -n "$migrator_password"
test -n "$runtime_password"
test -n "$backup_password"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=migrator_password="$migrator_password" \
  --set=runtime_password="$runtime_password" \
  --set=backup_password="$backup_password" <<'SQL'
SELECT 'CREATE ROLE rgs_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgs_migrator') \gexec
SELECT 'CREATE ROLE rgs_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgs_runtime') \gexec
SELECT 'CREATE ROLE rgs_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgs_backup') \gexec

ALTER ROLE rgs_migrator WITH LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE rgs_runtime WITH LOGIN PASSWORD :'runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE rgs_backup WITH LOGIN PASSWORD :'backup_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE rgs_migrator SET search_path = public;
ALTER ROLE rgs_runtime SET search_path = public;

REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM PUBLIC, rgs_migrator, rgs_runtime, rgs_backup;
GRANT CONNECT ON DATABASE :"database_name" TO rgs_migrator, rgs_runtime, rgs_backup;
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name" FROM PUBLIC, rgs_migrator, rgs_runtime, rgs_backup;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, rgs_migrator, rgs_runtime, rgs_backup;
GRANT USAGE, CREATE ON SCHEMA public TO rgs_migrator;
GRANT USAGE ON SCHEMA public TO rgs_runtime;

SELECT format('CREATE DATABASE local_operator OWNER postgres')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'local_operator') \gexec
REVOKE ALL PRIVILEGES ON DATABASE local_operator FROM PUBLIC;
SQL

unset migrator_password runtime_password backup_password
