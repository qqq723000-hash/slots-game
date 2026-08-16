#!/bin/sh

set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${RGS_MIGRATOR_PASSWORD:?RGS_MIGRATOR_PASSWORD is required}"
: "${RGS_RUNTIME_PASSWORD:?RGS_RUNTIME_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=migrator_password="$RGS_MIGRATOR_PASSWORD" \
  --set=runtime_password="$RGS_RUNTIME_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE rgs_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgs_migrator') \gexec
SELECT 'CREATE ROLE rgs_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgs_runtime') \gexec

ALTER ROLE rgs_migrator WITH LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE rgs_runtime WITH LOGIN PASSWORD :'runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE rgs_migrator SET search_path = public;
ALTER ROLE rgs_runtime SET search_path = public;

REVOKE rgs_migrator FROM rgs_runtime;
REVOKE rgs_runtime FROM rgs_migrator;
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM PUBLIC, rgs_migrator, rgs_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO rgs_migrator, rgs_runtime;
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name" FROM PUBLIC, rgs_migrator, rgs_runtime;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, rgs_migrator, rgs_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO rgs_migrator;
GRANT USAGE ON SCHEMA public TO rgs_runtime;
SQL
