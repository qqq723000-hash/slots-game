package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var localOperatorMigrations embed.FS

const localOperatorMigrationLock int64 = 6_804_151_912_426

type postgresStore struct {
	database *sql.DB
}

func newPostgresStore(database *sql.DB) (*postgresStore, error) {
	if database == nil {
		return nil, errors.New("local operator store: database is required")
	}
	return &postgresStore{database: database}, nil
}

func migrateLocalOperator(ctx context.Context, database *sql.DB, ownerRole, runtimeRole string) error {
	if database == nil {
		return errors.New("local operator migration: database is required")
	}
	if !databaseRolePattern.MatchString(ownerRole) || !databaseRolePattern.MatchString(runtimeRole) ||
		ownerRole == runtimeRole {
		return errors.New("local operator migration: invalid or non-distinct database roles")
	}
	if err := verifyOwnerDatabaseRole(ctx, database, ownerRole); err != nil {
		return err
	}
	entries, err := fs.ReadDir(localOperatorMigrations, "migrations")
	if err != nil {
		return fmt.Errorf("read local operator migrations: %w", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	tx, err := database.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin local operator migration: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, localOperatorMigrationLock); err != nil {
		return fmt.Errorf("lock local operator migration: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS local_operator_schema_migrations (
			version text PRIMARY KEY,
			checksum char(64) NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`); err != nil {
		return fmt.Errorf("create local operator migration ledger: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		contents, err := localOperatorMigrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		digest := sha256.Sum256(contents)
		checksum := hex.EncodeToString(digest[:])
		var existing string
		err = tx.QueryRowContext(ctx,
			`SELECT checksum FROM local_operator_schema_migrations WHERE version=$1`, entry.Name(),
		).Scan(&existing)
		switch {
		case err == nil && existing != checksum:
			return fmt.Errorf("local operator migration %s checksum changed", entry.Name())
		case err == nil:
			continue
		case !errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("read migration ledger: %w", err)
		}
		if _, err := tx.ExecContext(ctx, string(contents)); err != nil {
			return fmt.Errorf("apply migration %s: %w", entry.Name(), err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO local_operator_schema_migrations (version, checksum) VALUES ($1,$2)`,
			entry.Name(), checksum,
		); err != nil {
			return fmt.Errorf("record migration %s: %w", entry.Name(), err)
		}
	}
	quotedRole := `"` + runtimeRole + `"`
	if _, err := tx.ExecContext(ctx, `
		REVOKE ALL ON TABLE local_operator_accounts,
			local_operator_wallet_operations, local_operator_wallet_rollbacks,
			local_operator_nonces FROM PUBLIC;
		REVOKE ALL ON TABLE local_operator_accounts,
			local_operator_wallet_operations, local_operator_wallet_rollbacks,
			local_operator_nonces FROM `+quotedRole+`;
		GRANT USAGE ON SCHEMA public TO `+quotedRole+`;
		GRANT SELECT ON TABLE local_operator_accounts,
			local_operator_wallet_operations, local_operator_wallet_rollbacks,
			local_operator_nonces TO `+quotedRole+`;
		GRANT INSERT (operator_id, wallet_account_id, currency, balance_minor)
			ON local_operator_accounts TO `+quotedRole+`;
		GRANT UPDATE (balance_minor, updated_at)
			ON local_operator_accounts TO `+quotedRole+`;
		GRANT INSERT (
			operator_id, operation_id, request_digest, fingerprint, player_id,
			wallet_account_id, rgs_session_id, round_id, game_id, definition_version,
			definition_hash, round_kind, currency, debit_minor, credit_minor,
			balance_minor, transaction_id
		) ON local_operator_wallet_operations TO `+quotedRole+`;
		GRANT UPDATE (rolled_back, updated_at)
			ON local_operator_wallet_operations TO `+quotedRole+`;
		GRANT INSERT (
			operator_id, rollback_id, operation_id, request_digest, reason,
			transaction_id, balance_minor
		) ON local_operator_wallet_rollbacks TO `+quotedRole+`;
		GRANT INSERT (operator_id, key_id, nonce_hash, expires_at)
			ON local_operator_nonces TO `+quotedRole+`;
		GRANT UPDATE (expires_at, created_at)
			ON local_operator_nonces TO `+quotedRole); err != nil {
		return fmt.Errorf("reconcile local operator runtime grants: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit local operator migrations: %w", err)
	}
	return nil
}

func verifyOwnerDatabaseRole(ctx context.Context, database *sql.DB, expectedRole string) error {
	if database == nil || !databaseRolePattern.MatchString(expectedRole) {
		return errors.New("invalid owner database role check")
	}
	var secure bool
	if err := database.QueryRowContext(ctx, `
		SELECT COALESCE((
			SELECT rolname=$1 AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
			   AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
			   AND NOT has_database_privilege(rolname, current_database(), 'TEMPORARY')
			   AND has_schema_privilege(rolname, 'public', 'USAGE')
			   AND has_schema_privilege(rolname, 'public', 'CREATE')
			   AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid)
			FROM pg_roles WHERE rolname=current_user
		), false)`, expectedRole).Scan(&secure); err != nil {
		return fmt.Errorf("verify owner database role: %w", err)
	}
	if !secure {
		return errors.New("owner database role violates migration policy")
	}
	return nil
}

func verifyRuntimeDatabaseRole(ctx context.Context, database *sql.DB, expectedRole string) error {
	if database == nil || !databaseRolePattern.MatchString(expectedRole) {
		return errors.New("invalid runtime database role check")
	}
	var secure bool
	if err := database.QueryRowContext(ctx, `
		SELECT COALESCE((
			SELECT rolname=$1 AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
			   AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
			   AND NOT has_database_privilege(rolname, current_database(), 'TEMPORARY')
			   AND NOT has_schema_privilege(rolname, 'public', 'CREATE')
			   AND has_schema_privilege(rolname, 'public', 'USAGE')
			   AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid)
			   AND has_table_privilege(rolname, 'local_operator_accounts', 'SELECT')
			   AND has_table_privilege(rolname, 'local_operator_wallet_operations', 'SELECT')
			   AND has_table_privilege(rolname, 'local_operator_wallet_rollbacks', 'SELECT')
			   AND has_table_privilege(rolname, 'local_operator_nonces', 'SELECT')
			   AND has_column_privilege(rolname, 'local_operator_accounts', 'balance_minor', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_accounts', 'created_at', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_accounts', 'updated_at', 'INSERT')
			   AND has_column_privilege(rolname, 'local_operator_accounts', 'balance_minor', 'UPDATE')
			   AND NOT has_column_privilege(rolname, 'local_operator_accounts', 'operator_id', 'UPDATE')
			   AND has_column_privilege(rolname, 'local_operator_wallet_operations', 'operation_id', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_wallet_operations', 'rolled_back', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_wallet_operations', 'created_at', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_wallet_operations', 'updated_at', 'INSERT')
			   AND has_column_privilege(rolname, 'local_operator_wallet_operations', 'rolled_back', 'UPDATE')
			   AND NOT has_column_privilege(rolname, 'local_operator_wallet_operations', 'operation_id', 'UPDATE')
			   AND has_column_privilege(rolname, 'local_operator_wallet_rollbacks', 'rollback_id', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_wallet_rollbacks', 'created_at', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_wallet_rollbacks', 'rollback_id', 'UPDATE')
			   AND has_column_privilege(rolname, 'local_operator_nonces', 'nonce_hash', 'INSERT')
			   AND NOT has_column_privilege(rolname, 'local_operator_nonces', 'created_at', 'INSERT')
			   AND has_column_privilege(rolname, 'local_operator_nonces', 'expires_at', 'UPDATE')
			   AND NOT has_column_privilege(rolname, 'local_operator_nonces', 'nonce_hash', 'UPDATE')
			   AND NOT has_table_privilege(rolname, 'local_operator_accounts', 'DELETE')
			   AND NOT has_table_privilege(rolname, 'local_operator_accounts', 'TRUNCATE')
			   AND NOT has_table_privilege(rolname, 'local_operator_accounts', 'REFERENCES')
			   AND NOT has_table_privilege(rolname, 'local_operator_accounts', 'TRIGGER')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_operations', 'DELETE')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_operations', 'TRUNCATE')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_operations', 'REFERENCES')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_operations', 'TRIGGER')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_rollbacks', 'DELETE')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_rollbacks', 'TRUNCATE')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_rollbacks', 'REFERENCES')
			   AND NOT has_table_privilege(rolname, 'local_operator_wallet_rollbacks', 'TRIGGER')
			   AND NOT has_table_privilege(rolname, 'local_operator_nonces', 'DELETE')
			   AND NOT has_table_privilege(rolname, 'local_operator_nonces', 'TRUNCATE')
			   AND NOT has_table_privilege(rolname, 'local_operator_nonces', 'REFERENCES')
			   AND NOT has_table_privilege(rolname, 'local_operator_nonces', 'TRIGGER')
			FROM pg_roles WHERE rolname=current_user
		), false)`, expectedRole).Scan(&secure); err != nil {
		return fmt.Errorf("verify runtime database role: %w", err)
	}
	if !secure {
		return errors.New("runtime database role violates least-privilege policy")
	}
	return nil
}

func (s *postgresStore) Ping(ctx context.Context) error {
	var ready bool
	if err := s.database.QueryRowContext(ctx, `
		SELECT to_regclass('local_operator_accounts') IS NOT NULL
		   AND to_regclass('local_operator_wallet_operations') IS NOT NULL
		   AND to_regclass('local_operator_wallet_rollbacks') IS NOT NULL
		   AND to_regclass('local_operator_nonces') IS NOT NULL`).Scan(&ready); err != nil {
		return err
	}
	if !ready {
		return errors.New("local operator wallet schema is missing")
	}
	return nil
}

func (s *postgresStore) EnsureAccount(ctx context.Context, seed accountSeed) error {
	if !allIdentifiers(seed.OperatorID, seed.WalletAccountID) ||
		!currencyPattern.MatchString(seed.Currency) || seed.BalanceMinor < 0 {
		return errors.New("local operator store: invalid account seed")
	}
	result, err := s.database.ExecContext(ctx, `
		INSERT INTO local_operator_accounts (
			operator_id, wallet_account_id, currency, balance_minor
		) VALUES ($1,$2,$3,$4)
		ON CONFLICT (operator_id, wallet_account_id, currency) DO NOTHING`,
		seed.OperatorID, seed.WalletAccountID, seed.Currency, seed.BalanceMinor,
	)
	if err != nil {
		return fmt.Errorf("ensure wallet account: %w", err)
	}
	if _, err := result.RowsAffected(); err != nil {
		return fmt.Errorf("ensure wallet account result: %w", err)
	}
	return nil
}

func (s *postgresStore) Apply(ctx context.Context, request validatedRound) (storedOperation, error) {
	tx, err := s.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return storedOperation{}, fmt.Errorf("begin wallet apply: %w", err)
	}
	defer tx.Rollback()
	existing, found, err := loadOperation(ctx, tx, request.OperatorID, request.OperationID, false)
	if err != nil {
		return storedOperation{}, err
	}
	if found {
		if existing.RequestDigest != request.RequestDigest || existing.RolledBack {
			return storedOperation{}, errIdempotencyConflict
		}
		return existing, nil
	}
	var balance int64
	if err := tx.QueryRowContext(ctx, `
		SELECT balance_minor FROM local_operator_accounts
		WHERE operator_id=$1 AND wallet_account_id=$2 AND currency=$3
		FOR UPDATE`, request.OperatorID, request.WalletAccountID, request.Currency).Scan(&balance); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storedOperation{}, errAccountNotFound
		}
		return storedOperation{}, fmt.Errorf("lock wallet account: %w", err)
	}
	updatedBalance, err := checkedBalance(balance, request.Debit, request.Credit)
	if err != nil {
		return storedOperation{}, err
	}
	transactionID := deterministicTransactionID("wtx", request.OperationID)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO local_operator_wallet_operations (
			operator_id, operation_id, request_digest, fingerprint, player_id,
			wallet_account_id, rgs_session_id, round_id, game_id, definition_version,
			definition_hash, round_kind, currency, debit_minor, credit_minor,
			balance_minor, transaction_id
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		ON CONFLICT (operator_id, operation_id) DO NOTHING`,
		request.OperatorID, request.OperationID, request.RequestDigest, request.Fingerprint,
		request.PlayerID, request.WalletAccountID, request.SessionID, request.RoundID,
		request.GameID, request.DefinitionVersion, request.DefinitionHash, request.RoundKind,
		request.Currency, request.Debit, request.Credit, updatedBalance, transactionID,
	)
	if err != nil {
		return storedOperation{}, fmt.Errorf("insert wallet operation: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return storedOperation{}, fmt.Errorf("inspect wallet operation insert: %w", err)
	}
	if inserted != 1 {
		_ = tx.Rollback()
		existing, found, loadErr := loadOperation(ctx, s.database, request.OperatorID, request.OperationID, false)
		if loadErr != nil {
			return storedOperation{}, loadErr
		}
		if !found || existing.RequestDigest != request.RequestDigest || existing.RolledBack {
			return storedOperation{}, errIdempotencyConflict
		}
		return existing, nil
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE local_operator_accounts SET balance_minor=$4, updated_at=CURRENT_TIMESTAMP
		WHERE operator_id=$1 AND wallet_account_id=$2 AND currency=$3`,
		request.OperatorID, request.WalletAccountID, request.Currency, updatedBalance,
	); err != nil {
		return storedOperation{}, fmt.Errorf("update wallet balance: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return storedOperation{}, fmt.Errorf("commit wallet apply: %w", err)
	}
	return newStoredOperation(request, transactionID, updatedBalance), nil
}

