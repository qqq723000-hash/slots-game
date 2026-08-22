package rgsapi

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

var (
	apiIdentifierPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	apiDigestPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	apiCurrencyPattern     = regexp.MustCompile(`^[A-Z]{3}$`)
	apiJurisdictionPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)
)

const (
	responseSigningLookupTimeout   = time.Second
	maximumRequestJSONNestingDepth = 32
)

type Handler struct {
	operatorRequests     OperatorRequestVerifier
	accessTokens         AccessTokenVerifier
	responseSigningKeys  ResponseSigningKeyResolver
	launches             LaunchService
	spins                SpinCoordinator
	rounds               RoundStatusReader
	deliveries           ResultDeliveryService
	admission            Admission
	clientAdmission      Admission
	launchAdmission      Admission
	spinAdmission        Admission
	securityEvents       SecurityEventObserver
	maxRequestBytes      int64
	responseSignatureTTL time.Duration
	now                  func() time.Time
	newRequestID         func() string
}

func NewHandler(config Config) (*Handler, error) {
	if config.OperatorRequests == nil || config.AccessTokens == nil || config.ResponseSigningKeys == nil || config.Launches == nil ||
		config.Spins == nil || config.Rounds == nil {
		return nil, errors.New("rgsapi: all handler dependencies are required")
	}
	if config.MaxRequestBytes < 0 || config.MaxRequestBytes > operator.MaximumSignedRequestBody {
		return nil, fmt.Errorf("rgsapi: max request bytes must be in [0,%d]", operator.MaximumSignedRequestBody)
	}
	if config.MaxRequestBytes == 0 {
		config.MaxRequestBytes = DefaultMaxRequestBytes
	}
	if config.ResponseSignatureTTL < 0 || config.ResponseSignatureTTL > operator.DefaultSignatureLifetime {
		return nil, errors.New("rgsapi: invalid response signature TTL")
	}
	if config.ResponseSignatureTTL == 0 {
		config.ResponseSignatureTTL = time.Minute
	}
	if config.ResponseSignatureTTL < time.Second {
		return nil, errors.New("rgsapi: response signature TTL must be at least one second")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewRequestID == nil {
		config.NewRequestID = randomRequestID
	}
	deliveries, ok := config.Spins.(ResultDeliveryService)
	if !ok {
		return nil, errors.New("rgsapi: spin coordinator must support result delivery")
	}
	return &Handler{
		operatorRequests:     config.OperatorRequests,
		accessTokens:         config.AccessTokens,
		responseSigningKeys:  config.ResponseSigningKeys,
		launches:             config.Launches,
		spins:                config.Spins,
		rounds:               config.Rounds,
		deliveries:           deliveries,
		admission:            config.Admission,
		clientAdmission:      config.ClientAdmission,
		launchAdmission:      config.LaunchAdmission,
		spinAdmission:        config.SpinAdmission,
		securityEvents:       config.SecurityEvents,
		maxRequestBytes:      config.MaxRequestBytes,
		responseSignatureTTL: config.ResponseSignatureTTL,
		now:                  config.Now,
		newRequestID:         config.NewRequestID,
	}, nil
}

func (h *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	requestID := h.requestID(request)
	responseWriter := writer
	var buffered *bufferedResponseWriter
	if isOperatorRoute(request) {
		buffered = newBufferedResponseWriter()
		responseWriter = buffered
	}
	defer func() {
		if recover() != nil {
			if buffered != nil {
				buffered.Reset()
			}
			h.writeError(responseWriter, requestID, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
		}
		if buffered != nil {
			h.flushSignedOperatorResponse(writer, request, buffered)
		}
	}()

	if request == nil || request.URL == nil {
		h.writeError(responseWriter, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request is invalid")
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery || request.URL.RawPath != "" {
		h.writeError(responseWriter, requestID, http.StatusBadRequest, "INVALID_REQUEST", "query strings and encoded paths are not supported")
		return
	}
	switch request.URL.Path {
	case OperatorLaunchPath:
		h.requirePOST(responseWriter, request, requestID, h.handleOperatorLaunch)
	case OperatorRoundStatusPath:
		h.requirePOST(responseWriter, request, requestID, h.handleOperatorRoundStatus)
	case ClientSessionExchangePath:
		h.requirePOST(responseWriter, request, requestID, h.handleClientSessionExchange)
	case ClientSessionRefreshPath:
		h.requirePOST(responseWriter, request, requestID, h.handleClientSessionRefresh)
	case ClientSpinPath:
		h.requirePOST(responseWriter, request, requestID, h.handleClientSpin)
	case ClientRoundStatusPath:
		h.requirePOST(responseWriter, request, requestID, h.handleClientRoundStatus)
	case ClientPendingResultPath:
		h.requireGET(responseWriter, request, requestID, h.handleClientPendingResult)
	case ClientResultAckPath:
		h.requirePOST(responseWriter, request, requestID, h.handleClientResultAcknowledgement)
	default:
		h.writeError(responseWriter, requestID, http.StatusNotFound, "NOT_FOUND", "route not found")
	}
}

func (h *Handler) requireGET(writer http.ResponseWriter, request *http.Request, requestID string, endpoint endpointFunc) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		h.writeError(writer, requestID, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if request.ContentLength > 0 || len(request.Header.Values("Content-Type")) != 0 ||
		len(request.Header.Values("Content-Encoding")) != 0 {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "GET request must not include a body")
		return
	}
	endpoint(writer, request, requestID)
}

type endpointFunc func(http.ResponseWriter, *http.Request, string)

func (h *Handler) requirePOST(writer http.ResponseWriter, request *http.Request, requestID string, endpoint endpointFunc) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		h.writeError(writer, requestID, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if !singleExactHeader(request.Header, "Content-Type", operator.SignedContentType) {
		h.writeError(writer, requestID, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "content type must be application/json")
		return
	}
	if values := request.Header.Values("Content-Encoding"); len(values) != 0 {
		h.writeError(writer, requestID, http.StatusUnsupportedMediaType, "UNSUPPORTED_CONTENT_ENCODING", "content encoding is not supported")
		return
	}
	endpoint(writer, request, requestID)
}

func (h *Handler) handleOperatorLaunch(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	verified, err := h.operatorRequests.Authenticate(request.Context(), request, body)
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	requestID = verified.RequestID
	if !h.admitVerifiedOperator(request.Context(), writer, requestID, verified.OperatorID) {
		return
	}
	if h.launchAdmission != nil && !h.writeAdmissionResult(writer, requestID, h.launchAdmission.Admit(
		request.Context(), "operator:"+verified.OperatorID, h.now(),
	)) {
		return
	}
	if err := h.operatorRequests.ConsumeNonce(request.Context(), verified); err != nil {
		h.writeOperatorNonceError(writer, requestID, err)
		return
	}

	var payload operatorLaunchRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	if err := validateOperatorLaunchRequest(payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	balanceMinor, _ := parseCanonicalNonNegativeInt64(payload.BalanceMinor)
	result, err := h.launches.CreateLaunch(request.Context(), LaunchCommand{
		OperatorID: verified.OperatorID, RequestID: verified.RequestID,
		IdempotencyKey: verified.IdempotencyKey, PlayerID: payload.PlayerID,
		WalletAccountID: payload.WalletAccountID, WalletSessionID: payload.WalletSessionID,
		SessionID: payload.SessionID, GameID: payload.GameID,
		DefinitionVersion: payload.DefinitionVersion, DefinitionHash: payload.DefinitionHash,
		Currency: payload.Currency, CurrencyExponent: payload.CurrencyExponent,
		Jurisdiction: payload.Jurisdiction, BalanceMinor: balanceMinor,
		SessionTTL: time.Duration(payload.SessionTTLSeconds) * time.Second,
	})
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if err := validateLaunchResult(result, payload, h.now()); err != nil {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid launch adapter result", ErrUnavailable))
		return
	}
	h.writeSuccess(writer, requestID, http.StatusCreated, launchResponse{
		LaunchCode: result.LaunchCode, ExchangeURL: result.ExchangeURL,
		ExpiresAt: formatTime(result.ExpiresAt),
	})
}

func (h *Handler) handleClientSessionExchange(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	var payload clientSessionExchangeRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	if err := validateClientSessionExchangeRequest(payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	if len(request.Header.Values("Authorization")) != 0 {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "authorization is not accepted on launch exchange")
		return
	}
	result, err := h.launches.ExchangeSession(request.Context(), ExchangeCommand{
		LaunchCode: payload.LaunchCode, OperatorID: payload.OperatorID,
		SessionID: payload.SessionID, RequestID: requestID,
	})
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if err := rgs.ValidateSession(result.Session); err != nil {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid exchange adapter result", ErrUnavailable))
		return
	}
	if result.Session.OperatorID != payload.OperatorID || result.Session.SessionID != payload.SessionID {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: exchange binding mismatch", ErrUnavailable))
		return
	}
	claims, err := h.accessTokens.Verify(request.Context(), result.AccessToken, payload.OperatorID)
	if err != nil || !claimsMatchBinding(claims, bindingFromSession(result.Session)) ||
		claims.PlayerID != result.Session.PlayerID || claims.WalletSessionID != result.Session.WalletSessionID {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid access token from exchange adapter", ErrUnavailable))
		return
	}
	h.writeSuccess(writer, requestID, http.StatusOK, sessionExchangeResponse{
		AccessToken: result.AccessToken, Session: makeSessionResponse(result.Session),
	})
}

func (h *Handler) handleClientSessionRefresh(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	var payload clientSessionRefreshRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	if err := validateBinding(payload.sessionBindingRequest); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	claims, ok := h.authenticateClient(
		writer, request, requestID, payload.sessionBindingRequest,
	)
	if !ok {
		return
	}
	result, err := h.launches.RefreshSession(request.Context(), RefreshCommand{
		Claims: claims, RequestID: requestID,
	})
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if err := rgs.ValidateSession(result.Session); err != nil ||
		!claimsMatchBinding(claims, bindingFromSession(result.Session)) ||
		claims.PlayerID != result.Session.PlayerID ||
		claims.WalletSessionID != result.Session.WalletSessionID {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid refresh adapter result", ErrUnavailable))
		return
	}
	refreshed, err := h.accessTokens.Verify(
		request.Context(), result.AccessToken, result.Session.OperatorID,
	)
	if err != nil || !claimsMatchBinding(refreshed, bindingFromSession(result.Session)) ||
		refreshed.PlayerID != result.Session.PlayerID ||
		refreshed.WalletSessionID != result.Session.WalletSessionID {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid refreshed access token", ErrUnavailable))
		return
	}
	h.writeSuccess(writer, requestID, http.StatusOK, sessionExchangeResponse{
		AccessToken: result.AccessToken, Session: makeSessionResponse(result.Session),
	})
}

func (h *Handler) handleClientSpin(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	var payload clientSpinRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	betMinor, revision, err := validateClientSpinRequest(payload)
	if err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	claims, ok := h.authenticateClient(writer, request, requestID, payload.sessionBindingRequest)
	if !ok {
		return
	}
	if h.spinAdmission != nil && !h.writeAdmissionResult(writer, requestID, h.spinAdmission.Admit(
		request.Context(), clientAdmissionKey(claims.OperatorID, claims.SessionID), h.now(),
	)) {
		return
	}
	spinRequest := rgs.SpinRequest{
		OperatorID: payload.OperatorID, SessionID: payload.SessionID, RoundID: payload.RoundID,
		GameID: payload.GameID, DefinitionVersion: payload.DefinitionVersion,
		DefinitionHash: payload.DefinitionHash, Currency: payload.Currency,
		RoundKind: payload.RoundKind, BetMinor: betMinor, StartRevision: revision,
	}
	result, err := h.spins.Spin(request.Context(), spinRequest)
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if !spinResultMatches(result, spinRequest) {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid coordinator result", ErrUnavailable))
		return
	}
	response, err := makeSpinResultResponse(result)
	if err != nil {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: encode committed result hash", ErrUnavailable))
		return
	}
	h.writeSuccess(writer, requestID, http.StatusOK, response)
}

func (h *Handler) handleClientRoundStatus(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	var payload roundStatusRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	if err := validateRoundStatusRequest(payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	if _, ok := h.authenticateClient(writer, request, requestID, payload.sessionBindingRequest); !ok {
		return
	}
	h.serveRoundStatus(writer, request.Context(), requestID, payload)
}

func (h *Handler) handleClientPendingResult(writer http.ResponseWriter, request *http.Request, requestID string) {
	operatorValues := request.Header.Values(operator.HeaderOperatorID)
	if len(operatorValues) != 1 || !apiIdentifierPattern.MatchString(operatorValues[0]) {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "X-Operator-Id is required")
		return
	}
	claims, ok := h.authenticateClientClaims(writer, request, requestID, operatorValues[0])
	if !ok {
		return
	}
	delivery, err := h.deliveries.GetPendingResultDelivery(
		request.Context(), claims.OperatorID, claims.SessionID,
	)
	if errors.Is(err, rgs.ErrResultDeliveryNotFound) {
		h.writeNoContent(writer, requestID)
		return
	}
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if rgs.ValidateResultDelivery(delivery) != nil || delivery.OperatorID != claims.OperatorID ||
		delivery.SessionID != claims.SessionID || delivery.RoundID != delivery.Result.RoundID ||
		!claimsMatchSpinResult(claims, delivery.Result) {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid result delivery", ErrUnavailable))
		return
	}
	response, err := makeSpinResultResponse(delivery.Result)
	if err != nil || response.ResultHash != delivery.ResultHash {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: encode pending result", ErrUnavailable))
		return
	}
	h.writeSuccess(writer, requestID, http.StatusOK, pendingResultDeliveryResponse{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: strconv.FormatUint(delivery.Sequence, 10),
		ResultHash:    delivery.ResultHash,
		OriginFeature: makeFeatureStateResponse(delivery.OriginFeatureState),
		Result:        response,
	})
}

func (h *Handler) handleClientResultAcknowledgement(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	var payload resultDeliveryAcknowledgementRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	sequence, err := validateResultDeliveryAcknowledgementRequest(payload)
	if err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	if _, ok := h.authenticateClient(writer, request, requestID, payload.sessionBindingRequest); !ok {
		return
	}
	receipt := rgs.ResultDeliveryAcknowledgement{
		OperatorID: payload.OperatorID, SessionID: payload.SessionID,
		RoundID: payload.RoundID, Sequence: sequence, ResultHash: payload.ResultHash,
	}
	delivery, _, err := h.deliveries.AcknowledgeResultDelivery(request.Context(), receipt)
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if delivery.OperatorID != receipt.OperatorID || delivery.SessionID != receipt.SessionID ||
		delivery.RoundID != receipt.RoundID || delivery.Sequence != receipt.Sequence ||
		delivery.ResultHash != receipt.ResultHash || delivery.AcknowledgedAt.IsZero() {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid acknowledgement result", ErrUnavailable))
		return
	}
	h.writeSuccess(writer, requestID, http.StatusOK, resultDeliveryAcknowledgementResponse{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: strconv.FormatUint(delivery.Sequence, 10),
		ResultHash: delivery.ResultHash, AcknowledgedAt: formatTime(delivery.AcknowledgedAt),
	})
}

func (h *Handler) handleOperatorRoundStatus(writer http.ResponseWriter, request *http.Request, requestID string) {
	body, ok := h.readBody(writer, request, requestID)
	if !ok {
		return
	}
	verified, err := h.operatorRequests.Authenticate(request.Context(), request, body)
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	requestID = verified.RequestID
	if !h.admitVerifiedOperator(request.Context(), writer, requestID, verified.OperatorID) {
		return
	}
	if err := h.operatorRequests.ConsumeNonce(request.Context(), verified); err != nil {
		h.writeOperatorNonceError(writer, requestID, err)
		return
	}
	var payload roundStatusRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	if err := validateRoundStatusRequest(payload); err != nil || payload.OperatorID != verified.OperatorID {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid")
		return
	}
	h.serveRoundStatus(writer, request.Context(), requestID, payload)
}

func (h *Handler) admitVerifiedOperator(ctx context.Context, writer http.ResponseWriter, requestID, operatorID string) bool {
	if h.admission == nil {
		return true
	}
	return h.writeAdmissionResult(writer, requestID, h.admission.Admit(
		ctx, "operator:"+operatorID, h.now(),
	))
}

func (h *Handler) serveRoundStatus(writer http.ResponseWriter, ctx context.Context, requestID string, payload roundStatusRequest) {
	record, err := h.rounds.GetRound(ctx, rgs.RoundKey{
		OperatorID: payload.OperatorID, SessionID: payload.SessionID, RoundID: payload.RoundID,
	})
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return
	}
	if !roundRecordMatches(record, payload) {
		h.writeMappedError(writer, requestID, fmt.Errorf("%w: invalid round reader result", ErrUnavailable))
		return
	}
	response := roundStatusResponse{
		OperatorID: record.Key.OperatorID, SessionID: record.Key.SessionID,
		RoundID: record.Key.RoundID, Status: record.Status,
	}
	if record.Status == rgs.RoundCommitted {
		result, encodeErr := makeSpinResultResponse(record.Result)
		if encodeErr != nil {
			h.writeMappedError(writer, requestID, fmt.Errorf("%w: encode committed result hash", ErrUnavailable))
			return
		}
		response.Result = &result
	}
	h.writeSuccess(writer, requestID, http.StatusOK, response)
}

func (h *Handler) authenticateClient(writer http.ResponseWriter, request *http.Request, requestID string, binding sessionBindingRequest) (operator.AccessTokenClaims, bool) {
	claims, ok := h.authenticateClientClaims(writer, request, requestID, binding.OperatorID)
	if !ok {
		return operator.AccessTokenClaims{}, false
	}
	if !claimsMatchBinding(claims, binding) {
		h.writeError(writer, requestID, http.StatusForbidden, "TOKEN_BINDING_MISMATCH", "access token does not match the requested session")
		return operator.AccessTokenClaims{}, false
	}
	return claims, true
}

func (h *Handler) authenticateClientClaims(writer http.ResponseWriter, request *http.Request, requestID, operatorID string) (operator.AccessTokenClaims, bool) {
	token, err := bearerToken(request.Header)
	if err != nil {
		h.writeError(writer, requestID, http.StatusUnauthorized, "UNAUTHORIZED", "access token is required")
		return operator.AccessTokenClaims{}, false
	}
	claims, err := h.accessTokens.Verify(request.Context(), token, operatorID)
	if err != nil {
		h.writeMappedError(writer, requestID, err)
		return operator.AccessTokenClaims{}, false
	}
	// 客户端限流必须位于访问令牌验证之后，并绑定已验证的运营商与会话。
	// 不能使用 RemoteAddr/X-Forwarded-For：反向代理会让无关玩家共享地址，后者又可被伪造。
	if h.clientAdmission != nil && !h.writeAdmissionResult(writer, requestID, h.clientAdmission.Admit(
		request.Context(), clientAdmissionKey(claims.OperatorID, claims.SessionID), h.now(),
	)) {
		return operator.AccessTokenClaims{}, false
	}
	return claims, true
}

func (h *Handler) writeAdmissionResult(writer http.ResponseWriter, requestID string, result AdmissionResult) bool {
	if result.Decision == AdmissionAllowed {
		return true
	}
	retryAfter := result.RetryAfter
	if retryAfter <= 0 {
		retryAfter = time.Second
	}
	seconds := int64((retryAfter + time.Second - 1) / time.Second)
	writer.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	if result.Decision != AdmissionRateLimited {
		h.writeError(writer, requestID, http.StatusServiceUnavailable, "ADMISSION_UNAVAILABLE", "request admission service is unavailable")
		return false
	}
	h.writeError(writer, requestID, http.StatusTooManyRequests, "RATE_LIMITED", "request rate limit exceeded")
	return false
}

func clientAdmissionKey(operatorID, sessionID string) string {
	// 合法标识允许冒号，因此必须转义元组的每个分量；反斜杠本身不在合法字符集内，
	// 可保证 (a:b,c) 与 (a,b:c) 不会误共享限流桶，同时保留常规键的可读形式。
	escape := func(value string) string { return strings.ReplaceAll(value, ":", `\:`) }
	return "client:" + escape(operatorID) + ":" + escape(sessionID)
}

func (h *Handler) readBody(writer http.ResponseWriter, request *http.Request, requestID string) ([]byte, bool) {
	if request.ContentLength > h.maxRequestBytes {
		h.writeError(writer, requestID, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body is too large")
		return nil, false
	}
	if request.Body == nil {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return nil, false
	}
	limited := io.LimitReader(request.Body, h.maxRequestBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			h.writeError(writer, requestID, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body is too large")
			return nil, false
		}
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_REQUEST", "request body could not be read")
		return nil, false
	}
	if int64(len(body)) > h.maxRequestBytes {
		h.writeError(writer, requestID, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body is too large")
		return nil, false
	}
	if len(body) == 0 {
		h.writeError(writer, requestID, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return nil, false
	}
	return body, true
}

func (h *Handler) requestID(request *http.Request) string {
	if request != nil {
		values := request.Header.Values(operator.HeaderRequestID)
		if len(values) == 1 && apiIdentifierPattern.MatchString(values[0]) {
			return values[0]
		}
	}
	requestID := h.newRequestID()
	if !apiIdentifierPattern.MatchString(requestID) {
		return randomRequestID()
	}
	return requestID
}

func (h *Handler) writeSuccess(writer http.ResponseWriter, requestID string, status int, data any) {
	h.writeJSON(writer, requestID, status, successEnvelope{Data: data, RequestID: requestID})
}

func (h *Handler) writeNoContent(writer http.ResponseWriter, requestID string) {
	writer.Header().Set(operator.HeaderRequestID, requestID)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(http.StatusNoContent)
}

func (h *Handler) writeError(writer http.ResponseWriter, requestID string, status int, code, message string) {
	h.writeJSON(writer, requestID, status, errorEnvelope{
		Error: errorBody{Code: code, Message: message}, RequestID: requestID,
	})
}

func (h *Handler) writeMappedError(writer http.ResponseWriter, requestID string, err error) {
	status, code, message := mapError(err)
	h.writeError(writer, requestID, status, code, message)
}

func (h *Handler) writeOperatorNonceError(writer http.ResponseWriter, requestID string, err error) {
	if errors.Is(err, operator.ErrReplay) && h.securityEvents != nil {
		h.securityEvents.NonceReplay()
	}
	h.writeMappedError(writer, requestID, err)
}

func (h *Handler) writeJSON(writer http.ResponseWriter, requestID string, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		status = http.StatusInternalServerError
		encoded = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"internal server error"},"requestId":"unavailable"}`)
		requestID = "unavailable"
	}
	writer.Header().Set("Content-Type", operator.SignedContentType)
	writer.Header().Set(operator.HeaderRequestID, requestID)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_, _ = writer.Write(append(encoded, '\n'))
}

func mapError(err error) (int, string, string) {
	switch {
	case errors.Is(err, operator.ErrNonceStore), errors.Is(err, ErrUnavailable):
		return http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "service is temporarily unavailable"
	case errors.Is(err, operator.ErrTenantMismatch):
		return http.StatusForbidden, "TENANT_MISMATCH", "credential does not match operator"
	case errors.Is(err, operator.ErrMalformed), errors.Is(err, operator.ErrUnknownKey),
		errors.Is(err, operator.ErrKeyInactive), errors.Is(err, operator.ErrSignatureInvalid),
		errors.Is(err, operator.ErrContentDigest), errors.Is(err, operator.ErrExpired),
		errors.Is(err, operator.ErrNotYetValid), errors.Is(err, operator.ErrReplay),
		errors.Is(err, operator.ErrAudienceMismatch), errors.Is(err, operator.ErrIssuerMismatch):
		return http.StatusUnauthorized, "UNAUTHORIZED", "credential is invalid"
	case errors.Is(err, ErrLaunchUnavailable):
		return http.StatusUnauthorized, "LAUNCH_CREDENTIAL_UNAVAILABLE", "launch credential is unavailable"
	case errors.Is(err, rgs.ErrSessionNotFound), errors.Is(err, rgs.ErrRoundNotFound):
		return http.StatusNotFound, "NOT_FOUND", "resource not found"
	case errors.Is(err, rgs.ErrSessionExpired):
		return http.StatusGone, "EXPIRED", "credential or session is expired"
	case errors.Is(err, rgs.ErrSessionExists), errors.Is(err, rgs.ErrIdempotencyConflict):
		return http.StatusConflict, "IDEMPOTENCY_CONFLICT", "request conflicts with existing state"
	case errors.Is(err, rgs.ErrRevisionConflict):
		return http.StatusConflict, "REVISION_CONFLICT", "session revision is stale"
	case errors.Is(err, rgs.ErrRoundPending):
		return http.StatusConflict, "ROUND_IN_PROGRESS", "another round is in progress"
	case errors.Is(err, rgs.ErrResultDeliveryPending):
		return http.StatusConflict, "RESULT_DELIVERY_PENDING", "a committed result must be acknowledged before the next spin"
	case errors.Is(err, rgs.ErrResultDeliveryNotFound):
		return http.StatusNotFound, "NOT_FOUND", "resource not found"
	case errors.Is(err, rgs.ErrResultDeliveryMismatch):
		return http.StatusConflict, "RESULT_DELIVERY_MISMATCH", "result delivery acknowledgement does not match"
	case errors.Is(err, rgs.ErrWalletPending):
		return http.StatusAccepted, "ROUND_PENDING", "round settlement is pending"
	case errors.Is(err, rgs.ErrWalletRejected), errors.Is(err, rgs.ErrRoundRejected):
		return http.StatusConflict, "ROUND_REJECTED", "round was rejected"
	case errors.Is(err, rgs.ErrManualReview), errors.Is(err, rgs.ErrSessionIntegrity),
		errors.Is(err, rgs.ErrWalletReceiptInvalid):
		return http.StatusLocked, "MANUAL_REVIEW", "session requires manual review"
	case errors.Is(err, rgs.ErrInvalidRequest):
		return http.StatusBadRequest, "INVALID_REQUEST", "request fields are invalid"
	case isDatabaseTimeout(err), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "service is temporarily unavailable"
	default:
		return http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error"
	}
}

func isDatabaseTimeout(err error) bool {
	var state interface{ SQLState() string }
	if !errors.As(err, &state) {
		return false
	}
	return state.SQLState() == "55P03" || state.SQLState() == "57014"
}

func decodeStrictJSON(encoded []byte, target any) error {
	if err := validateJSONShape(encoded, reflect.TypeOf(target)); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func validateJSONShape(encoded []byte, targetType reflect.Type) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	keys, err := consumeJSONObject(decoder, 1)
	if err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	allowed := jsonFieldNames(targetType)
	for key := range keys {
		if _, exists := allowed[key]; !exists {
			return fmt.Errorf("unknown JSON field %q", key)
		}
	}
	return nil
}

func consumeJSONObject(decoder *json.Decoder, depth int) (map[string]struct{}, error) {
	// 在读取对象并创建去重映射之前先卡住深度，避免小请求构造数千层递归与分配。
	if depth > maximumRequestJSONNestingDepth {
		return nil, errors.New("maximum JSON nesting depth exceeded")
	}
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("JSON body must be an object")
	}
	keys := make(map[string]struct{})
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("JSON object key must be a string")
		}
		if _, exists := keys[key]; exists {
			return nil, fmt.Errorf("duplicate JSON field %q", key)
		}
		keys[key] = struct{}{}
		if err := consumeJSONValue(decoder, depth+1); err != nil {
			return nil, err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, errors.New("invalid JSON object")
	}
	return keys, nil
}

func consumeJSONValue(decoder *json.Decoder, depth int) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	// 标量不增加容器深度；对象或数组则必须在任何逐层映射分配与递归前拒绝。
	if depth > maximumRequestJSONNestingDepth {
		return errors.New("maximum JSON nesting depth exceeded")
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key must be a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON field %q", key)
			}
			seen[key] = struct{}{}
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("invalid JSON object")
		}
		return nil
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("invalid JSON array")
		}
		return nil
	default:
		return errors.New("invalid JSON delimiter")
	}
}

func jsonFieldNames(targetType reflect.Type) map[string]struct{} {
	for targetType.Kind() == reflect.Pointer {
		targetType = targetType.Elem()
	}
	fields := make(map[string]struct{})
	if targetType.Kind() != reflect.Struct {
		return fields
	}
	for index := 0; index < targetType.NumField(); index++ {
		field := targetType.Field(index)
		if field.Anonymous && field.Tag.Get("json") == "" {
			for name := range jsonFieldNames(field.Type) {
				fields[name] = struct{}{}
			}
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			fields[name] = struct{}{}
		}
	}
	return fields
}

func singleExactHeader(header http.Header, name, expected string) bool {
	values := header.Values(name)
	return len(values) == 1 && values[0] == expected
}

func bearerToken(header http.Header) (string, error) {
	values := header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", errors.New("missing bearer token")
	}
	token := strings.TrimPrefix(values[0], "Bearer ")
	if token == "" || len(token) > operator.MaximumCompactTokenBytes || strings.ContainsAny(token, " \t\r\n") {
		return "", errors.New("invalid bearer token")
	}
	return token, nil
}

func parseCanonicalPositiveInt64(value string) (int64, error) {
	if value == "" || value[0] == '+' || (len(value) > 1 && value[0] == '0') {
		return 0, errors.New("invalid integer")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 || strconv.FormatInt(parsed, 10) != value {
		return 0, errors.New("invalid positive integer")
	}
	return parsed, nil
}

func parseCanonicalUint64(value string, maximum uint64) (uint64, error) {
	if value == "" || value[0] == '+' || (len(value) > 1 && value[0] == '0') {
		return 0, errors.New("invalid unsigned integer")
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed > maximum || strconv.FormatUint(parsed, 10) != value {
		return 0, errors.New("invalid unsigned integer")
	}
	return parsed, nil
}

func randomRequestID() string {
	var raw [16]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "req_unavailable"
	}
	return "req_" + hex.EncodeToString(raw[:])
}

func isOperatorRoute(request *http.Request) bool {
	if request == nil || request.URL == nil {
		return false
	}
	return strings.HasPrefix(request.URL.Path, "/operator/")
}

func (h *Handler) flushSignedOperatorResponse(writer http.ResponseWriter, request *http.Request, buffered *bufferedResponseWriter) {
	status := buffered.StatusCode()
	body := append([]byte(nil), buffered.body.Bytes()...)
	operatorID := claimedOperatorID(request)
	ctx := context.Background()
	if request != nil {
		// 业务请求超时后，运营商响应仍必须保持签名。保留请求值但不继承取消信号；
		// 独立短截止时间防止密钥解析器无限延长失败响应路径。
		ctx = context.WithoutCancel(request.Context())
	}
	ctx, cancel := context.WithTimeout(ctx, responseSigningLookupTimeout)
	defer cancel()
	key, err := h.responseSigningKeys.ResolveResponseSigningKey(ctx, operatorID)
	if err != nil || key.OperatorID != operatorID {
		h.writeUnsignedSigningFailure(writer, buffered.Header().Get(operator.HeaderRequestID))
		return
	}
	created := h.now().UTC().Truncate(time.Second)
	expires := created.Add(h.responseSignatureTTL)
	if key.NotAfter.Before(expires) {
		expires = key.NotAfter
	}
	response := &http.Response{StatusCode: status, Header: buffered.Header().Clone()}
	if err := operator.SignResponse(response, body, key, operator.ResponseSignatureParams{
		RequestID: response.Header.Get(operator.HeaderRequestID),
		Created:   created, Expires: expires,
	}); err != nil {
		h.writeUnsignedSigningFailure(writer, buffered.Header().Get(operator.HeaderRequestID))
		return
	}
	copyHeaders(writer.Header(), response.Header)
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

func (h *Handler) writeUnsignedSigningFailure(writer http.ResponseWriter, requestID string) {
	if !apiIdentifierPattern.MatchString(requestID) {
		requestID = randomRequestID()
	}
	// 签名失败时拒绝释放原运营商响应。此最小传输错误因没有可用租户密钥而无法签名，
	// 且不得包含适配器或认证细节。
	encoded, _ := json.Marshal(errorEnvelope{
		Error:     errorBody{Code: "RESPONSE_SIGNING_UNAVAILABLE", Message: "service is temporarily unavailable"},
		RequestID: requestID,
	})
	writer.Header().Set("Content-Type", operator.SignedContentType)
	writer.Header().Set(operator.HeaderRequestID, requestID)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(http.StatusServiceUnavailable)
	_, _ = writer.Write(append(encoded, '\n'))
}

func claimedOperatorID(request *http.Request) string {
	if request == nil {
		return ""
	}
	values := request.Header.Values(operator.HeaderOperatorID)
	if len(values) != 1 || !apiIdentifierPattern.MatchString(values[0]) {
		return ""
	}
	return values[0]
}

func copyHeaders(target, source http.Header) {
	for name := range target {
		delete(target, name)
	}
	for name, values := range source {
		for _, value := range values {
			target.Add(name, value)
		}
	}
}

type bufferedResponseWriter struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newBufferedResponseWriter() *bufferedResponseWriter {
	return &bufferedResponseWriter{header: make(http.Header)}
}

func (w *bufferedResponseWriter) Header() http.Header {
	return w.header
}

func (w *bufferedResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
}

func (w *bufferedResponseWriter) Write(encoded []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(encoded)
}

func (w *bufferedResponseWriter) StatusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (w *bufferedResponseWriter) Reset() {
	w.header = make(http.Header)
	w.body.Reset()
	w.status = 0
}
