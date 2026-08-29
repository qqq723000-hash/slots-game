package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var rolePasswordPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)

type databaseBootstrapConfig struct {
	AdminDatabaseURLFile   string
	OwnerRole              string
	OwnerPasswordFile      string
	OwnerDatabaseURLFile   string
	RuntimeRole            string
	RuntimePasswordFile    string
	RuntimeDatabaseURLFile string
}

func loadDatabaseBootstrapConfig(getenv func(string) string) (databaseBootstrapConfig, error) {
	config := databaseBootstrapConfig{
		AdminDatabaseURLFile:   getenv("LOCAL_OPERATOR_BOOTSTRAP_DATABASE_URL_FILE"),
		OwnerRole:              valueOrDefault(getenv("LOCAL_OPERATOR_OWNER_DATABASE_ROLE"), "local_operator_owner"),
		OwnerPasswordFile:      getenv("LOCAL_OPERATOR_OWNER_PASSWORD_FILE"),
		OwnerDatabaseURLFile:   getenv("LOCAL_OPERATOR_OWNER_DATABASE_URL_FILE"),
		RuntimeRole:            valueOrDefault(getenv("LOCAL_OPERATOR_RUNTIME_DATABASE_ROLE"), "local_operator_runtime"),
		RuntimePasswordFile:    getenv("LOCAL_OPERATOR_RUNTIME_PASSWORD_FILE"),
		RuntimeDatabaseURLFile: getenv("LOCAL_OPERATOR_RUNTIME_DATABASE_URL_FILE"),
	}
	for _, path := range []string{
		config.AdminDatabaseURLFile, config.OwnerPasswordFile, config.OwnerDatabaseURLFile,
		config.RuntimePasswordFile, config.RuntimeDatabaseURLFile,
	} {
		if path == "" || !filepath.IsAbs(path) {
			return databaseBootstrapConfig{}, errors.New("database bootstrap requires absolute input and output paths")
		}
	}
	if !databaseRolePattern.MatchString(config.OwnerRole) ||
		!databaseRolePattern.MatchString(config.RuntimeRole) || config.OwnerRole == config.RuntimeRole {
		return databaseBootstrapConfig{}, errors.New("database bootstrap roles are invalid or not distinct")
	}
	if config.OwnerDatabaseURLFile == config.RuntimeDatabaseURLFile ||
		config.OwnerDatabaseURLFile == config.AdminDatabaseURLFile ||
		config.RuntimeDatabaseURLFile == config.AdminDatabaseURLFile {
		return databaseBootstrapConfig{}, errors.New("database bootstrap DSN paths must be distinct")
	}
	return config, nil
}

func bootstrapDatabase(ctx context.Context, config databaseBootstrapConfig) error {
	adminURL, err := loadDatabaseURL(config.AdminDatabaseURLFile)
	if err != nil {
		return fmt.Errorf("load bootstrap database URL: %w", err)
	}
	if err := validateProductionDatabaseURL(adminURL); err != nil {
		return err
	}
	ownerPassword, err := readDatabaseRolePassword(config.OwnerPasswordFile)
	if err != nil {
		return fmt.Errorf("load owner database password: %w", err)
	}
	defer clear(ownerPassword)
	runtimePassword, err := readDatabaseRolePassword(config.RuntimePasswordFile)
	if err != nil {
		return fmt.Errorf("load runtime database password: %w", err)
	}
	defer clear(runtimePassword)
	if string(ownerPassword) == string(runtimePassword) {
		return errors.New("owner and runtime database passwords must be distinct")
	}
	database, err := openDatabase(adminURL)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := reconcileDatabaseRoles(
		ctx, database, config.OwnerRole, string(ownerPassword), config.RuntimeRole, string(runtimePassword),
	); err != nil {
		return err
	}
	ownerURL, err := databaseURLForRole(adminURL, config.OwnerRole, string(ownerPassword))
	if err != nil {
		return err
	}
	runtimeURL, err := databaseURLForRole(adminURL, config.RuntimeRole, string(runtimePassword))
	if err != nil {
		return err
	}
	if err := writeSecretAtomically(config.OwnerDatabaseURLFile, []byte(ownerURL+"\n")); err != nil {
		return fmt.Errorf("write owner database URL: %w", err)
	}
	if err := writeSecretAtomically(config.RuntimeDatabaseURLFile, []byte(runtimeURL+"\n")); err != nil {
		return fmt.Errorf("write runtime database URL: %w", err)
	}
	return nil
}