func (s *postgresStore) Lookup(
	ctx context.Context,
	operatorID, operationID string,
) (storedOperation, bool, error) {
	return loadOperation(ctx, s.database, operatorID, operationID, false)
}

func (s *postgresStore) Rollback(ctx context.Context, request validatedRollback) (storedOperation, error) {
	tx, err := s.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return storedOperation{}, fmt.Errorf("begin wallet rollback: %w", err)
	}
	defer tx.Rollback()
	if replay, found, err := loadRollback(ctx, tx, request.OperatorID, request.RollbackID); err != nil {
		return storedOperation{}, err
	} else if found {
		if replay.RequestDigest != request.RequestDigest || replay.OperationID != request.OperationID {
			return storedOperation{}, errIdempotencyConflict
		}
		return replay, nil
	}
	operation, found, err := loadOperation(ctx, tx, request.OperatorID, request.OperationID, true)
	if err != nil {
		return storedOperation{}, err
	}
	if !found {
		return storedOperation{}, errOperationNotFound
	}
	if operation.RolledBack {
		// 另一副本可能在本事务等待 operation 行锁期间完成了同一个 rollback；
		// 锁释放后重新按 rollback ID 查询，精确重放仍必须返回原始回执。
		replay, replayFound, replayErr := loadRollback(ctx, tx, request.OperatorID, request.RollbackID)
		if replayErr != nil {
			return storedOperation{}, replayErr
		}
		if replayFound && replay.RequestDigest == request.RequestDigest && replay.OperationID == request.OperationID {
			return replay, nil
		}
		return storedOperation{}, errAlreadyRolledBack
	}
	var balance int64
	if err := tx.QueryRowContext(ctx, `
		SELECT balance_minor FROM local_operator_accounts
		WHERE operator_id=$1 AND wallet_account_id=$2 AND currency=$3 FOR UPDATE`,
		operation.OperatorID, operation.WalletAccountID, operation.Currency,
	).Scan(&balance); err != nil {
		return storedOperation{}, fmt.Errorf("lock rollback wallet account: %w", err)
	}
	// 回滚按当前余额反向应用原操作，不能恢复历史快照，否则会覆盖其后的合法轮次。
	updatedBalance, err := checkedBalance(balance, operation.CreditMinor, operation.DebitMinor)
	if err != nil {
		return storedOperation{}, fmt.Errorf("reverse wallet operation: %w", err)
	}
	transactionID := deterministicTransactionID("wrb", request.RollbackID)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO local_operator_wallet_rollbacks (
			operator_id, rollback_id, operation_id, request_digest, reason,
			transaction_id, balance_minor
		) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		request.OperatorID, request.RollbackID, request.OperationID, request.RequestDigest,
		request.Reason, transactionID, updatedBalance,
	); err != nil {
		return storedOperation{}, fmt.Errorf("insert wallet rollback: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE local_operator_accounts SET balance_minor=$4, updated_at=CURRENT_TIMESTAMP
		WHERE operator_id=$1 AND wallet_account_id=$2 AND currency=$3`,
		operation.OperatorID, operation.WalletAccountID, operation.Currency, updatedBalance,
	); err != nil {
		return storedOperation{}, fmt.Errorf("update rollback balance: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE local_operator_wallet_operations
		SET rolled_back=true, updated_at=CURRENT_TIMESTAMP
		WHERE operator_id=$1 AND operation_id=$2`, request.OperatorID, request.OperationID,
	); err != nil {
		return storedOperation{}, fmt.Errorf("mark wallet operation rolled back: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return storedOperation{}, fmt.Errorf("commit wallet rollback: %w", err)
	}
	operation.RolledBack = true
	operation.TransactionID = transactionID
	operation.BalanceMinor = updatedBalance
	operation.RequestDigest = request.RequestDigest
	return operation, nil
}

// Consume 让所有本机服务副本共享 nonce 防重放状态；数据库时间是唯一到期时钟。
func (s *postgresStore) Consume(
	ctx context.Context,
	scope, nonce string,
	expiresAt time.Time,
) (bool, error) {
	operatorID, keyID, err := parseNonceScope(scope)
	if err != nil || !validNonce(nonce) || expiresAt.IsZero() {
		return false, errors.New("local operator nonce: invalid input")
	}
	digest := sha256.Sum256([]byte(nonce))
	var consumed bool
	err = s.database.QueryRowContext(ctx, `
		WITH consumed AS (
			INSERT INTO local_operator_nonces (
				operator_id, key_id, nonce_hash, expires_at
			) VALUES ($1,$2,$3,$4)
			ON CONFLICT (operator_id, key_id, nonce_hash) DO UPDATE
			SET expires_at=EXCLUDED.expires_at, created_at=CURRENT_TIMESTAMP
			WHERE local_operator_nonces.expires_at <= CURRENT_TIMESTAMP
			RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM consumed)`,
		operatorID, keyID, hex.EncodeToString(digest[:]), expiresAt.UTC(),
	).Scan(&consumed)
	if err != nil {
		return false, fmt.Errorf("consume local operator nonce: %w", err)
	}
	return consumed, nil
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadOperation(
	ctx context.Context,
	query rowQuerier,
	operatorID, operationID string,
	forUpdate bool,
) (storedOperation, bool, error) {
	statement := `
		SELECT o.operation_id, o.fingerprint, o.operator_id, o.player_id,
			o.wallet_account_id, o.rgs_session_id, o.round_id, o.game_id,
			o.definition_version, o.definition_hash, o.round_kind, o.currency,
			o.debit_minor, o.credit_minor,
			CASE WHEN o.rolled_back THEN COALESCE(r.balance_minor, o.balance_minor) ELSE o.balance_minor END,
			CASE WHEN o.rolled_back THEN COALESCE(r.transaction_id, o.transaction_id) ELSE o.transaction_id END,
			o.request_digest, o.rolled_back
		FROM local_operator_wallet_operations o
		LEFT JOIN local_operator_wallet_rollbacks r
			ON r.operator_id=o.operator_id AND r.operation_id=o.operation_id
		WHERE o.operator_id=$1 AND o.operation_id=$2`
	if forUpdate {
		statement += ` FOR UPDATE OF o`
	}
	var operation storedOperation
	err := query.QueryRowContext(ctx, statement, operatorID, operationID).Scan(
		&operation.OperationID, &operation.Fingerprint, &operation.OperatorID,
		&operation.PlayerID, &operation.WalletAccountID, &operation.SessionID,
		&operation.RoundID, &operation.GameID, &operation.DefinitionVersion,
		&operation.DefinitionHash, &operation.RoundKind, &operation.Currency,
		&operation.DebitMinor, &operation.CreditMinor, &operation.BalanceMinor,
		&operation.TransactionID, &operation.RequestDigest, &operation.RolledBack,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return storedOperation{}, false, nil
	}
	if err != nil {
		return storedOperation{}, false, fmt.Errorf("load wallet operation: %w", err)
	}
	return operation, true, nil
}

func loadRollback(
	ctx context.Context,
	query rowQuerier,
	operatorID, rollbackID string,
) (storedOperation, bool, error) {
	var operation storedOperation
	err := query.QueryRowContext(ctx, `
		SELECT o.operation_id, o.fingerprint, o.operator_id, o.player_id,
			o.wallet_account_id, o.rgs_session_id, o.round_id, o.game_id,
			o.definition_version, o.definition_hash, o.round_kind, o.currency,
			o.debit_minor, o.credit_minor, r.balance_minor, r.transaction_id,
			r.request_digest, true
		FROM local_operator_wallet_rollbacks r
		JOIN local_operator_wallet_operations o
			ON o.operator_id=r.operator_id AND o.operation_id=r.operation_id
		WHERE r.operator_id=$1 AND r.rollback_id=$2`, operatorID, rollbackID,
	).Scan(
		&operation.OperationID, &operation.Fingerprint, &operation.OperatorID,
		&operation.PlayerID, &operation.WalletAccountID, &operation.SessionID,
		&operation.RoundID, &operation.GameID, &operation.DefinitionVersion,
		&operation.DefinitionHash, &operation.RoundKind, &operation.Currency,
		&operation.DebitMinor, &operation.CreditMinor, &operation.BalanceMinor,
		&operation.TransactionID, &operation.RequestDigest, &operation.RolledBack,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return storedOperation{}, false, nil
	}
	if err != nil {
		return storedOperation{}, false, fmt.Errorf("load wallet rollback: %w", err)
	}
	return operation, true, nil
}

func deterministicTransactionID(prefix, source string) string {
	digest := sha256.Sum256([]byte(prefix + "\x00" + source))
	return prefix + "_" + hex.EncodeToString(digest[:])
}

func parseNonceScope(scope string) (string, string, error) {
	parts := strings.Split(scope, "\x00")
	if len(parts) != 3 || parts[0] != "HTTP_REQUEST" || !allIdentifiers(parts[1], parts[2]) {
		return "", "", errors.New("invalid nonce scope")
	}
	return parts[1], parts[2], nil
}

func validNonce(nonce string) bool {
	if nonce == "" || strings.Contains(nonce, "=") || strings.ContainsRune(nonce, '\x00') {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(nonce)
	return err == nil && len(decoded) >= 16 && len(decoded) <= 64 &&
		base64.RawURLEncoding.EncodeToString(decoded) == nonce
}
