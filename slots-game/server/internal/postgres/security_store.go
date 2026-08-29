package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
)

const (
	// MaximumSecurityPurgeBatch 限制单次维护事务，避免清理长期持有大量行锁并与请求流量竞争。
	// English: MaximumSecurityPurgeBatch limits a single maintenance transaction to avoid cleaning long-held row locks
	// and competing with request traffic.
	MaximumSecurityPurgeBatch = 10_000
	nonceScopeParts           = 3
)

var securityIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// NonceStore 是签名运营商请求共享的 PostgreSQL 防重放存储。随机数只以 SHA-256 摘要持久化；
// INSERT 冲突转换允许过期摘要再次被消费，同时保证所有服务副本中只有一个成功者。
// English: NonceStore is a shared PostgreSQL anti-replay store for signature operator requests. The random number
// is only persisted as SHA-256 digest; INSERT conflict conversion allows the expired digest to be consumed again,
// while ensuring that there is only one success in all service replicas.
type NonceStore struct {
	db *sql.DB
}

func NewNonceStore(db *sql.DB) (*NonceStore, error) {
	if db == nil {
		return nil, errors.New("postgres nonce store: database is required")
	}
	return &NonceStore{db: db}, nil
}

func (s *NonceStore) Consume(ctx context.Context, scope, nonce string, expiresAt time.Time) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	operatorID, keyID, err := parseNonceScope(scope)
	if err != nil {
		return false, err
	}
	if !validSecurityNonce(nonce) || expiresAt.IsZero() {
		return false, errors.New("postgres nonce store: invalid nonce or expiry")
	}

	digest := sha256.Sum256([]byte(nonce))
	var consumed int
	err = s.db.QueryRowContext(
		ctx,
		nonceConsumeSQL,
		operatorID,
		keyID,
		hex.EncodeToString(digest[:]),
		expiresAt.UTC(),
	).Scan(&consumed)
	switch {
	case err == nil:
		if consumed != 1 {
			return false, errors.New("postgres nonce store: invalid consume result")
		}
		return true, nil
	case errors.Is(err, sql.ErrNoRows):
		// 以 PostgreSQL 时钟判断，请求携带的到期时间已过，或同一随机数摘要仍有未过期记录。
		// English: Judging from the PostgreSQL clock, the expiration time carried in the request has passed, or there are
		// still unexpired records for the same random number digest.
		return false, nil
	default:
		return false, fmt.Errorf("postgres nonce store: consume: %w", err)
	}
}

// PurgeExpired 每次最多删除 batchSize 条过期随机数。调用方应周期执行，并在返回数量等于
// batchSize 时继续分批处理；SKIP LOCKED 使多个维护工作器并发运行时仍保持安全。
// PostgreSQL 时钟会对调用方边界取上限，防止快时钟副本提前删除仍有效的重放墓碑。
// English: PurgeExpired deletes at most batchSize expired random numbers each time. The caller should execute
// periodically and continue batch processing when the returned quantity equals batchSize; SKIP LOCKED allows for
// safety when multiple maintenance workers run concurrently. The PostgreSQL clock caps the caller boundary to
// prevent fast-clock replicas from prematurely deleting still-valid replay tombstones.
func (s *NonceStore) PurgeExpired(ctx context.Context, before time.Time, batchSize int) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := validatePurge(before, batchSize); err != nil {
		return 0, err
	}
	result, err := s.db.ExecContext(ctx, noncePurgeSQL, before.UTC(), batchSize)
	if err != nil {
		return 0, fmt.Errorf("postgres nonce store: purge expired: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("postgres nonce store: purge count: %w", err)
	}
	if rows < 0 || rows > int64(batchSize) {
		return 0, errors.New("postgres nonce store: invalid purge count")
	}
	return rows, nil
}

// LaunchStore 持久化浏览器一次性启动凭据。公开输入只包含 SHA-256 摘要，明文启动码
// 禁止跨越该适配器边界。
// English: LaunchStore persists browser one-time launch credentials. The public input contains only the SHA-256
// digest and the clear text activation code is prohibited from crossing this adapter boundary.
type LaunchStore struct {
	db *sql.DB
}

