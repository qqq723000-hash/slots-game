package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

const (
	CanonicalMigratorRole         = "rgs_migrator"
	CanonicalRuntimeRole          = "rgs_runtime"
	RuntimePrivilegePolicyVersion = "rgs-runtime-dml-v2"
)

var runtimeInsertColumns = map[string][]string{
	"rgs_sessions": {
		"operator_id", "session_id", "player_id", "wallet_account_id", "wallet_session_id",
		"game_id", "definition_version", "definition_hash", "currency", "currency_exponent",
		"jurisdiction", "status", "balance_snapshot_minor", "sequence", "revision",
		"feature_state", "pending_round_id", "expires_at",
	},
	"rgs_rounds": {
		"operator_id", "session_id", "round_id", "server_transaction_id", "request_fingerprint",
		"status", "round_kind", "game_id", "definition_version", "definition_hash", "currency",
		"bet_minor", "input_feature_state", "charged_minor", "win_minor", "starting_revision",
		"resulting_revision", "sequence", "result_json", "outcome_hash", "created_at", "updated_at",
	},
	"rgs_wallet_transactions": {
		"operator_id", "transaction_id", "session_id", "round_id", "kind", "status", "currency",
		"amount_minor", "request_fingerprint", "created_at", "updated_at",
	},
	"rgs_outbox":          {"operator_id", "aggregate_type", "aggregate_id", "event_type", "payload"},
	"rgs_operator_nonces": {"operator_id", "key_id", "nonce_hash", "expires_at", "created_at"},
	"rgs_launch_codes":    {"code_hash", "operator_id", "claims_json", "expires_at", "created_at"},
}

var runtimeUpdateColumns = map[string][]string{
	"rgs_sessions": {
		"status", "balance_snapshot_minor", "sequence", "revision", "feature_state",
		"pending_round_id", "updated_at", "integrity_quarantined_at",
	},
	"rgs_rounds": {
		"status", "result_json", "wallet_transaction_id", "wallet_balance_minor", "wallet_lease_until",
		"failure_code", "retry_count", "updated_at", "committed_at", "integrity_quarantined_at",
		"result_delivery_required", "result_hash", "result_acknowledged_at",
	},
	"rgs_wallet_transactions": {"status", "operator_reference", "response_json", "failure_code", "updated_at"},
	"rgs_outbox": {
		"available_at", "lease_owner", "lease_token", "lease_until", "published_at", "attempts", "last_error",
	},
	"rgs_operator_nonces": {"expires_at", "created_at"},
	"rgs_launch_codes":    {"consumed_at"},
}

var runtimeDeleteTables = []string{"rgs_launch_codes", "rgs_operator_nonces"}

var runtimeManagedTables = []string{
	"rgs_launch_codes",
	"rgs_operator_nonces",
	"rgs_outbox",
	"rgs_rounds",
	"rgs_schema_migrations",
	"rgs_sessions",
	"rgs_wallet_transactions",
}

var runtimePrivilegeCheckSQL = buildRuntimePrivilegeCheckSQL()

type privilegeQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type privilegeExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type RuntimePrivilegeCheck struct {
	database *sql.DB
}

func NewRuntimePrivilegeCheck(database *sql.DB) (*RuntimePrivilegeCheck, error) {
	if database == nil {
		return nil, fmt.Errorf("%w: database is required", ErrRuntimePrivileges)
	}
	return &RuntimePrivilegeCheck{database: database}, nil
}

func (*RuntimePrivilegeCheck) Name() string { return "database_privileges" }

func (check *RuntimePrivilegeCheck) Check(ctx context.Context) error {
	return verifyRuntimePrivileges(ctx, check.database, CanonicalRuntimeRole, true)
}