func reconcileDatabaseRoles(
	ctx context.Context,
	database *sql.DB,
	ownerRole, ownerPassword, runtimeRole, runtimePassword string,
) error {
	if database == nil || !databaseRolePattern.MatchString(ownerRole) ||
		!databaseRolePattern.MatchString(runtimeRole) || ownerRole == runtimeRole ||
		!rolePasswordPattern.MatchString(ownerPassword) || !rolePasswordPattern.MatchString(runtimePassword) {
		return errors.New("invalid database role bootstrap input")
	}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin database role bootstrap: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, localOperatorMigrationLock-1); err != nil {
		return fmt.Errorf("lock database role bootstrap: %w", err)
	}
	var administrator bool
	var databaseName string
	if err := tx.QueryRowContext(ctx, `
		SELECT rolsuper, current_database() FROM pg_roles WHERE rolname=current_user`,
	).Scan(&administrator, &databaseName); err != nil || !administrator {
		return errors.New("database bootstrap requires the target database superuser")
	}
	quotedOwner := quoteSQLIdentifier(ownerRole)
	quotedRuntime := quoteSQLIdentifier(runtimeRole)
	quotedDatabase := quoteSQLIdentifier(databaseName)
	for _, statement := range []string{
		`DO $bootstrap$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=` + quoteSQLLiteral(ownerRole) + `) THEN CREATE ROLE ` + quotedOwner + `; END IF; END $bootstrap$`,
		`DO $bootstrap$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=` + quoteSQLLiteral(runtimeRole) + `) THEN CREATE ROLE ` + quotedRuntime + `; END IF; END $bootstrap$`,
		`ALTER ROLE ` + quotedOwner + ` LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ` + quoteSQLLiteral(ownerPassword),
		`ALTER ROLE ` + quotedRuntime + ` LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ` + quoteSQLLiteral(runtimePassword),
		// 迁移 SQL 创建未限定 schema 的业务表，因此 owner 只在受控迁移连接中把 public 放首位；
		// runtime 无 DDL 权限并保持 pg_catalog 优先，避免业务 schema 遮蔽内置函数。
		// English: Migration SQL creates business tables with undefined schema, so owner only puts public first in
		// controlled migration connections; runtime does not have DDL permissions and keeps pg_catalog priority to avoid
		// business schema from covering built-in functions.
		`ALTER ROLE ` + quotedOwner + ` SET search_path TO public, pg_catalog`,
		`ALTER ROLE ` + quotedRuntime + ` SET search_path TO pg_catalog, public`,
		`REVOKE TEMPORARY ON DATABASE ` + quotedDatabase + ` FROM PUBLIC`,
		`REVOKE ALL PRIVILEGES ON DATABASE ` + quotedDatabase + ` FROM ` + quotedOwner + `, ` + quotedRuntime,
		`GRANT CONNECT ON DATABASE ` + quotedDatabase + ` TO ` + quotedOwner + `, ` + quotedRuntime,
		`REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
		`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ` + quotedOwner + `, ` + quotedRuntime,
		`GRANT USAGE, CREATE ON SCHEMA public TO ` + quotedOwner,
		`GRANT USAGE ON SCHEMA public TO ` + quotedRuntime,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("apply database role policy: %w", err)
		}
	}
	var unsafeMemberships int
	if err := tx.QueryRowContext(ctx, `
		SELECT count(*) FROM pg_auth_members m
		JOIN pg_roles member_role ON member_role.oid=m.member
		JOIN pg_roles granted_role ON granted_role.oid=m.roleid
		WHERE member_role.rolname IN ($1,$2) OR granted_role.rolname IN ($1,$2)`,
		ownerRole, runtimeRole,
	).Scan(&unsafeMemberships); err != nil {
		return fmt.Errorf("verify database role memberships: %w", err)
	}
	if unsafeMemberships != 0 {
		return errors.New("database bootstrap roles must not participate in role memberships")
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit database role bootstrap: %w", err)
	}
	return nil
}

func readDatabaseRolePassword(path string) ([]byte, error) {
	password, err := readSecretFile(path, 256)
	if err != nil {
		return nil, err
	}
	if !rolePasswordPattern.Match(password) {
		clear(password)
		return nil, errors.New("database role password must be 32-128 base64url characters")
	}
	return password, nil
}

func databaseURLForRole(adminURL, role, password string) (string, error) {
	parsed, err := url.Parse(adminURL)
	if err != nil || !databaseRolePattern.MatchString(role) || !rolePasswordPattern.MatchString(password) {
		return "", errors.New("invalid role database URL input")
	}
	parsed.User = url.UserPassword(role, password)
	return parsed.String(), nil
}

func writeSecretAtomically(path string, contents []byte) error {
	if path == "" || !filepath.IsAbs(path) || len(contents) == 0 {
		return errors.New("invalid secret output")
	}
	directory := filepath.Dir(path)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("secret output parent must be an existing real directory")
	}
	if existing, err := os.Lstat(path); err == nil {
		if !existing.Mode().IsRegular() || existing.Mode()&os.ModeSymlink != 0 {
			return errors.New("secret output target must be a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".local-operator-secret-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if err := writeFileFull(temporary, contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	cleanup = false
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer directoryHandle.Close()
	return directoryHandle.Sync()
}

func quoteSQLIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func quoteSQLLiteral(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}
