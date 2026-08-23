package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"

	"slots-game/server/internal/rgs"
)

var (
	identifierPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	currencyPattern      = regexp.MustCompile(`^[A-Z]{3}$`)
	jurisdictionPattern  = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)
	databaseRolePattern  = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
	digestPattern        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	fingerprintPattern   = regexp.MustCompile(`^rgs-fp-v2:[a-f0-9]{64}$`)
	commandDigestPattern = regexp.MustCompile(`^rgs-wallet-cmd-v1:[a-f0-9]{64}$`)
	moneyPattern         = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
)

const (
	walletRejectionInsufficientFunds = "INSUFFICIENT_FUNDS"
	walletRejectionSessionInvalid    = "WALLET_SESSION_INVALID"
	walletRejectionAccountNotFound   = "ACCOUNT_NOT_FOUND"
)

var (
	errIdempotencyConflict  = errors.New("local operator: idempotency conflict")
	errInsufficientFunds    = errors.New("local operator: insufficient funds")
	errOperationNotFound    = errors.New("local operator: operation not found")
	errAccountNotFound      = errors.New("local operator: wallet account not found")
	errWalletSessionInvalid = errors.New("local operator: wallet session binding invalid")
	errAlreadyRolledBack    = errors.New("local operator: operation already rolled back")
)

type roundRequest struct {
	OperationID       string `json:"operationId"`
	Fingerprint       string `json:"fingerprint"`
	OperatorID        string `json:"operatorId"`
	PlayerID          string `json:"playerId"`
	WalletAccountID   string `json:"walletAccountId"`
	WalletSessionRef  string `json:"walletSessionRef,omitempty"`
	SessionID         string `json:"rgsSessionId"`
	RoundID           string `json:"roundId"`
	GameID            string `json:"gameId"`
	DefinitionVersion string `json:"gameDefinitionVersion"`
	DefinitionHash    string `json:"gameDefinitionHash"`
	RoundKind         string `json:"roundKind"`
	Currency          string `json:"currency"`
	DebitMinor        string `json:"debitMinor"`
	CreditMinor       string `json:"creditMinor"`
	CommandDigest     string `json:"commandDigest,omitempty"`
}

type lookupRequest struct {
	OperatorID    string `json:"operatorId"`
	OperationID   string `json:"operationId"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	CommandDigest string `json:"commandDigest,omitempty"`
}

type rollbackRequest struct {
	OperatorID  string `json:"operatorId"`
	OperationID string `json:"operationId"`
	RollbackID  string `json:"rollbackId"`
	Reason      string `json:"reason"`
}

type walletResponse struct {
	Status        string `json:"status"`
	Code          string `json:"code,omitempty"`
	OperationID   string `json:"operationId,omitempty"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	TransactionID string `json:"transactionId,omitempty"`
	OperatorID    string `json:"operatorId,omitempty"`
	Currency      string `json:"currency,omitempty"`
	DebitMinor    string `json:"debitMinor,omitempty"`
	CreditMinor   string `json:"creditMinor,omitempty"`
	BalanceMinor  string `json:"balanceMinor,omitempty"`
	CommandDigest string `json:"commandDigest,omitempty"`
	RollbackID    string `json:"rollbackId,omitempty"`
}

type validatedRound struct {
	roundRequest
	Debit         int64
	Credit        int64
	RequestDigest string
	OriginalJSON  []byte
}

type validatedRollback struct {
	rollbackRequest
	RequestDigest string
}

type accountSeed struct {
	OperatorID      string
	WalletAccountID string
	Currency        string
	BalanceMinor    int64
}

type walletSessionSeed struct {
	OperatorID        string
	WalletSessionRef  string
	PlayerID          string
	WalletAccountID   string
	SessionID         string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	Currency          string
	ExpiresAt         time.Time
}

type storedOperation struct {
	OperationID       string
	Fingerprint       string
	OperatorID        string
	PlayerID          string
	WalletAccountID   string
	WalletSessionRef  string
	SessionID         string
	RoundID           string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	RoundKind         string
	Currency          string
	DebitMinor        int64
	CreditMinor       int64
	CommandDigest     string
	BalanceMinor      int64
	TransactionID     string
	RequestDigest     string
	RolledBack        bool
}