func NewLaunchStore(db *sql.DB) (*LaunchStore, error) {
	if db == nil {
		return nil, errors.New("postgres launch store: database is required")
	}
	return &LaunchStore{db: db}, nil
}

func (s *LaunchStore) Create(
	ctx context.Context,
	request launch.CreateRequest,
) (launch.Record, error) {
	if err := ctx.Err(); err != nil {
		return launch.Record{}, err
	}
	if err := launch.ValidateCreateRequest(request); err != nil {
		return launch.Record{}, err
	}
	claimsJSON, err := json.Marshal(claimsDocumentFrom(request.Claims))
	if err != nil {
		return launch.Record{}, fmt.Errorf("postgres launch store: encode claims: %w", err)
	}

	requestedDigest := hex.EncodeToString(request.Digest[:])
	var (
		storedDigest     string
		storedOperatorID string
		storedClaimsJSON []byte
		createdAt        time.Time
		expiresAt        time.Time
	)
	err = s.db.QueryRowContext(
		ctx,
		launchCreateSQL,
		requestedDigest,
		request.Claims.OperatorID,
		claimsJSON,
		request.TTL.Microseconds(),
	).Scan(
		&storedDigest,
		&storedOperatorID,
		&storedClaimsJSON,
		&createdAt,
		&expiresAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return launch.Record{}, launch.ErrDigestExists
	}
	if err != nil {
		return launch.Record{}, fmt.Errorf("postgres launch store: create: %w", err)
	}

	document, err := decodeClaimsDocument(storedClaimsJSON)
	if err != nil {
		return launch.Record{}, fmt.Errorf("%w: persisted launch claims", launch.ErrStoreInvariant)
	}
	record := launch.Record{
		Digest:    request.Digest,
		Claims:    document.claims(),
		CreatedAt: createdAt.UTC(),
		ExpiresAt: expiresAt.UTC(),
	}
	if storedDigest != requestedDigest || storedOperatorID != request.Claims.OperatorID ||
		record.Claims != request.Claims || record.ExpiresAt.Sub(record.CreatedAt) != request.TTL {
		return launch.Record{}, launch.ErrStoreInvariant
	}
	if err := launch.ValidateRecord(record); err != nil {
		return launch.Record{}, fmt.Errorf(
			"%w: invalid persisted launch record", launch.ErrStoreInvariant,
		)
	}
	return record, nil
}

func (s *LaunchStore) Consume(ctx context.Context, request launch.ConsumeRequest) (launch.Record, error) {
	if err := ctx.Err(); err != nil {
		return launch.Record{}, err
	}
	if !securityIdentifierPattern.MatchString(request.Binding.OperatorID) ||
		!securityIdentifierPattern.MatchString(request.Binding.SessionID) {
		// 与其他不可消费凭据返回同一结果，避免向直接调用适配器的一方暴露租户及会话绑定判定接口。
		// Return the same result as every other non-consumable credential so direct adapter callers cannot probe tenant or session binding decisions.
		return launch.Record{}, launch.ErrCodeUnavailable
	}

	var (
		storedOperatorID string
		claimsJSON       []byte
		createdAt        time.Time
		expiresAt        time.Time
	)
	err := s.db.QueryRowContext(
		ctx,
		launchConsumeSQL,
		hex.EncodeToString(request.Digest[:]),
		request.Binding.OperatorID,
		request.Binding.SessionID,
	).Scan(&storedOperatorID, &claimsJSON, &createdAt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		// 未知、过期、已消费、租户不匹配和会话不匹配的凭据刻意返回不可区分的结果。
		// Unknown, expired, consumed, tenant-mismatched, and session-mismatched credentials deliberately return indistinguishable results.
		return launch.Record{}, launch.ErrCodeUnavailable
	}
	if err != nil {
		return launch.Record{}, fmt.Errorf("postgres launch store: consume: %w", err)
	}

	document, err := decodeClaimsDocument(claimsJSON)
	if err != nil {
		return launch.Record{}, fmt.Errorf("%w: persisted launch claims", launch.ErrStoreInvariant)
	}
	record := launch.Record{
		Digest:    request.Digest,
		Claims:    document.claims(),
		CreatedAt: createdAt.UTC(),
		ExpiresAt: expiresAt.UTC(),
	}
	if storedOperatorID != request.Binding.OperatorID ||
		record.Claims.OperatorID != request.Binding.OperatorID ||
		record.Claims.SessionID != request.Binding.SessionID {
		return launch.Record{}, launch.ErrStoreInvariant
	}
	if err := launch.ValidateRecord(record); err != nil {
		return launch.Record{}, fmt.Errorf("%w: invalid persisted launch record", launch.ErrStoreInvariant)
	}
	return record, nil
}

