package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/postgres"
)

func migratorLookup(values map[string]string) envLookup {
	return func(name string) (string, bool) {
		value, exists := values[name]
		return value, exists
	}
}

func TestExecuteRejectsUnsupportedCommandsAndCrossCredentialFallback(t *testing.T) {
	for _, arguments := range [][]string{nil, {"down"}, {"force"}, {"baseline"}, {"skip-checksum"}, {"up", "extra"}} {
		var stdout, stderr bytes.Buffer
		if code := execute(arguments, migratorLookup(nil), &stdout, &stderr, nil); code != exitConfig {
			t.Fatalf("execute(%v) = %d, stderr=%q", arguments, code, stderr.String())
		}
	}

	var stdout, stderr bytes.Buffer
	code := execute([]string{"up"}, migratorLookup(map[string]string{
		"RGS_DATABASE_URL":          "postgres://runtime-must-not-be-read",
		"RGS_RUNTIME_DATABASE_ROLE": "rgs_runtime",
	}), &stdout, &stderr, nil)
	if code != exitConfig || !strings.Contains(stderr.String(), "RGS_MIGRATOR_DATABASE_URL") {
		t.Fatalf("cross-credential execute = %d, stderr=%q", code, stderr.String())
	}
}

func TestExecuteMapsStableExitCodes(t *testing.T) {
	base := map[string]string{
		"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret",
		"RGS_RUNTIME_DATABASE_ROLE": "rgs_runtime",
	}
	for _, test := range []struct {
		name string
		err  error
		code int
	}{
		{name: "success", code: exitSuccess},
		{name: "connection", err: postgres.ErrDatabaseUnavailable, code: exitDatabase},
		{name: "schema", err: postgres.ErrSchemaState, code: exitSchema},
		{name: "privilege", err: postgres.ErrRuntimePrivileges, code: exitPrivilege},
		{name: "internal", err: errors.New("unexpected"), code: exitInternal},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			runner := func(context.Context, commandConfig) (postgres.MigrationReport, error) {
				return postgres.MigrationReport{}, test.err
			}
			if code := execute([]string{"up"}, migratorLookup(base), &stdout, &stderr, runner); code != test.code {
				t.Fatalf("execute() = %d, want %d, stderr=%q", code, test.code, stderr.String())
			}
		})
	}
}

func TestExecuteValidatesRoleAndTimeout(t *testing.T) {
	for _, values := range []map[string]string{
		{"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret"},
		{"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret", "RGS_RUNTIME_DATABASE_ROLE": "other"},
		{"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret", "RGS_RUNTIME_DATABASE_ROLE": "rgs_runtime", "RGS_MIGRATION_TIMEOUT": "500ms"},
		{"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret", "RGS_RUNTIME_DATABASE_ROLE": "rgs_runtime", "RGS_MIGRATION_TIMEOUT": "31m"},
	} {
		var stdout, stderr bytes.Buffer
		if code := execute([]string{"verify"}, migratorLookup(values), &stdout, &stderr, nil); code != exitConfig {
			t.Fatalf("execute() = %d for %#v", code, values)
		}
	}
}

func TestExecuteMapsExpiredMigrationContextToDatabaseExit(t *testing.T) {
	values := map[string]string{
		"RGS_MIGRATOR_DATABASE_URL": "postgres://migration-secret",
		"RGS_RUNTIME_DATABASE_ROLE": "rgs_runtime",
		"RGS_MIGRATION_TIMEOUT":     "1s",
	}
	var stdout, stderr bytes.Buffer
	runner := func(ctx context.Context, _ commandConfig) (postgres.MigrationReport, error) {
		<-ctx.Done()
		return postgres.MigrationReport{}, errors.New("driver hid timeout classification")
	}
	started := time.Now()
	code := execute([]string{"verify"}, migratorLookup(values), &stdout, &stderr, runner)
	if code != exitDatabase || time.Since(started) < time.Second {
		t.Fatalf("execute() = %d after %s, stderr=%q", code, time.Since(started), stderr.String())
	}
}