type storedRejection struct {
	OperationID       string
	Fingerprint       string
	OperatorID        string
	PlayerID          string
	WalletAccountID   string
	WalletSessionRef  string
	SessionID         string
	RoundID           string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	RoundKind         string
	Currency          string
	DebitMinor        int64
	CreditMinor       int64
	CommandDigest     string
	RequestDigest     string
	Code              string
}

func validateRound(request roundRequest, encoded []byte) (validatedRound, error) {
	return validateRoundWithPolicy(request, encoded, false)
}

// validateRoundWithPolicy 默认只接受 v2 完整绑定。旧 v1 兼容必须由部署显式开启，
// 且只能同时缺少两个 v2 字段，避免半升级请求降级绕过完整命令校验。
func validateRoundWithPolicy(
	request roundRequest,
	encoded []byte,
	allowLegacyV1 bool,
) (validatedRound, error) {
	hasWalletSession := request.WalletSessionRef != ""
	hasCommandDigest := request.CommandDigest != ""
	legacyV1 := !hasWalletSession && !hasCommandDigest
	if hasWalletSession != hasCommandDigest || (legacyV1 && !allowLegacyV1) {
		return validatedRound{}, errors.New("wallet v2 command binding is required")
	}
	if !allIdentifiers(
		request.OperationID, request.OperatorID, request.PlayerID, request.WalletAccountID,
		request.SessionID, request.RoundID, request.GameID, request.DefinitionVersion,
	) || !digestPattern.MatchString(request.DefinitionHash) ||
		!fingerprintPattern.MatchString(request.Fingerprint) || !currencyPattern.MatchString(request.Currency) ||
		(request.RoundKind != "BASE" && request.RoundKind != "FREE_SPIN" && request.RoundKind != "BONUS") {
		return validatedRound{}, errors.New("invalid wallet round identity")
	}
	debit, err := parseMoney(request.DebitMinor)
	if err != nil {
		return validatedRound{}, errors.New("invalid debitMinor")
	}
	credit, err := parseMoney(request.CreditMinor)
	if err != nil {
		return validatedRound{}, errors.New("invalid creditMinor")
	}
	if !legacyV1 {
		if !allIdentifiers(request.WalletSessionRef) ||
			!commandDigestPattern.MatchString(request.CommandDigest) {
			return validatedRound{}, errors.New("invalid wallet v2 command binding")
		}
		command := rgs.WalletRound{
			OperationID: request.OperationID, Fingerprint: request.Fingerprint,
			OperatorID: request.OperatorID, PlayerID: request.PlayerID,
			WalletAccountID: request.WalletAccountID, WalletSessionRef: request.WalletSessionRef,
			SessionID: request.SessionID, RoundID: request.RoundID, GameID: request.GameID,
			DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
			RoundKind: rgs.RoundKind(request.RoundKind), Currency: request.Currency,
			DebitMinor: debit, CreditMinor: credit, CommandDigest: request.CommandDigest,
		}
		// 摘要由 operator 从已解析的完整命令重算；客户端提交值只用于恒定比较，
		// 不能作为账本幂等或审计事实直接信任。
		if expected := rgs.CommandDigestFor(command); subtleCompare(
			[]byte(request.CommandDigest), []byte(expected),
		) == 0 {
			return validatedRound{}, errors.New("wallet command digest mismatch")
		}
		if err := rgs.ValidateWalletCommand(command); err != nil {
			return validatedRound{}, errors.New("invalid wallet v2 command")
		}
	}
	canonical, err := json.Marshal(request)
	if err != nil {
		return validatedRound{}, errors.New("encode wallet round")
	}
	digest := sha256.Sum256(canonical)
	return validatedRound{
		roundRequest: request, Debit: debit, Credit: credit,
		RequestDigest: hex.EncodeToString(digest[:]), OriginalJSON: append([]byte(nil), encoded...),
	}, nil
}

func validateLookup(request lookupRequest) error {
	if !allIdentifiers(request.OperatorID, request.OperationID) {
		return errors.New("invalid lookup identity")
	}
	if request.Fingerprint == "" && request.CommandDigest == "" {
		return nil
	}
	if !fingerprintPattern.MatchString(request.Fingerprint) ||
		!commandDigestPattern.MatchString(request.CommandDigest) {
		return errors.New("invalid lookup command binding")
	}
	return nil
}

func lookupUsesV2Binding(request lookupRequest) bool {
	return request.Fingerprint != "" || request.CommandDigest != ""
}

