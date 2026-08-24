package rgsapi

import (
	"encoding/base64"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

const (
	minimumSessionTTL = time.Minute
	maximumSessionTTL = 24 * time.Hour
	launchCodeLength  = 46
)

func validateOperatorLaunchRequest(request operatorLaunchRequest) error {
	for _, value := range []string{
		request.PlayerID, request.WalletAccountID, request.WalletSessionID,
		request.SessionID, request.GameID, request.DefinitionVersion,
	} {
		if !apiIdentifierPattern.MatchString(value) {
			return errors.New("invalid identifier")
		}
	}
	if !apiDigestPattern.MatchString(request.DefinitionHash) ||
		!apiCurrencyPattern.MatchString(request.Currency) ||
		request.CurrencyExponent < 0 || request.CurrencyExponent > 6 ||
		!apiJurisdictionPattern.MatchString(request.Jurisdiction) {
		return errors.New("invalid game or jurisdiction binding")
	}
	if _, err := parseCanonicalNonNegativeInt64(request.BalanceMinor); err != nil {
		return err
	}
	if request.SessionTTLSeconds < int64(minimumSessionTTL/time.Second) ||
		request.SessionTTLSeconds > int64(maximumSessionTTL/time.Second) {
		return errors.New("invalid session TTL")
	}
	if request.IdleDisconnectSeconds < 1 || request.IdleDisconnectSeconds > 86400 {
		return errors.New("invalid idle disconnect duration")
	}
	return nil
}

func validateLaunchResult(result LaunchResult, _ operatorLaunchRequest, now time.Time) error {
	validExpiry := result.ExpiresAt.After(now)
	if result.HistoricalReplay {
		validExpiry = result.ExpiresAt.Add(launch.IdempotencyRetention).After(now)
	}
	if !validLaunchCode(result.LaunchCode) || !validExpiry {
		return errors.New("invalid launch result")
	}
	parsed, err := url.Parse(result.ExchangeURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path == "" {
		return errors.New("invalid exchange URL")
	}
	return nil
}

func validateClientSessionExchangeRequest(request clientSessionExchangeRequest) error {
	if !validLaunchCode(request.LaunchCode) || !apiIdentifierPattern.MatchString(request.OperatorID) ||
		!apiIdentifierPattern.MatchString(request.SessionID) {
		return errors.New("invalid launch exchange")
	}
	return nil
}

func validLaunchCode(code string) bool {
	if len(code) != launchCodeLength || !strings.HasPrefix(code, "lc_") {
		return false
	}
	encoded := strings.TrimPrefix(code, "lc_")
	for _, character := range encoded {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') &&
			!(character >= '0' && character <= '9') && character != '-' && character != '_' {
			return false
		}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == encoded
}

func validateBinding(binding sessionBindingRequest) error {
	for _, value := range []string{
		binding.OperatorID, binding.SessionID, binding.GameID, binding.DefinitionVersion,
	} {
		if !apiIdentifierPattern.MatchString(value) {
			return errors.New("invalid session binding")
		}
	}
	if !apiDigestPattern.MatchString(binding.DefinitionHash) ||
		!apiCurrencyPattern.MatchString(binding.Currency) ||
		binding.CurrencyExponent < 0 || binding.CurrencyExponent > 6 ||
		!apiJurisdictionPattern.MatchString(binding.Jurisdiction) {
		return errors.New("invalid session binding")
	}
	return nil
}

func validateClientSpinRequest(request clientSpinRequest) (int64, uint64, error) {
	if err := validateBinding(request.sessionBindingRequest); err != nil {
		return 0, 0, err
	}
	betMinor, err := parseCanonicalPositiveInt64(request.BetMinor)
	if err != nil {
		return 0, 0, err
	}
	revision, err := parseCanonicalUint64(request.StartRevision, rgs.MaxStateRevision)
	if err != nil {
		return 0, 0, err
	}
	spin := rgs.SpinRequest{
		OperatorID: request.OperatorID, SessionID: request.SessionID,
		RoundID: request.RoundID, GameID: request.GameID,
		DefinitionVersion: request.DefinitionVersion, DefinitionHash: request.DefinitionHash,
		Currency: request.Currency, RoundKind: request.RoundKind,
		BetMinor: betMinor, StartRevision: revision, TransportGeneration: 1,
	}
	if err := rgs.ValidateSpinRequest(spin); err != nil {
		return 0, 0, err
	}
	return betMinor, revision, nil
}

func validateRoundStatusRequest(request roundStatusRequest) error {
	if err := validateBinding(request.sessionBindingRequest); err != nil {
		return err
	}
	if !apiIdentifierPattern.MatchString(request.RoundID) {
		return errors.New("invalid round ID")
	}
	return nil
}

func validateResultDeliveryAcknowledgementRequest(request resultDeliveryAcknowledgementRequest) (uint64, error) {
	if err := validateBinding(request.sessionBindingRequest); err != nil {
		return 0, err
	}
	sequence, err := parseCanonicalUint64(request.Sequence, rgs.MaxClientSequence)
	if err != nil || sequence == 0 {
		return 0, errors.New("invalid result sequence")
	}
	receipt := rgs.ResultDeliveryAcknowledgement{
		OperatorID: request.OperatorID, SessionID: request.SessionID,
		RoundID: request.RoundID, Sequence: sequence, ResultHash: request.ResultHash,
		// 浏览器永不提供代际；该哨兵只校验公开 payload 形状，handler 随后会用
		// 已验证的 token claims 替换它。
		TransportGeneration: 1,
	}
	if err := rgs.ValidateResultDeliveryAcknowledgement(receipt); err != nil {
		return 0, err
	}
	return sequence, nil
}

func claimsMatchBinding(claims operator.AccessTokenClaims, binding sessionBindingRequest) bool {
	return claims.OperatorID == binding.OperatorID &&
		claims.SessionID == binding.SessionID &&
		claims.GameID == binding.GameID &&
		claims.GameDefinitionVersion == binding.DefinitionVersion &&
		claims.GameDefinitionHash == binding.DefinitionHash &&
		claims.Currency == binding.Currency &&
		claims.CurrencyExponent == binding.CurrencyExponent &&
		claims.Jurisdiction == binding.Jurisdiction
}

func claimsMatchSpinResult(claims operator.AccessTokenClaims, result rgs.SpinResult) bool {
	return claims.OperatorID == result.OperatorID && claims.SessionID == result.SessionID &&
		claims.GameID == result.GameID && claims.GameDefinitionVersion == result.DefinitionVersion &&
		claims.GameDefinitionHash == result.DefinitionHash && claims.Currency == result.Currency
}

func bindingFromSession(session rgs.Session) sessionBindingRequest {
	return sessionBindingRequest{
		OperatorID: session.OperatorID, SessionID: session.SessionID, GameID: session.GameID,
		DefinitionVersion: session.DefinitionVersion, DefinitionHash: session.DefinitionHash,
		Currency: session.Currency, CurrencyExponent: session.CurrencyExponent,
		Jurisdiction: session.Jurisdiction,
	}
}

func spinResultMatches(result rgs.SpinResult, request rgs.SpinRequest) bool {
	return result.OperatorID == request.OperatorID && result.SessionID == request.SessionID &&
		result.RoundID == request.RoundID && result.GameID == request.GameID &&
		result.DefinitionVersion == request.DefinitionVersion && result.DefinitionHash == request.DefinitionHash &&
		result.Currency == request.Currency && result.RoundKind == request.RoundKind &&
		result.StartRevision == request.StartRevision && result.BetMinor == request.BetMinor &&
		result.EndRevision <= rgs.MaxStateRevision && result.Sequence <= rgs.MaxClientSequence &&
		result.ChargedBetMinor >= 0 && result.TotalWinMinor >= 0 && result.BalanceMinor >= 0 &&
		apiIdentifierPattern.MatchString(result.ServerTransactionID) &&
		apiIdentifierPattern.MatchString(result.WalletTransactionID)
}

func roundRecordMatches(record rgs.RoundRecord, request roundStatusRequest) bool {
	if record.Key != (rgs.RoundKey{OperatorID: request.OperatorID, SessionID: request.SessionID, RoundID: request.RoundID}) ||
		record.Request.OperatorID != request.OperatorID || record.Request.SessionID != request.SessionID ||
		record.Request.RoundID != request.RoundID || record.Request.GameID != request.GameID ||
		record.Request.DefinitionVersion != request.DefinitionVersion ||
		record.Request.DefinitionHash != request.DefinitionHash || record.Request.Currency != request.Currency {
		return false
	}
	switch record.Status {
	case rgs.RoundPrepared, rgs.RoundRiskPending, rgs.RoundWalletPending,
		rgs.RoundRejected, rgs.RoundManualReview:
		return true
	case rgs.RoundCommitted:
		return spinResultMatches(record.Result, record.Request)
	default:
		return false
	}
}

func parseCanonicalNonNegativeInt64(value string) (int64, error) {
	if value == "" || value[0] == '+' || value[0] == '-' || (len(value) > 1 && value[0] == '0') {
		return 0, errors.New("invalid non-negative integer")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || strconv.FormatInt(parsed, 10) != value {
		return 0, errors.New("invalid non-negative integer")
	}
	return parsed, nil
}
