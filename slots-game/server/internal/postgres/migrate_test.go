package postgres

import (
	"bytes"
	"context"
	"io/fs"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestEmbeddedMigrationsAreOrderedAndChecksummed(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatalf("loadMigrations returned error: %v", err)
	}
	versionPattern := regexp.MustCompile(`^[0-9]{4}_[a-z0-9_]+$`)
	for index, item := range items {
		if !versionPattern.MatchString(item.version) {
			t.Fatalf("migration version %q is invalid", item.version)
		}
		if len(item.checksum) != 64 || item.contents == "" {
			t.Fatalf("migration %q is empty or has invalid checksum", item.version)
		}
		if index > 0 && items[index-1].version >= item.version {
			t.Fatalf("migrations are not strictly ordered: %q then %q", items[index-1].version, item.version)
		}
	}
}

func TestLocalizedHistoricalMigrationKeepsLedgerIdentityAndRejectsExecutableDrift(t *testing.T) {
	const version = "0002_outbox_delivery"
	contents, err := fs.ReadFile(migrationFiles, "migrations/"+version+".sql")
	if err != nil {
		t.Fatal(err)
	}
	want := localizedHistoricalMigrations[version].ledgerChecksum

	localizedComments := append([]byte("-- 可替换的中文迁移说明。\n"), contents...)
	if got, err := migrationChecksum(version, localizedComments); err != nil || got != want {
		t.Fatalf("localized comment checksum = %q, error = %v, want %q", got, err, want)
	}

	tests := []struct {
		name     string
		contents []byte
	}{
		{
			name: "SQL token changed",
			contents: bytes.Replace(contents,
				[]byte("ADD COLUMN lease_token text"),
				[]byte("ADD COLUMN lease_token varchar(1)"), 1),
		},
		{
			name: "SQL order changed",
			contents: bytes.Replace(contents,
				[]byte("    ADD COLUMN lease_token text,\n    ADD COLUMN last_error text;"),
				[]byte("    ADD COLUMN last_error text,\n    ADD COLUMN lease_token text;"), 1),
		},
		{
			name: "SQL whitespace changed",
			contents: bytes.Replace(contents,
				[]byte("UPDATE rgs_outbox\n"),
				[]byte("UPDATE  rgs_outbox\n"), 1),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if bytes.Equal(test.contents, contents) {
				t.Fatal("test mutation did not change migration contents")
			}
			if _, err := migrationChecksum(version, test.contents); err == nil {
				t.Fatal("executable migration drift unexpectedly accepted")
			}
		})
	}
}

func TestMigratorRolePolicyRequiresExactUnprivilegedIdentity(t *testing.T) {
	for _, required := range []string{
		"rolname = 'rgs_migrator'",
		"NOT rolinherit",
		"NOT EXISTS (",
		"pg_auth_members",
		"NOT has_database_privilege(rolname, current_database(), 'CREATE')",
		"NOT has_database_privilege(rolname, current_database(), 'TEMPORARY')",
	} {
		if !strings.Contains(migratorRoleCheckSQL, required) {
			t.Fatalf("migrator role checker is missing %q", required)
		}
	}
}