func validateRollback(request rollbackRequest) (validatedRollback, error) {
	if !allIdentifiers(request.OperatorID, request.OperationID, request.RollbackID) ||
		request.Reason == "" || len(request.Reason) > 512 {
		return validatedRollback{}, errors.New("invalid rollback request")
	}
	canonical, err := json.Marshal(request)
	if err != nil {
		return validatedRollback{}, errors.New("encode rollback request")
	}
	digest := sha256.Sum256(canonical)
	return validatedRollback{rollbackRequest: request, RequestDigest: hex.EncodeToString(digest[:])}, nil
}

func newStoredOperation(request validatedRound, transactionID string, balance int64) storedOperation {
	return storedOperation{
		OperationID: request.OperationID, Fingerprint: request.Fingerprint,
		OperatorID: request.OperatorID, PlayerID: request.PlayerID,
		WalletAccountID: request.WalletAccountID, WalletSessionRef: request.WalletSessionRef,
		SessionID: request.SessionID,
		RoundID:   request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		RoundKind: request.RoundKind, Currency: request.Currency,
		DebitMinor: request.Debit, CreditMinor: request.Credit,
		CommandDigest: request.CommandDigest, BalanceMinor: balance,
		TransactionID: transactionID, RequestDigest: request.RequestDigest,
	}
}

func newStoredRejection(request validatedRound, code string) storedRejection {
	return storedRejection{
		OperationID: request.OperationID, Fingerprint: request.Fingerprint,
		OperatorID: request.OperatorID, PlayerID: request.PlayerID,
		WalletAccountID: request.WalletAccountID, WalletSessionRef: request.WalletSessionRef,
		SessionID: request.SessionID, RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		RoundKind: request.RoundKind, Currency: request.Currency,
		DebitMinor: request.Debit, CreditMinor: request.Credit,
		CommandDigest: request.CommandDigest, RequestDigest: request.RequestDigest, Code: code,
	}
}

func rejectionError(code string) error {
	switch code {
	case walletRejectionInsufficientFunds:
		return errInsufficientFunds
	case walletRejectionSessionInvalid:
		return errWalletSessionInvalid
	case walletRejectionAccountNotFound:
		return errAccountNotFound
	default:
		return errors.New("local operator: invalid stored rejection")
	}
}

func rejectionCode(err error) (string, bool) {
	switch {
	case errors.Is(err, errInsufficientFunds):
		return walletRejectionInsufficientFunds, true
	case errors.Is(err, errWalletSessionInvalid):
		return walletRejectionSessionInvalid, true
	case errors.Is(err, errAccountNotFound):
		return walletRejectionAccountNotFound, true
	default:
		return "", false
	}
}

func operationResponse(status string, operation storedOperation) walletResponse {
	return walletResponse{
		Status: status, OperationID: operation.OperationID, Fingerprint: operation.Fingerprint,
		TransactionID: operation.TransactionID, OperatorID: operation.OperatorID,
		Currency: operation.Currency, DebitMinor: strconv.FormatInt(operation.DebitMinor, 10),
		CreditMinor:   strconv.FormatInt(operation.CreditMinor, 10),
		BalanceMinor:  strconv.FormatInt(operation.BalanceMinor, 10),
		CommandDigest: operation.CommandDigest,
	}
}

func parseMoney(value string) (int64, error) {
	if !moneyPattern.MatchString(value) {
		return 0, errors.New("money is not canonical")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || parsed == math.MaxInt64 {
		return 0, errors.New("money is out of range")
	}
	return parsed, nil
}

func allIdentifiers(values ...string) bool {
	for _, value := range values {
		if !identifierPattern.MatchString(value) {
			return false
		}
	}
	return true
}

func checkedBalance(balance, debit, credit int64) (int64, error) {
	if balance < 0 || debit < 0 || credit < 0 {
		return 0, fmt.Errorf("wallet balance overflow")
	}
	// 原子 round 的派奖是投注结算结果，不能反向为同一轮的投注融资；必须先从
	// 轮次开始时的余额中完整扣除 debit，再把 credit 加回剩余余额。
	if debit > balance {
		return 0, errInsufficientFunds
	}
	remaining := balance - debit
	if credit > math.MaxInt64-remaining {
		return 0, fmt.Errorf("wallet balance overflow")
	}
	return remaining + credit, nil
}