func verifyRuntimePrivileges(
	ctx context.Context,
	queryer privilegeQueryer,
	role string,
	requireCurrentRole bool,
) error {
	if role != CanonicalRuntimeRole {
		return fmt.Errorf("%w: unsupported runtime role", ErrRuntimePrivileges)
	}
	var policyOK bool
	if err := queryer.QueryRowContext(
		ctx, runtimePrivilegeCheckSQL, role, requireCurrentRole,
	).Scan(&policyOK); err != nil {
		return operationFailure(ctx, err, ErrRuntimePrivileges, "check database privilege policy")
	}
	if !policyOK {
		return fmt.Errorf("%w: policy mismatch", ErrRuntimePrivileges)
	}
	return nil
}

func reconcileRuntimePrivileges(ctx context.Context, executor privilegeExecutor, role string) error {
	if role != CanonicalRuntimeRole {
		return fmt.Errorf("%w: unsupported runtime role", ErrRuntimePrivileges)
	}
	for _, statement := range runtimeGrantStatements() {
		if _, err := executor.ExecContext(ctx, statement); err != nil {
			return operationFailure(ctx, err, ErrRuntimePrivileges, "reconcile privilege policy")
		}
	}
	return nil
}

func runtimeGrantStatements() []string {
	tables := qualifyRuntimeNames(runtimeManagedTables)
	statements := []string{
		"REVOKE ALL PRIVILEGES ON TABLE " + strings.Join(tables, ", ") + " FROM PUBLIC, " + CanonicalRuntimeRole,
		"REVOKE ALL PRIVILEGES ON SEQUENCE public.rgs_outbox_id_seq FROM PUBLIC, " + CanonicalRuntimeRole,
		"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC",
		"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC",
		"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM " + CanonicalRuntimeRole,
		"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM " + CanonicalRuntimeRole,
		"GRANT SELECT ON TABLE " + strings.Join(tables, ", ") + " TO " + CanonicalRuntimeRole,
	}
	for _, table := range sortedPolicyTables(runtimeInsertColumns) {
		statements = append(statements, fmt.Sprintf(
			"GRANT INSERT (%s) ON TABLE public.%s TO %s",
			strings.Join(runtimeInsertColumns[table], ", "), table, CanonicalRuntimeRole,
		))
	}
	for _, table := range sortedPolicyTables(runtimeUpdateColumns) {
		statements = append(statements, fmt.Sprintf(
			"GRANT UPDATE (%s) ON TABLE public.%s TO %s",
			strings.Join(runtimeUpdateColumns[table], ", "), table, CanonicalRuntimeRole,
		))
	}
	statements = append(statements,
		"GRANT DELETE ON TABLE "+strings.Join(qualifyRuntimeNames(runtimeDeleteTables), ", ")+" TO "+CanonicalRuntimeRole,
		"GRANT USAGE ON SEQUENCE public.rgs_outbox_id_seq TO "+CanonicalRuntimeRole,
	)
	return statements
}

