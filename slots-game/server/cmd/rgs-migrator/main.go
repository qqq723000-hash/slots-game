package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/postgres"
)

const (
	exitSuccess   = 0
	exitInternal  = 1
	exitConfig    = 2
	exitDatabase  = 3
	exitSchema    = 4
	exitPrivilege = 5

	defaultMigrationTimeout = 2 * time.Minute
	minimumMigrationTimeout = time.Second
	maximumMigrationTimeout = 30 * time.Minute
)

type envLookup func(string) (string, bool)

type commandConfig struct {
	Command     string
	DatabaseURL string
	RuntimeRole string
	Timeout     time.Duration
}

type commandRunner func(context.Context, commandConfig) (postgres.MigrationReport, error)

func main() {
	os.Exit(execute(os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr, runCommand))
}

func execute(
	arguments []string,
	lookup envLookup,
	stdout io.Writer,
	stderr io.Writer,
	runner commandRunner,
) int {
	if len(arguments) == 1 && (arguments[0] == "--help" || arguments[0] == "-h") {
		writeUsage(stdout)
		return exitSuccess
	}
	if len(arguments) != 1 || (arguments[0] != "up" && arguments[0] != "verify") {
		writeUsage(stderr)
		return exitConfig
	}
	config, err := loadCommandConfig(arguments[0], lookup)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitConfig
	}
	if runner == nil {
		fmt.Fprintln(stderr, "rgs-migrator internal runner is unavailable")
		return exitInternal
	}

	ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
	defer cancel()
	report, err := runner(ctx, config)
	if err != nil {
		if ctx.Err() != nil {
			err = errors.Join(postgres.ErrDatabaseUnavailable, ctx.Err())
		}
		code, message := migrationExit(err)
		fmt.Fprintln(stderr, message)
		return code
	}
	payload := struct {
		Status  string `json:"status"`
		Command string `json:"command"`
		postgres.MigrationReport
	}{Status: "ready", Command: config.Command, MigrationReport: report}
	if err := json.NewEncoder(stdout).Encode(payload); err != nil {
		fmt.Fprintln(stderr, "rgs-migrator could not write its result")
		return exitInternal
	}
	return exitSuccess
}

func loadCommandConfig(command string, lookup envLookup) (commandConfig, error) {
	if lookup == nil {
		return commandConfig{}, errors.New("rgs-migrator environment lookup is unavailable")
	}
	databaseURL, _ := lookup("RGS_MIGRATOR_DATABASE_URL")
	databaseURL = strings.TrimSpace(databaseURL)
	if databaseURL == "" {
		return commandConfig{}, errors.New("RGS_MIGRATOR_DATABASE_URL is required")
	}
	runtimeRole, _ := lookup("RGS_RUNTIME_DATABASE_ROLE")
	runtimeRole = strings.TrimSpace(runtimeRole)
	if runtimeRole != postgres.CanonicalRuntimeRole {
		return commandConfig{}, errors.New("RGS_RUNTIME_DATABASE_ROLE must be rgs_runtime")
	}
	timeout := defaultMigrationTimeout
	if value, exists := lookup("RGS_MIGRATION_TIMEOUT"); exists {
		parsed, err := time.ParseDuration(strings.TrimSpace(value))
		if err != nil || parsed < minimumMigrationTimeout || parsed > maximumMigrationTimeout {
			return commandConfig{}, errors.New("RGS_MIGRATION_TIMEOUT must be between 1s and 30m")
		}
		timeout = parsed
	}
	return commandConfig{
		Command: command, DatabaseURL: databaseURL,
		RuntimeRole: runtimeRole, Timeout: timeout,
	}, nil
}

func runCommand(ctx context.Context, config commandConfig) (postgres.MigrationReport, error) {
	database, err := sql.Open("pgx", config.DatabaseURL)
	if err != nil {
		return postgres.MigrationReport{}, postgres.ErrDatabaseUnavailable
	}
	defer database.Close()
	database.SetMaxOpenConns(2)
	database.SetMaxIdleConns(1)
	database.SetConnMaxLifetime(5 * time.Minute)
	if err := database.PingContext(ctx); err != nil {
		return postgres.MigrationReport{}, postgres.ErrDatabaseUnavailable
	}
	if config.Command == "up" {
		return postgres.MigrateAndReconcile(ctx, database, config.RuntimeRole)
	}
	return postgres.VerifyMigratedSchema(ctx, database, config.RuntimeRole)
}

func migrationExit(err error) (int, string) {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded),
		errors.Is(err, postgres.ErrDatabaseUnavailable):
		return exitDatabase, "rgs-migrator database operation failed"
	case errors.Is(err, postgres.ErrSchemaState):
		return exitSchema, "rgs-migrator schema verification failed"
	case errors.Is(err, postgres.ErrRuntimePrivileges):
		return exitPrivilege, "rgs-migrator database role policy failed"
	default:
		return exitInternal, "rgs-migrator failed"
	}
}

func writeUsage(writer io.Writer) {
	fmt.Fprintln(writer, "usage: rgs-migrator up|verify")
}
