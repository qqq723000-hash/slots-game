package postgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestExpectedSchemaManifestIsFrozen(t *testing.T) {
	manifest, err := ExpectedSchemaManifest()
	if err != nil {
		t.Fatalf("ExpectedSchemaManifest() error = %v", err)
	}
	want := []MigrationIdentity{
		{Version: "0001_rgs_core", Checksum: "a005c3d34d87e5b51353c403a929b8ca41497d5bcb171f4d7fed1db716aee83c"},
		{Version: "0002_outbox_delivery", Checksum: "c3d9062080aaaee42c5bf3afe17561b2ab4063b88c76f3151d2f1fd359e2ca51"},
		{Version: "0003_launch_idempotency_retention", Checksum: "1c1cd26a8fb7c9714fdbec757a3e677f8c125a6f6f727b706cec48728226094b"},
		{Version: "0004_round_integrity_quarantine", Checksum: "020b1eff122e18bc595ea1f1805ca2b176c2c6faea579125b8ff7f705c1841b9"},
		{Version: "0005_session_integrity_quarantine", Checksum: "33a6ba5c45342e9e1712b4184f911bead1e26d25197cf166a322a147164ecf9b"},
		{Version: "0006_round_input_feature_state", Checksum: "e533823abbc3512577bdcd473771e26ae106954091916302a4ebf428d476254a"},
		{Version: "0007_result_delivery_cursor", Checksum: "2dffbfb97d2cf2c8e1bfd9c93348c1e63237e29e417340d31e0200b3e7316586"},
		{Version: "0008_wallet_recovery_scheduler", Checksum: "73c7c28413a4c7313b5f451f95750e2a6be986fca21717e48763c9f9f4062420"},
		{Version: "0009_postgres_hot_path", Checksum: "fe05563382fa6f558ecfb8944658740f718551032274a81521711b2d25e8314c"},
		{Version: "0010_wallet_recovery_registry_invariant", Checksum: "5fc3fe96f71a66bd252713751e36139000eb6e503f981fb520df7e5f3412ce17"},
	}
	if manifest.Version != want[len(want)-1].Version ||
		manifest.SHA256 != "fab6e6497d8fbc3bbeba8f77282841448e97bb6434dadb47c4b7b9b7ee40f1a5" ||
		!reflect.DeepEqual(manifest.Migrations, want) {
		t.Fatalf("manifest = %+v, want version/checksum freeze %+v", manifest, want)
	}
}

func TestSchemaLedgerValidationModes(t *testing.T) {
	manifest, err := ExpectedSchemaManifest()
	if err != nil {
		t.Fatal(err)
	}
	prefix := append([]MigrationIdentity(nil), manifest.Migrations[:3]...)
	exact := append([]MigrationIdentity(nil), manifest.Migrations...)

	for _, test := range []struct {
		name        string
		actual      []MigrationIdentity
		allowPrefix bool
		wantError   bool
	}{
		{name: "fresh prefix", allowPrefix: true},
		{name: "ordered prefix", actual: prefix, allowPrefix: true},
		{name: "exact for up", actual: exact, allowPrefix: true},
		{name: "exact for readiness", actual: exact},
		{name: "behind readiness", actual: prefix, wantError: true},
		{name: "gap", actual: []MigrationIdentity{exact[0], exact[2]}, allowPrefix: true, wantError: true},
		{name: "checksum drift", actual: []MigrationIdentity{{Version: exact[0].Version, Checksum: "bad"}}, allowPrefix: true, wantError: true},
		{name: "future", actual: append(exact, MigrationIdentity{Version: "9999_future", Checksum: exact[0].Checksum}), allowPrefix: true, wantError: true},
		{name: "duplicate", actual: []MigrationIdentity{exact[0], exact[0]}, allowPrefix: true, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateSchemaLedger(manifest, test.actual, test.allowPrefix)
			if (err != nil) != test.wantError {
				t.Fatalf("validateSchemaLedger() error = %v, wantError=%v", err, test.wantError)
			}
		})
	}
}

