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

const frozenSchemaManifestSHA256 = "fab6e6497d8fbc3bbeba8f77282841448e97bb6434dadb47c4b7b9b7ee40f1a5"

const schemaLedgerSQL = `
SELECT version, checksum
FROM rgs_schema_migrations
ORDER BY version`

const walletRecoveryRegistryFunctionSource = `
BEGIN
    INSERT INTO public.rgs_wallet_recovery_operators (operator_id)
    VALUES (NEW.operator_id)
    ON CONFLICT (operator_id) DO NOTHING;
    RETURN NEW;
END
`

const walletRecoveryRegistryInsertTriggerDefinition = `CREATE TRIGGER rgs_register_wallet_recovery_operator_insert AFTER INSERT ON public.rgs_rounds FOR EACH ROW WHEN (((new.status = ANY (ARRAY['PREPARED'::text, 'WALLET_PENDING'::text])) AND (new.wallet_phase = ANY (ARRAY['APPLY'::text, 'LOOKUP'::text])))) EXECUTE FUNCTION rgs_register_wallet_recovery_operator()`

const walletRecoveryRegistryUpdateTriggerDefinition = `CREATE TRIGGER rgs_register_wallet_recovery_operator_recovery_update AFTER UPDATE OF status, wallet_phase ON public.rgs_rounds FOR EACH ROW WHEN (((new.status = ANY (ARRAY['PREPARED'::text, 'WALLET_PENDING'::text])) AND (new.wallet_phase = ANY (ARRAY['APPLY'::text, 'LOOKUP'::text])) AND ((old.status <> ALL (ARRAY['PREPARED'::text, 'WALLET_PENDING'::text])) OR (old.wallet_phase <> ALL (ARRAY['APPLY'::text, 'LOOKUP'::text]))))) EXECUTE FUNCTION rgs_register_wallet_recovery_operator()`

const walletRecoveryRegistryInvariantSQL = `
WITH target_table AS (
    SELECT relation.oid
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public'
      AND relation.relname='rgs_rounds'
      AND relation.relkind='r'
      AND relation.relpersistence='p'
), target_function AS (
    SELECT procedure.oid
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid=procedure.pronamespace
    JOIN pg_catalog.pg_language AS language
      ON language.oid=procedure.prolang
    JOIN pg_catalog.pg_roles AS owner
      ON owner.oid=procedure.proowner
    WHERE namespace.nspname='public'
      AND procedure.proname='rgs_register_wallet_recovery_operator'
      AND procedure.prokind='f'
      AND procedure.prorettype='pg_catalog.trigger'::pg_catalog.regtype
      AND procedure.pronargs=0
      AND procedure.proargtypes=''::pg_catalog.oidvector
      AND procedure.proallargtypes IS NULL
      AND procedure.proargmodes IS NULL
      AND procedure.proargnames IS NULL
      AND language.lanname='plpgsql'
      AND owner.rolname='rgs_migrator'
      AND NOT procedure.prosecdef
      AND NOT procedure.proleakproof
      AND NOT procedure.proisstrict
      AND NOT procedure.proretset
      AND procedure.provolatile='v'
      AND procedure.proparallel='u'
      AND procedure.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
      AND procedure.prosrc=$1
      AND procedure.proacl IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee <> procedure.proowner
             OR acl.privilege_type <> 'EXECUTE'
             OR acl.is_grantable
      )
      AND (
          SELECT count(*)
          FROM pg_catalog.aclexplode(procedure.proacl) AS acl
          WHERE acl.grantee=procedure.proowner
            AND acl.privilege_type='EXECUTE'
            AND NOT acl.is_grantable
      )=1
), expected_triggers(name, trigger_type, update_columns, definition) AS (
    VALUES
      ('rgs_register_wallet_recovery_operator_insert', 5, ARRAY[]::text[], $2::text),
      ('rgs_register_wallet_recovery_operator_recovery_update', 17,
       ARRAY['status', 'wallet_phase']::text[], $3::text)
), actual_triggers AS (
    SELECT trigger.tgname AS name,
           trigger.tgtype::integer AS trigger_type,
           ARRAY(
               SELECT attribute.attname
               FROM unnest(trigger.tgattr) WITH ORDINALITY AS trigger_column(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute
                 ON attribute.attrelid=trigger.tgrelid
                AND attribute.attnum=trigger_column.attnum
               ORDER BY trigger_column.position
           )::text[] AS update_columns,
           pg_catalog.pg_get_triggerdef(trigger.oid, false) AS definition
    FROM pg_catalog.pg_trigger AS trigger
    JOIN target_table AS relation ON relation.oid=trigger.tgrelid
    JOIN target_function AS procedure ON procedure.oid=trigger.tgfoid
    WHERE NOT trigger.tgisinternal
      AND trigger.tgenabled='O'
      AND trigger.tgnargs=0
      AND trigger.tgqual IS NOT NULL
      AND trigger.tgconstraint=0
      AND trigger.tgconstrrelid=0
      AND NOT trigger.tgdeferrable
      AND NOT trigger.tginitdeferred
      AND trigger.tgoldtable IS NULL
      AND trigger.tgnewtable IS NULL
      AND trigger.tgparentid=0
)
SELECT
    pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT pg_catalog.has_parameter_privilege(
        'rgs_runtime', 'session_replication_role', 'SET'
    )
    AND (SELECT count(*)=1 FROM target_table)
    AND (SELECT count(*)=1 FROM target_function)
    AND (
        SELECT count(*)=2
        FROM pg_catalog.pg_trigger AS trigger
        JOIN target_table AS relation ON relation.oid=trigger.tgrelid
        WHERE NOT trigger.tgisinternal
    )
    AND (SELECT count(*)=2 FROM actual_triggers)
    AND NOT EXISTS (
        SELECT 1
        FROM expected_triggers AS expected
        LEFT JOIN actual_triggers AS actual USING (name)
        WHERE actual.name IS NULL
           OR actual.trigger_type <> expected.trigger_type
           OR actual.update_columns IS DISTINCT FROM expected.update_columns
           OR actual.definition <> expected.definition
    ) AS policy_ok`

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

type schemaInvariantQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
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

func verifyWalletRecoveryRegistryInvariant(ctx context.Context, queryer schemaInvariantQueryer) error {
	var policyOK bool
	if err := queryer.QueryRowContext(
		ctx, walletRecoveryRegistryInvariantSQL,
		walletRecoveryRegistryFunctionSource,
		walletRecoveryRegistryInsertTriggerDefinition,
		walletRecoveryRegistryUpdateTriggerDefinition,
	).Scan(&policyOK); err != nil {
		return operationFailure(ctx, err, ErrSchemaState, "check wallet recovery registry invariant")
	}
	if !policyOK {
		return fmt.Errorf("%w: wallet recovery registry invariant mismatch", ErrSchemaState)
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
	if err := validateSchemaLedger(manifest, actual, false); err != nil {
		return err
	}
	return verifyWalletRecoveryRegistryInvariant(ctx, check.database)
}
