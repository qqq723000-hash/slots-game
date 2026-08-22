package postgres

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrDatabaseUnavailable = errors.New("postgres database unavailable")
	ErrSchemaState         = errors.New("postgres schema state invalid")
	ErrRuntimePrivileges   = errors.New("postgres runtime privileges invalid")
)

const frozenSchemaManifestSHA256 = "856304eb1796eb81f54f6d41e12c6bbe071f17b69e665f381dfc55d410b7ae6e"

const schemaLedgerSQL = `
SELECT version, checksum
FROM rgs_schema_migrations
ORDER BY version`

type MigrationIdentity struct {
	Version  string `json:"version"`
	Checksum string `json:"checksum"`
}

type SchemaManifest struct {
	Version    string              `json:"version"`
	SHA256     string              `json:"sha256"`
	Migrations []MigrationIdentity `json:"migrations,omitempty"`
}

type schemaQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func operationFailure(ctx context.Context, err, fallback error, operation string) error {
	if postgresConnectionFailure(ctx, err) {
		return fmt.Errorf("%w: %s", ErrDatabaseUnavailable, operation)
	}
	return fmt.Errorf("%w: %s", fallback, operation)
}

func postgresConnectionFailure(ctx context.Context, err error) bool {
	if ctx != nil && ctx.Err() != nil {
		return true
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) ||
		errors.Is(err, pgconn.ErrConnClosed) || pgconn.Timeout(err) {
		return true
	}
	var connectError *pgconn.ConnectError
	if errors.As(err, &connectError) {
		return true
	}
	var state interface{ SQLState() string }
	if !errors.As(err, &state) {
		return false
	}
	code := state.SQLState()
	return strings.HasPrefix(code, "08") || strings.HasPrefix(code, "53") ||
		code == "55P03" || code == "57014" || strings.HasPrefix(code, "57P") ||
		code == "58030"
}

func ExpectedSchemaManifest() (SchemaManifest, error) {
	items, err := loadMigrations()
	if err != nil {
		return SchemaManifest{}, errors.Join(ErrSchemaState, err)
	}
	migrations := make([]MigrationIdentity, 0, len(items))
	digest := sha256.New()
	writer := bufio.NewWriter(digest)
	for _, item := range items {
		migrations = append(migrations, MigrationIdentity{
			Version: item.version, Checksum: item.checksum,
		})
		_, _ = fmt.Fprintf(writer, "%s\t%s\n", item.version, item.checksum)
	}
	if err := writer.Flush(); err != nil {
		return SchemaManifest{}, errors.Join(ErrSchemaState, err)
	}
	manifestSHA := hex.EncodeToString(digest.Sum(nil))
	if manifestSHA != frozenSchemaManifestSHA256 {
		return SchemaManifest{}, fmt.Errorf("%w: embedded manifest checksum changed", ErrSchemaState)
	}
	return SchemaManifest{
		Version: migrations[len(migrations)-1].Version,
		SHA256:  manifestSHA, Migrations: migrations,
	}, nil
}

func readSchemaLedger(ctx context.Context, queryer schemaQuerier) ([]MigrationIdentity, error) {
	rows, err := queryer.QueryContext(ctx, schemaLedgerSQL)
	if err != nil {
		return nil, operationFailure(ctx, err, ErrSchemaState, "read migration ledger")
	}
	defer rows.Close()
	var actual []MigrationIdentity
	for rows.Next() {
		var item MigrationIdentity
		if err := rows.Scan(&item.Version, &item.Checksum); err != nil {
			return nil, operationFailure(ctx, err, ErrSchemaState, "decode migration ledger")
		}
		item.Version = strings.TrimSpace(item.Version)
		item.Checksum = strings.TrimSpace(item.Checksum)
		actual = append(actual, item)
	}
	if err := rows.Err(); err != nil {
		return nil, operationFailure(ctx, err, ErrSchemaState, "iterate migration ledger")
	}
	return actual, nil
}

func validateSchemaLedger(manifest SchemaManifest, actual []MigrationIdentity, allowPrefix bool) error {
	if len(actual) > len(manifest.Migrations) {
		return fmt.Errorf("%w: migration ledger contains an unknown version", ErrSchemaState)
	}
	for index, item := range actual {
		expected := manifest.Migrations[index]
		if item.Version != expected.Version {
			return fmt.Errorf("%w: migration ledger is not an ordered prefix", ErrSchemaState)
		}
		if item.Checksum != expected.Checksum {
			return fmt.Errorf("%w: migration checksum mismatch", ErrSchemaState)
		}
	}
	if !allowPrefix && len(actual) != len(manifest.Migrations) {
		return fmt.Errorf("%w: migration ledger is incomplete", ErrSchemaState)
	}
	return nil
}

type SchemaCheck struct {
	database *sql.DB
}

func NewSchemaCheck(database *sql.DB) (*SchemaCheck, error) {
	if database == nil {
		return nil, fmt.Errorf("%w: database is required", ErrSchemaState)
	}
	return &SchemaCheck{database: database}, nil
}

func (*SchemaCheck) Name() string { return "database_schema" }

func (check *SchemaCheck) Check(ctx context.Context) error {
	manifest, err := ExpectedSchemaManifest()
	if err != nil {
		return err
	}
	actual, err := readSchemaLedger(ctx, check.database)
	if err != nil {
		return err
	}
	return validateSchemaLedger(manifest, actual, false)
}
