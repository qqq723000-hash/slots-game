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
	MaximumSecurityPurgeBatch = 10_000
	nonceScopeParts           = 3
)

var securityIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// NonceStore 是签名运营商请求共享的 PostgreSQL 防重放存储。随机数只以 SHA-256 摘要持久化；
// INSERT 冲突转换允许过期摘要再次被消费，同时保证所有服务副本中只有一个成功者。
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
		return false, nil
	default:
		return false, fmt.Errorf("postgres nonce store: consume: %w", err)
	}
}

// PurgeExpired 每次最多删除 batchSize 条过期随机数。调用方应周期执行，并在返回数量等于
// batchSize 时继续分批处理；SKIP LOCKED 使多个维护工作器并发运行时仍保持安全。
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
type LaunchStore struct {
	db *sql.DB
}

func NewLaunchStore(db *sql.DB) (*LaunchStore, error) {
	if db == nil {
		return nil, errors.New("postgres launch store: database is required")
	}
	return &LaunchStore{db: db}, nil
}

func (s *LaunchStore) Create(ctx context.Context, record launch.Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := launch.ValidateRecord(record); err != nil {
		return err
	}
	claimsJSON, err := json.Marshal(claimsDocumentFrom(record.Claims))
	if err != nil {
		return fmt.Errorf("postgres launch store: encode claims: %w", err)
	}

	result, err := s.db.ExecContext(
		ctx,
		launchCreateSQL,
		hex.EncodeToString(record.Digest[:]),
		record.Claims.OperatorID,
		claimsJSON,
		record.ExpiresAt.UTC(),
		record.CreatedAt.UTC(),
	)
	if err != nil {
		return fmt.Errorf("postgres launch store: create: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("postgres launch store: create count: %w", err)
	}
	if rows == 0 {
		return launch.ErrDigestExists
	}
	if rows != 1 {
		return launch.ErrStoreInvariant
	}
	return nil
}

func (s *LaunchStore) Consume(ctx context.Context, request launch.ConsumeRequest) (launch.Record, error) {
	if err := ctx.Err(); err != nil {
		return launch.Record{}, err
	}
	if !securityIdentifierPattern.MatchString(request.Binding.OperatorID) ||
		!securityIdentifierPattern.MatchString(request.Binding.SessionID) {
		// 与其他不可消费凭据返回同一结果，避免向直接调用适配器的一方暴露租户及会话绑定判定接口。
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
// 防止确定性启动凭据重新变成可消费状态。
func (s *LaunchStore) PurgeExpired(ctx context.Context, before time.Time, batchSize int) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := validatePurge(before, batchSize); err != nil {
		return 0, err
	}
	retentionBoundary := before.UTC().Add(-launch.IdempotencyRetention)
	result, err := s.db.ExecContext(ctx, launchPurgeSQL, retentionBoundary, batchSize)
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
	OperatorID         string `json:"operatorId"`
	SessionID          string `json:"sessionId"`
	PlayerID           string `json:"playerId"`
	WalletSessionID    string `json:"walletSessionId"`
	GameID             string `json:"gameId"`
	DefinitionVersion  string `json:"definitionVersion"`
	DefinitionHash     string `json:"definitionHash"`
	RequestFingerprint string `json:"requestFingerprint"`
	Currency           string `json:"currency"`
	CurrencyExponent   int    `json:"currencyExponent"`
	Jurisdiction       string `json:"jurisdiction"`
}

func claimsDocumentFrom(claims launch.Claims) launchClaimsDocument {
	return launchClaimsDocument{
		OperatorID: claims.OperatorID, SessionID: claims.SessionID,
		PlayerID: claims.PlayerID, WalletSessionID: claims.WalletSessionID,
		GameID: claims.GameID, DefinitionVersion: claims.DefinitionVersion,
		DefinitionHash:     claims.DefinitionHash,
		RequestFingerprint: claims.RequestFingerprint, Currency: claims.Currency,
		CurrencyExponent: claims.CurrencyExponent, Jurisdiction: claims.Jurisdiction,
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
	}
}

func (s *LaunchStore) Get(ctx context.Context, digest launch.CodeDigest) (launch.Record, error) {
	if err := ctx.Err(); err != nil {
		return launch.Record{}, err
	}
	var (
		storedDigest     string
		storedOperatorID string
		claimsJSON       []byte
		createdAt        time.Time
		expiresAt        time.Time
	)
	err := s.db.QueryRowContext(
		ctx, launchGetSQL, hex.EncodeToString(digest[:]),
	).Scan(&storedDigest, &storedOperatorID, &claimsJSON, &createdAt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return launch.Record{}, launch.ErrCodeUnavailable
	}
	if err != nil {
		return launch.Record{}, fmt.Errorf("postgres launch store: get: %w", err)
	}
	decodedDigest, err := hex.DecodeString(storedDigest)
	if err != nil || len(decodedDigest) != sha256.Size {
		return launch.Record{}, launch.ErrStoreInvariant
	}
	var persisted launch.CodeDigest
	copy(persisted[:], decodedDigest)
	document, err := decodeClaimsDocument(claimsJSON)
	if err != nil {
		return launch.Record{}, launch.ErrStoreInvariant
	}
	record := launch.Record{
		Digest: persisted, Claims: document.claims(),
		CreatedAt: createdAt.UTC(), ExpiresAt: expiresAt.UTC(),
	}
	if persisted != digest || record.Claims.OperatorID != storedOperatorID ||
		launch.ValidateRecord(record) != nil {
		return launch.Record{}, launch.ErrStoreInvariant
	}
	return record, nil
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
		WHERE expires_at <= $1
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
	INSERT INTO rgs_launch_codes (
		code_hash, operator_id, claims_json, expires_at, created_at
	) VALUES ($1, $2, $3, $4, $5)
	ON CONFLICT (code_hash) DO NOTHING`

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
	SELECT code_hash, operator_id, claims_json, created_at, expires_at
	FROM rgs_launch_codes
	WHERE code_hash = $1`

const launchPurgeSQL = `
	WITH expired AS (
		SELECT code_hash
		FROM rgs_launch_codes
		WHERE expires_at <= $1
		ORDER BY expires_at
		LIMIT $2
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