// PurgeExpired 每次最多删除 batchSize 条已超过兑换窗口且又经过
// launch.IdempotencyRetention 的启动记录。在此之前每一行（包括已消费记录）都是幂等墓碑，
// 防止确定性启动凭据重新变成可消费状态。PostgreSQL 时钟会对调用方边界取上限，避免
// 快时钟副本缩短幂等保留期。
// English: PurgeExpired can delete at most batchSize startup records each time that have exceeded the redemption
// window and have passed launch.IdempotencyRetention. Every row before this (including consumed records) is an
// idempotent tombstone, preventing the deterministic startup credentials from becoming consumable again. The
// PostgreSQL clock caps the caller boundary to prevent fast-clock replicas from shortening the idempotent
// retention period.
func (s *LaunchStore) PurgeExpired(ctx context.Context, before time.Time, batchSize int) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := validatePurge(before, batchSize); err != nil {
		return 0, err
	}
	retentionMicroseconds := launch.IdempotencyRetention.Microseconds()
	result, err := s.db.ExecContext(ctx, launchPurgeSQL, before.UTC(), retentionMicroseconds, batchSize)
	if err != nil {
		return 0, fmt.Errorf("postgres launch store: purge expired: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("postgres launch store: purge count: %w", err)
	}
	if rows < 0 || rows > int64(batchSize) {
		return 0, errors.New("postgres launch store: invalid purge count")
	}
	return rows, nil
}

type launchClaimsDocument struct {
	OperatorID            string `json:"operatorId"`
	SessionID             string `json:"sessionId"`
	PlayerID              string `json:"playerId"`
	WalletSessionID       string `json:"walletSessionId"`
	GameID                string `json:"gameId"`
	DefinitionVersion     string `json:"definitionVersion"`
	DefinitionHash        string `json:"definitionHash"`
	RequestFingerprint    string `json:"requestFingerprint"`
	Currency              string `json:"currency"`
	CurrencyExponent      int    `json:"currencyExponent"`
	Jurisdiction          string `json:"jurisdiction"`
	IdleDisconnectSeconds int64  `json:"idleDisconnectSeconds"`
}

func claimsDocumentFrom(claims launch.Claims) launchClaimsDocument {
	return launchClaimsDocument{
		OperatorID: claims.OperatorID, SessionID: claims.SessionID,
		PlayerID: claims.PlayerID, WalletSessionID: claims.WalletSessionID,
		GameID: claims.GameID, DefinitionVersion: claims.DefinitionVersion,
		DefinitionHash:     claims.DefinitionHash,
		RequestFingerprint: claims.RequestFingerprint, Currency: claims.Currency,
		CurrencyExponent: claims.CurrencyExponent, Jurisdiction: claims.Jurisdiction,
		IdleDisconnectSeconds: claims.IdleDisconnectSeconds,
	}
}