func TestMigrateAndReconcileUsesOneLockedTransaction(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ExpectedSchemaManifest()
	if err != nil {
		t.Fatal(err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(migratorRoleCheckSQL)).
		WillReturnRows(sqlmock.NewRows([]string{"policy_ok"}).AddRow(true))
	mock.ExpectExec(regexp.QuoteMeta(`SELECT pg_advisory_xact_lock($1)`)).
		WithArgs(migrationAdvisoryLock).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`CREATE TABLE IF NOT EXISTS rgs_schema_migrations`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(regexp.QuoteMeta(schemaLedgerSQL)).
		WillReturnRows(sqlmock.NewRows([]string{"version", "checksum"}))
	for _, item := range migrations {
		mock.ExpectExec(regexp.QuoteMeta(item.contents)).
			WillReturnResult(sqlmock.NewResult(0, 0))
		mock.ExpectExec(`INSERT INTO rgs_schema_migrations`).
			WithArgs(item.version, item.checksum).
			WillReturnResult(sqlmock.NewResult(0, 1))
	}
	for _, statement := range runtimeGrantStatements() {
		mock.ExpectExec(regexp.QuoteMeta(statement)).
			WillReturnResult(sqlmock.NewResult(0, 0))
	}
	ledgerRows := sqlmock.NewRows([]string{"version", "checksum"})
	for _, item := range manifest.Migrations {
		ledgerRows.AddRow(item.Version, item.Checksum)
	}
	mock.ExpectQuery(regexp.QuoteMeta(schemaLedgerSQL)).WillReturnRows(ledgerRows)
	mock.ExpectQuery(regexp.QuoteMeta(runtimePrivilegeCheckSQL)).
		WithArgs(CanonicalRuntimeRole, false).
		WillReturnRows(sqlmock.NewRows([]string{"policy_ok"}).AddRow(true))
	mock.ExpectCommit()

	report, err := MigrateAndReconcile(context.Background(), database, CanonicalRuntimeRole)
	if err != nil {
		t.Fatalf("MigrateAndReconcile() error = %v", err)
	}
	if len(report.Applied) != len(migrations) || report.SchemaVersion != manifest.Version {
		t.Fatalf("MigrateAndReconcile() report = %+v", report)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestOutboxMigrationReleasesLegacyUnfencedLeasesBeforeConstraint(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatalf("loadMigrations returned error: %v", err)
	}
	var contents string
	for _, item := range items {
		if item.version == "0002_outbox_delivery" {
			contents = item.contents
			break
		}
	}
	if contents == "" {
		t.Fatal("0002_outbox_delivery migration is missing")
	}
	releaseLease := strings.Index(contents, "UPDATE rgs_outbox")
	leaseConstraint := strings.Index(contents, "ADD CONSTRAINT rgs_outbox_lease_state")
	if releaseLease < 0 || leaseConstraint < 0 || releaseLease >= leaseConstraint {
		t.Fatal("legacy leases must be released before adding the fenced lease constraint")
	}
}

func TestIntegrityQuarantineMigrationAddsDurableIdempotencyMarker(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatalf("loadMigrations returned error: %v", err)
	}
	for _, item := range items {
		if item.version == "0004_round_integrity_quarantine" {
			if !strings.Contains(item.contents, "integrity_quarantined_at") {
				t.Fatal("integrity quarantine migration does not add its durable marker")
			}
			return
		}
	}
	t.Fatal("0004_round_integrity_quarantine migration is missing")
}

func TestSessionIntegrityQuarantineMigrationAddsDurableIdempotencyMarker(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatalf("loadMigrations returned error: %v", err)
	}
	for _, item := range items {
		if item.version == "0005_session_integrity_quarantine" {
			if !strings.Contains(item.contents, "integrity_quarantined_at") ||
				!strings.Contains(item.contents, "status = 'BLOCKED'") {
				t.Fatal("session integrity migration lacks its marker or blocked-state guard")
			}
			return
		}
	}
	t.Fatal("0005_session_integrity_quarantine migration is missing")
}

func TestRoundInputFeatureMigrationBackfillsOnlyProvableOpenRounds(t *testing.T) {
	items, err := loadMigrations()
	if err != nil {
		t.Fatalf("loadMigrations returned error: %v", err)
	}
	for _, item := range items {
		if item.version != "0006_round_input_feature_state" {
			continue
		}
		for _, required := range []string{
			"input_feature_state jsonb",
			"r.status IN ('PREPARED', 'WALLET_PENDING')",
			"s.pending_round_id = r.round_id",
			"s.revision = r.starting_revision",
			"input_feature_state IS NULL",
		} {
			if !strings.Contains(item.contents, required) {
				t.Fatalf("round input feature migration is missing %q", required)
			}
		}
		if strings.Contains(item.contents, "ALTER COLUMN input_feature_state SET NOT NULL") {
			t.Fatal("legacy final rounds must not be rewritten with a guessed input state")
		}
		return
	}
	t.Fatal("0006_round_input_feature_state migration is missing")
}
