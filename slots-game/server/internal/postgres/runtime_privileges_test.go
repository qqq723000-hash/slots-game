package postgres

import (
	"context"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestRuntimeWritePolicyMatchesRepositorySQL(t *testing.T) {
	wantInsert := map[string][]string{
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
			"resulting_revision", "sequence", "result_json", "outcome_hash", "wallet_phase",
			"wallet_command_digest", "wallet_profile", "next_attempt_at", "created_at", "updated_at",
		},
		"rgs_wallet_transactions": {
			"operator_id", "transaction_id", "session_id", "round_id", "kind", "status", "currency",
			"amount_minor", "request_fingerprint", "created_at", "updated_at",
		},
		"rgs_outbox":                    {"operator_id", "aggregate_type", "aggregate_id", "event_type", "payload"},
		"rgs_operator_nonces":           {"operator_id", "key_id", "nonce_hash", "expires_at", "created_at"},
		"rgs_launch_codes":              {"code_hash", "operator_id", "claims_json", "expires_at", "created_at"},
		"rgs_wallet_recovery_operators": {"operator_id"},
	}
	wantUpdate := map[string][]string{
		"rgs_sessions": {
			"status", "balance_snapshot_minor", "sequence", "revision", "feature_state",
			"pending_round_id", "updated_at", "integrity_quarantined_at",
		},
		"rgs_rounds": {
			"status", "result_json", "wallet_transaction_id", "wallet_balance_minor", "wallet_lease_until",
			"wallet_phase", "next_attempt_at", "apply_attempts", "lookup_attempts",
			"failure_code", "retry_count", "updated_at", "committed_at", "integrity_quarantined_at",
			"result_delivery_required", "result_hash", "result_acknowledged_at",
		},
		"rgs_wallet_transactions": {"status", "operator_reference", "response_json", "failure_code", "updated_at"},
		"rgs_outbox": {
			"available_at", "lease_owner", "lease_token", "lease_until", "published_at", "attempts", "last_error",
		},
		"rgs_operator_nonces":           {"expires_at", "created_at"},
		"rgs_launch_codes":              {"consumed_at"},
		"rgs_wallet_recovery_operators": {"last_claimed_at"},
	}
	if !reflect.DeepEqual(runtimeInsertColumns, wantInsert) {
		t.Fatalf("runtimeInsertColumns = %#v", runtimeInsertColumns)
	}
	if !reflect.DeepEqual(runtimeUpdateColumns, wantUpdate) {
		t.Fatalf("runtimeUpdateColumns = %#v", runtimeUpdateColumns)
	}
	if !reflect.DeepEqual(runtimeDeleteTables, []string{"rgs_launch_codes", "rgs_operator_nonces"}) {
		t.Fatalf("runtimeDeleteTables = %#v", runtimeDeleteTables)
	}

	joined := strings.Join(runtimeGrantStatements(), "\n")
	for _, forbidden := range []string{
		"GRANT ALL", "GRANT INSERT ON", "GRANT UPDATE ON",
		"GRANT DELETE ON TABLE public.rgs_sessions",
		"GRANT DELETE ON TABLE public.rgs_rounds",
		"GRANT DELETE ON TABLE public.rgs_wallet_transactions",
		"GRANT DELETE ON TABLE public.rgs_outbox",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("grant policy contains forbidden broad privilege %q:\n%s", forbidden, joined)
		}
	}
	for _, required := range []string{
		"NOT role.rolinherit",
		"NOT EXISTS (SELECT 1 FROM pg_auth_members",
		"has_table_privilege(role.rolname, managed.oid, 'MAINTAIN')",
		"has_column_privilege(",
		"has_sequence_privilege(role.rolname, sequence.oid, 'USAGE')",
	} {
		if !strings.Contains(runtimePrivilegeCheckSQL, required) {
			t.Fatalf("runtime privilege checker is missing %q", required)
		}
	}
}

func TestRuntimePrivilegeCheckFailsClosedWithoutLeakingDetails(t *testing.T) {
	for _, test := range []struct {
		name      string
		policyOK  bool
		wantError bool
	}{
		{name: "exact", policyOK: true},
		{name: "drift", policyOK: false, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			check, err := NewRuntimePrivilegeCheck(database)
			if err != nil {
				t.Fatal(err)
			}
			if check.Name() != "database_privileges" {
				t.Fatalf("Name() = %q", check.Name())
			}
			mock.ExpectQuery(regexp.QuoteMeta(runtimePrivilegeCheckSQL)).
				WillReturnRows(sqlmock.NewRows([]string{"policy_ok"}).AddRow(test.policyOK))
			err = check.Check(context.Background())
			if (err != nil) != test.wantError {
				t.Fatalf("Check() error = %v, wantError=%v", err, test.wantError)
			}
			if err != nil && strings.Contains(err.Error(), "rgs_runtime") {
				t.Fatalf("Check() leaked role details: %v", err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
