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
)

var (
	identifierPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	currencyPattern     = regexp.MustCompile(`^[A-Z]{3}$`)
	jurisdictionPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)
	databaseRolePattern = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
	digestPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	fingerprintPattern  = regexp.MustCompile(`^rgs-fp-v2:[a-f0-9]{64}$`)
	moneyPattern        = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
)

var (
	errIdempotencyConflict = errors.New("local operator: idempotency conflict")
	errInsufficientFunds   = errors.New("local operator: insufficient funds")
	errOperationNotFound   = errors.New("local operator: operation not found")
	errAccountNotFound     = errors.New("local operator: wallet account not found")
	errAlreadyRolledBack   = errors.New("local operator: operation already rolled back")
)

type roundRequest struct {
	OperationID       string `json:"operationId"`
	Fingerprint       string `json:"fingerprint"`
	OperatorID        string `json:"operatorId"`
	PlayerID          string `json:"playerId"`
	WalletAccountID   string `json:"walletAccountId"`
	SessionID         string `json:"rgsSessionId"`
	RoundID           string `json:"roundId"`
	GameID            string `json:"gameId"`
	DefinitionVersion string `json:"gameDefinitionVersion"`
	DefinitionHash    string `json:"gameDefinitionHash"`
	RoundKind         string `json:"roundKind"`
	Currency          string `json:"currency"`
	DebitMinor        string `json:"debitMinor"`
	CreditMinor       string `json:"creditMinor"`
}

type lookupRequest struct {
	OperatorID  string `json:"operatorId"`
	OperationID string `json:"operationId"`
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

type storedOperation struct {
	OperationID       string
	Fingerprint       string
	OperatorID        string
	PlayerID          string
	WalletAccountID   string
	SessionID         string
	RoundID           string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	RoundKind         string
	Currency          string
	DebitMinor        int64
	CreditMinor       int64
	BalanceMinor      int64
	TransactionID     string
	RequestDigest     string
	RolledBack        bool
}

func validateRound(request roundRequest, encoded []byte) (validatedRound, error) {
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
	return nil
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
		WalletAccountID: request.WalletAccountID, SessionID: request.SessionID,
		RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		RoundKind: request.RoundKind, Currency: request.Currency,
		DebitMinor: request.Debit, CreditMinor: request.Credit, BalanceMinor: balance,
		TransactionID: transactionID, RequestDigest: request.RequestDigest,
	}
}

func operationResponse(status string, operation storedOperation) walletResponse {
	return walletResponse{
		Status: status, OperationID: operation.OperationID, Fingerprint: operation.Fingerprint,
		TransactionID: operation.TransactionID, OperatorID: operation.OperatorID,
		Currency: operation.Currency, DebitMinor: strconv.FormatInt(operation.DebitMinor, 10),
		CreditMinor:  strconv.FormatInt(operation.CreditMinor, 10),
		BalanceMinor: strconv.FormatInt(operation.BalanceMinor, 10),
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
	if balance < 0 || debit < 0 || credit < 0 || credit > math.MaxInt64-balance {
		return 0, fmt.Errorf("wallet balance overflow")
	}
	available := balance + credit
	if debit > available {
		return 0, errInsufficientFunds
	}
	return available - debit, nil
}
