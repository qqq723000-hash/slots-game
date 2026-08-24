package postgres

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"slots-game/server/internal/rgs"
)

const testRecoveryRegistryFunctionInstallPrefix = `
CREATE OR REPLACE FUNCTION public.rgs_register_wallet_recovery_operator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$`

const testRecoveryRegistryFunctionInstallSuffix = `$function$;
REVOKE ALL ON FUNCTION public.rgs_register_wallet_recovery_operator() FROM PUBLIC`

func TestPostgresWalletRecoveryRegistrySchemaInvariantFailsClosed(t *testing.T) {
	databaseURLs := requirePostgresTestURLs(t)
	runtimeDatabase, err := sql.Open("pgx", databaseURLs.runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimeDatabase.Close()
	migratorDatabase, err := sql.Open("pgx", databaseURLs.migrator)
	if err != nil {
		t.Fatal(err)
	}
	defer migratorDatabase.Close()
	truncateIntegrationTables(t, migratorDatabase)
	defer truncateIntegrationTables(t, migratorDatabase)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	schemaCheck, err := NewSchemaCheck(runtimeDatabase)
	if err != nil {
		t.Fatal(err)
	}
	defer restoreWalletRecoveryRegistrySchemaInvariant(t, migratorDatabase)
	assertWalletRecoveryRegistrySchemaInvariantReady(
		t, ctx, schemaCheck, migratorDatabase,
	)
	var runtimeCanSetReplicationRole bool
	if err := runtimeDatabase.QueryRowContext(ctx, `
		SELECT has_parameter_privilege(
			current_user, 'session_replication_role', 'SET'
		)`,
	).Scan(&runtimeCanSetReplicationRole); err != nil {
		t.Fatal(err)
	}
	if runtimeCanSetReplicationRole {
		t.Fatal("runtime role can bypass origin-only triggers")
	}
	if _, err := runtimeDatabase.ExecContext(
		ctx, `SET session_replication_role='replica'`,
	); err == nil || sqlState(err) != "42501" {
		t.Fatalf("runtime replication-role SET error = %v, SQLSTATE=%q, want 42501", err, sqlState(err))
	}

	mutations := []struct {
		name                  string
		sql                   string
		prepareFallbackSuffix string
	}{
		{
			name: "disabled insert trigger",
			sql: `ALTER TABLE public.rgs_rounds
				DISABLE TRIGGER rgs_register_wallet_recovery_operator_insert`,
			prepareFallbackSuffix: "disabled-trigger",
		},
		{
			name: "replica-only insert trigger",
			sql: `ALTER TABLE public.rgs_rounds
				ENABLE REPLICA TRIGGER rgs_register_wallet_recovery_operator_insert`,
			prepareFallbackSuffix: "replica-trigger",
		},
		{
			name: "dropped recovery update trigger",
			sql: `DROP TRIGGER rgs_register_wallet_recovery_operator_recovery_update
				ON public.rgs_rounds`,
		},
		{
			name: "replaced trigger function",
			sql: `CREATE OR REPLACE FUNCTION public.rgs_register_wallet_recovery_operator()
				RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
				SET search_path = pg_catalog, public
				AS $function$ BEGIN RETURN NEW; END $function$`,
			prepareFallbackSuffix: "replaced-function",
		},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			if _, err := migratorDatabase.ExecContext(ctx, mutation.sql); err != nil {
				t.Fatal(err)
			}
			if err := schemaCheck.Check(ctx); !errors.Is(err, ErrSchemaState) {
				t.Fatalf("runtime SchemaCheck error = %v, want ErrSchemaState", err)
			}
			if _, err := VerifyMigratedSchema(
				ctx, migratorDatabase, CanonicalRuntimeRole,
			); !errors.Is(err, ErrSchemaState) {
				t.Fatalf("migrator verify error = %v, want ErrSchemaState", err)
			}
			if mutation.prepareFallbackSuffix != "" {
				assertPrepareRegistryFallbackDuringSchemaDrift(
					t, ctx, runtimeDatabase, mutation.prepareFallbackSuffix,
				)
			}
			restoreWalletRecoveryRegistrySchemaInvariant(t, migratorDatabase)
			assertWalletRecoveryRegistrySchemaInvariantReady(
				t, ctx, schemaCheck, migratorDatabase,
			)
		})
	}
}

func assertPrepareRegistryFallbackDuringSchemaDrift(
	t *testing.T,
	ctx context.Context,
	runtimeDatabase *sql.DB,
	suffix string,
) {
	t.Helper()
	repository, err := NewRepository(runtimeDatabase)
	if err != nil {
		t.Fatal(err)
	}
	operatorID := "operator-schema-drift-" + suffix
	preparePostgresRecoveryFixture(
		t, ctx, repository,
		rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget(
			"https://wallet.test.invalid/schema-drift-"+suffix,
		)),
		operatorID, "session-schema-drift-"+suffix, "round-schema-drift-"+suffix,
	)
	var registered int
	if err := runtimeDatabase.QueryRowContext(ctx, `
		SELECT count(*) FROM rgs_wallet_recovery_operators WHERE operator_id=$1`,
		operatorID,
	).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if registered != 1 {
		t.Fatalf("PREPARE registry fallback count = %d, want 1", registered)
	}
}

func assertWalletRecoveryRegistrySchemaInvariantReady(
	t *testing.T,
	ctx context.Context,
	schemaCheck *SchemaCheck,
	migratorDatabase *sql.DB,
) {
	t.Helper()
	if err := schemaCheck.Check(ctx); err != nil {
		t.Fatalf("runtime schema invariant readiness: %v", err)
	}
	if _, err := VerifyMigratedSchema(
		ctx, migratorDatabase, CanonicalRuntimeRole,
	); err != nil {
		t.Fatalf("migrator schema invariant verify: %v", err)
	}
}

func restoreWalletRecoveryRegistrySchemaInvariant(t *testing.T, migratorDatabase *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	functionSQL := testRecoveryRegistryFunctionInstallPrefix +
		walletRecoveryRegistryFunctionSource + testRecoveryRegistryFunctionInstallSuffix
	if _, err := migratorDatabase.ExecContext(ctx, functionSQL); err != nil {
		t.Errorf("restore recovery registry function: %v", err)
		return
	}
	if _, err := migratorDatabase.ExecContext(ctx, `
		DROP TRIGGER IF EXISTS rgs_register_wallet_recovery_operator_insert ON public.rgs_rounds;
		DROP TRIGGER IF EXISTS rgs_register_wallet_recovery_operator_recovery_update ON public.rgs_rounds`); err != nil {
		t.Errorf("drop recovery registry triggers before restore: %v", err)
		return
	}
	if _, err := migratorDatabase.ExecContext(ctx, testRecoveryRegistryTriggerInstallSQL); err != nil {
		t.Errorf("restore recovery registry triggers: %v", err)
	}
}