func TestSchemaCheckRequiresExactLedger(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	check, err := NewSchemaCheck(database)
	if err != nil {
		t.Fatal(err)
	}
	if check.Name() != "database_schema" {
		t.Fatalf("Name() = %q", check.Name())
	}
	manifest, _ := ExpectedSchemaManifest()
	rows := sqlmock.NewRows([]string{"version", "checksum"})
	for _, item := range manifest.Migrations {
		rows.AddRow(item.Version, item.Checksum)
	}
	mock.ExpectQuery(regexp.QuoteMeta(schemaLedgerSQL)).WillReturnRows(rows)
	mock.ExpectQuery(regexp.QuoteMeta(walletRecoveryRegistryInvariantSQL)).
		WithArgs(
			walletRecoveryRegistryFunctionSource,
			walletRecoveryRegistryInsertTriggerDefinition,
			walletRecoveryRegistryUpdateTriggerDefinition,
		).
		WillReturnRows(sqlmock.NewRows([]string{"policy_ok"}).AddRow(true))
	if err := check.Check(context.Background()); err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestWalletRecoveryRegistryInvariantFailsClosed(t *testing.T) {
	for _, test := range []struct {
		name      string
		rows      *sqlmock.Rows
		queryErr  error
		wantError error
	}{
		{
			name: "catalog mismatch", rows: sqlmock.NewRows([]string{"policy_ok"}).AddRow(false),
			wantError: ErrSchemaState,
		},
		{
			name: "catalog query failure", queryErr: driver.ErrBadConn,
			wantError: ErrSchemaState,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			expectation := mock.ExpectQuery(regexp.QuoteMeta(walletRecoveryRegistryInvariantSQL)).
				WithArgs(
					walletRecoveryRegistryFunctionSource,
					walletRecoveryRegistryInsertTriggerDefinition,
					walletRecoveryRegistryUpdateTriggerDefinition,
				)
			if test.queryErr != nil {
				expectation.WillReturnError(test.queryErr)
			} else {
				expectation.WillReturnRows(test.rows)
			}
			if err := verifyWalletRecoveryRegistryInvariant(context.Background(), database); !errors.Is(err, test.wantError) {
				t.Fatalf("verifyWalletRecoveryRegistryInvariant() error = %v, want %v", err, test.wantError)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWalletRecoveryRegistryInvariantRejectsReplicaModeBypass(t *testing.T) {
	for _, required := range []string{
		"trigger.tgenabled='O'",
		"trigger.tgnargs=0",
		"current_setting('session_replication_role')='origin'",
		"NOT pg_catalog.has_parameter_privilege(",
		"'rgs_runtime', 'session_replication_role', 'SET'",
	} {
		if !strings.Contains(walletRecoveryRegistryInvariantSQL, required) {
			t.Fatalf("wallet recovery registry invariant is missing %q", required)
		}
	}
}

func TestOperationFailureClassifiesConnectivityWithoutLeakingDriverDetails(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, test := range []struct {
		name     string
		ctx      context.Context
		err      error
		wantKind error
	}{
		{name: "canceled context", ctx: canceled, err: errors.New("driver detail"), wantKind: ErrDatabaseUnavailable},
		{name: "bad connection", ctx: context.Background(), err: driver.ErrBadConn, wantKind: ErrDatabaseUnavailable},
		{name: "closed sql connection", ctx: context.Background(), err: sql.ErrConnDone, wantKind: ErrDatabaseUnavailable},
		{name: "closed pg connection", ctx: context.Background(), err: pgconn.ErrConnClosed, wantKind: ErrDatabaseUnavailable},
		{name: "connectivity SQLSTATE", ctx: context.Background(), err: &pgconn.PgError{Code: "08006"}, wantKind: ErrDatabaseUnavailable},
		{name: "administrator shutdown", ctx: context.Background(), err: &pgconn.PgError{Code: "57P01"}, wantKind: ErrDatabaseUnavailable},
		{name: "undefined table", ctx: context.Background(), err: &pgconn.PgError{Code: "42P01"}, wantKind: ErrSchemaState},
	} {
		t.Run(test.name, func(t *testing.T) {
			classified := operationFailure(
				test.ctx, errors.Join(errors.New("secret DSN and SQL"), test.err),
				ErrSchemaState, "read migration ledger",
			)
			if !errors.Is(classified, test.wantKind) {
				t.Fatalf("operationFailure() = %v, want kind %v", classified, test.wantKind)
			}
			if strings.Contains(classified.Error(), "secret") || strings.Contains(classified.Error(), "SQLSTATE") {
				t.Fatalf("operationFailure() leaked driver details: %v", classified)
			}
		})
	}
}