func (document launchClaimsDocument) claims() launch.Claims {
	return launch.Claims{
		OperatorID: document.OperatorID, SessionID: document.SessionID,
		PlayerID: document.PlayerID, WalletSessionID: document.WalletSessionID,
		GameID: document.GameID, DefinitionVersion: document.DefinitionVersion,
		DefinitionHash:     document.DefinitionHash,
		RequestFingerprint: document.RequestFingerprint, Currency: document.Currency,
		CurrencyExponent: document.CurrencyExponent, Jurisdiction: document.Jurisdiction,
		IdleDisconnectSeconds: document.IdleDisconnectSeconds,
	}
}

func (s *LaunchStore) Get(
	ctx context.Context,
	digest launch.CodeDigest,
) (launch.ReplayObservation, error) {
	if err := ctx.Err(); err != nil {
		return launch.ReplayObservation{}, err
	}
	var (
		storedDigest     string
		storedOperatorID string
		claimsJSON       []byte
		createdAt        time.Time
		expiresAt        time.Time
		observedAt       time.Time
	)
	err := s.db.QueryRowContext(
		ctx, launchGetSQL, hex.EncodeToString(digest[:]),
	).Scan(
		&storedDigest, &storedOperatorID, &claimsJSON, &createdAt, &expiresAt, &observedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return launch.ReplayObservation{}, launch.ErrCodeUnavailable
	}
	if err != nil {
		return launch.ReplayObservation{}, fmt.Errorf("postgres launch store: get: %w", err)
	}
	decodedDigest, err := hex.DecodeString(storedDigest)
	if err != nil || len(decodedDigest) != sha256.Size {
		return launch.ReplayObservation{}, launch.ErrStoreInvariant
	}
	var persisted launch.CodeDigest
	copy(persisted[:], decodedDigest)
	document, err := decodeClaimsDocument(claimsJSON)
	if err != nil {
		return launch.ReplayObservation{}, launch.ErrStoreInvariant
	}
	record := launch.Record{
		Digest: persisted, Claims: document.claims(),
		CreatedAt: createdAt.UTC(), ExpiresAt: expiresAt.UTC(),
	}
	observedAt = observedAt.UTC()
	if observedAt.IsZero() || persisted != digest || record.Claims.OperatorID != storedOperatorID ||
		launch.ValidateRecord(record) != nil {
		return launch.ReplayObservation{}, launch.ErrStoreInvariant
	}
	return launch.ReplayObservation{Record: record, ObservedAt: observedAt}, nil
}