func sortedPolicyTables(policy map[string][]string) []string {
	tables := make([]string, 0, len(policy))
	for table := range policy {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	return tables
}

func qualifyRuntimeNames(names []string) []string {
	qualified := make([]string, len(names))
	for index, name := range names {
		qualified[index] = "public." + name
	}
	return qualified
}

func buildRuntimePrivilegeCheckSQL() string {
	allowedColumns := make([]string, 0)
	for _, table := range sortedPolicyTables(runtimeInsertColumns) {
		for _, column := range runtimeInsertColumns[table] {
			allowedColumns = append(allowedColumns, fmt.Sprintf("('%s','%s','INSERT')", table, column))
		}
	}
	for _, table := range sortedPolicyTables(runtimeUpdateColumns) {
		for _, column := range runtimeUpdateColumns[table] {
			allowedColumns = append(allowedColumns, fmt.Sprintf("('%s','%s','UPDATE')", table, column))
		}
	}
	quotedTables := make([]string, len(runtimeManagedTables))
	for index, table := range runtimeManagedTables {
		quotedTables[index] = "'" + table + "'"
	}
	deleteTables := make([]string, len(runtimeDeleteTables))
	for index, table := range runtimeDeleteTables {
		deleteTables[index] = "'" + table + "'"
	}
	return fmt.Sprintf(`
WITH requested_role AS (
    SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole,
           rolinherit, rolreplication, rolbypassrls
    FROM pg_roles
    WHERE rolname = $1
), managed_tables AS (
    SELECT c.oid, c.relname, c.relowner
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname = ANY (ARRAY[%s]::text[])
), allowed_columns(table_name, column_name, privilege) AS (
    VALUES %s
)
SELECT COALESCE((
    SELECT
        role.rolname = 'rgs_runtime'
        AND (NOT $2::boolean OR current_user = role.rolname)
        AND NOT role.rolsuper
        AND NOT role.rolcreatedb
        AND NOT role.rolcreaterole
        AND NOT role.rolinherit
        AND NOT role.rolreplication
        AND NOT role.rolbypassrls
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid)
        AND has_database_privilege(role.rolname, current_database(), 'CONNECT')
        AND NOT has_database_privilege(role.rolname, current_database(), 'CREATE')
        AND NOT has_database_privilege(role.rolname, current_database(), 'TEMPORARY')
        AND has_schema_privilege(role.rolname, 'public', 'USAGE')
        AND NOT has_schema_privilege(role.rolname, 'public', 'CREATE')
        AND (SELECT count(*) FROM managed_tables) = %d
        AND NOT EXISTS (
            SELECT 1
            FROM managed_tables AS managed
            WHERE pg_has_role(role.rolname, managed.relowner, 'MEMBER')
               OR NOT has_table_privilege(role.rolname, managed.oid, 'SELECT')
               OR has_table_privilege(role.rolname, managed.oid, 'INSERT')
               OR has_table_privilege(role.rolname, managed.oid, 'UPDATE')
               OR has_table_privilege(role.rolname, managed.oid, 'TRUNCATE')
               OR has_table_privilege(role.rolname, managed.oid, 'REFERENCES')
               OR has_table_privilege(role.rolname, managed.oid, 'TRIGGER')
               OR has_table_privilege(role.rolname, managed.oid, 'MAINTAIN')
               OR (has_table_privilege(role.rolname, managed.oid, 'DELETE')
                    IS DISTINCT FROM (managed.relname = ANY (ARRAY[%s]::text[])))
        )
        AND NOT EXISTS (
            SELECT 1
            FROM managed_tables AS managed
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = managed.oid
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
            CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) AS checked(privilege)
            LEFT JOIN allowed_columns AS allowed
              ON allowed.table_name = managed.relname
             AND allowed.column_name = attribute.attname
             AND allowed.privilege = checked.privilege
            WHERE has_column_privilege(
                    role.rolname, managed.oid, attribute.attnum, checked.privilege
                  ) IS DISTINCT FROM (allowed.column_name IS NOT NULL)
        )
        AND EXISTS (
            SELECT 1
            FROM pg_class AS sequence
            JOIN pg_namespace AS n ON n.oid = sequence.relnamespace
            WHERE n.nspname = 'public'
              AND sequence.relname = 'rgs_outbox_id_seq'
              AND sequence.relkind = 'S'
              AND NOT pg_has_role(role.rolname, sequence.relowner, 'MEMBER')
              AND has_sequence_privilege(role.rolname, sequence.oid, 'USAGE')
              AND NOT has_sequence_privilege(role.rolname, sequence.oid, 'SELECT')
              AND NOT has_sequence_privilege(role.rolname, sequence.oid, 'UPDATE')
        )
    FROM requested_role AS role
), false) AS policy_ok`,
		strings.Join(quotedTables, ", "), strings.Join(allowedColumns, ",\n        "),
		len(runtimeManagedTables), strings.Join(deleteTables, ", "),
	)
}