func decodeClaimsDocument(encoded []byte) (launchClaimsDocument, error) {
	shape := json.NewDecoder(bytes.NewReader(encoded))
	first, err := shape.Token()
	if err != nil || first != json.Delim('{') {
		return launchClaimsDocument{}, errors.New("launch claims must be an object")
	}
	seen := make(map[string]struct{})
	for shape.More() {
		keyToken, err := shape.Token()
		if err != nil {
			return launchClaimsDocument{}, errors.New("invalid launch claims object")
		}
		key, ok := keyToken.(string)
		if !ok {
			return launchClaimsDocument{}, errors.New("invalid launch claims key")
		}
		if _, duplicate := seen[key]; duplicate {
			return launchClaimsDocument{}, errors.New("duplicate launch claims field")
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := shape.Decode(&value); err != nil {
			return launchClaimsDocument{}, errors.New("invalid launch claims value")
		}
	}
	if closing, err := shape.Token(); err != nil || closing != json.Delim('}') {
		return launchClaimsDocument{}, errors.New("invalid launch claims object")
	}
	if _, err := shape.Token(); !errors.Is(err, io.EOF) {
		return launchClaimsDocument{}, errors.New("trailing launch claims JSON")
	}

	var document launchClaimsDocument
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return launchClaimsDocument{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return launchClaimsDocument{}, errors.New("trailing launch claims JSON")
	}
	return document, nil
}

func parseNonceScope(scope string) (string, string, error) {
	parts := strings.Split(scope, "\x00")
	if len(parts) != nonceScopeParts || parts[0] != string(operator.KeyPurposeHTTPRequest) ||
		!securityIdentifierPattern.MatchString(parts[1]) ||
		!securityIdentifierPattern.MatchString(parts[2]) {
		return "", "", errors.New("postgres nonce store: invalid verified-key scope")
	}
	return parts[1], parts[2], nil
}

func validSecurityNonce(nonce string) bool {
	if nonce == "" || strings.Contains(nonce, "=") || strings.ContainsRune(nonce, '\x00') {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(nonce)
	if err != nil || len(decoded) < 16 || len(decoded) > 64 {
		return false
	}
	return base64.RawURLEncoding.EncodeToString(decoded) == nonce
}

func validatePurge(before time.Time, batchSize int) error {
	if before.IsZero() || batchSize < 1 || batchSize > MaximumSecurityPurgeBatch {
		return errors.New("postgres security store: invalid purge boundary or batch size")
	}
	return nil
}

const nonceConsumeSQL = `
	INSERT INTO rgs_operator_nonces (
		operator_id, key_id, nonce_hash, expires_at, created_at
	)
	SELECT $1, $2, $3, $4, CURRENT_TIMESTAMP
	WHERE $4 > CURRENT_TIMESTAMP
	ON CONFLICT (operator_id, key_id, nonce_hash) DO UPDATE
	SET expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP
	WHERE rgs_operator_nonces.expires_at <= CURRENT_TIMESTAMP
	RETURNING 1`

const noncePurgeSQL = `
	WITH expired AS (
		SELECT operator_id, key_id, nonce_hash
		FROM rgs_operator_nonces
		WHERE expires_at <= LEAST($1, CURRENT_TIMESTAMP)
		ORDER BY expires_at
		LIMIT $2
		FOR UPDATE SKIP LOCKED
	)
	DELETE FROM rgs_operator_nonces AS stored
	USING expired
	WHERE stored.operator_id = expired.operator_id
		AND stored.key_id = expired.key_id
		AND stored.nonce_hash = expired.nonce_hash`

const launchCreateSQL = `
	WITH digest_lock AS MATERIALIZED (
		SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
	),
	authority_time AS MATERIALIZED (
		SELECT clock_timestamp() AS created_at
		FROM digest_lock
	)
	INSERT INTO rgs_launch_codes (
		code_hash, operator_id, claims_json, expires_at, created_at
	)
	SELECT
		$1, $2, $3,
		authority_time.created_at + ($4::bigint * INTERVAL '1 microsecond'),
		authority_time.created_at
	FROM authority_time
	ON CONFLICT (code_hash) DO NOTHING
	RETURNING code_hash, operator_id, claims_json, created_at, expires_at`

const launchConsumeSQL = `
	UPDATE rgs_launch_codes
	SET consumed_at = CURRENT_TIMESTAMP
	WHERE code_hash = $1
		AND operator_id = $2
		AND claims_json->>'operatorId' = $2
		AND claims_json->>'sessionId' = $3
		AND consumed_at IS NULL
		AND expires_at > CURRENT_TIMESTAMP
	RETURNING operator_id, claims_json, created_at, expires_at`

const launchGetSQL = `
	SELECT code_hash, operator_id, claims_json, created_at, expires_at, CURRENT_TIMESTAMP
	FROM rgs_launch_codes
	WHERE code_hash = $1`

const launchPurgeSQL = `
	WITH expired AS (
		SELECT code_hash
		FROM rgs_launch_codes
		WHERE expires_at <= LEAST($1, CURRENT_TIMESTAMP) - ($2::bigint * INTERVAL '1 microsecond')
		ORDER BY expires_at
		LIMIT $3
		FOR UPDATE SKIP LOCKED
	)
	DELETE FROM rgs_launch_codes AS stored
	USING expired
	WHERE stored.code_hash = expired.code_hash`

var (
	_ operator.NonceStore = (*NonceStore)(nil)
	_ launch.Store        = (*LaunchStore)(nil)
	_ launch.ReplayStore  = (*LaunchStore)(nil)
)
