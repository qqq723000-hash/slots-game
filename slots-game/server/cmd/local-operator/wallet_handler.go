package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"slots-game/server/internal/operator"
)

const maxWalletRequestBytes int64 = 64 << 10

type walletStore interface {
	Apply(context.Context, validatedRound) (storedOperation, error)
	Lookup(context.Context, string, string) (storedOperation, bool, error)
	LookupRejection(context.Context, string, string) (storedRejection, bool, error)
	Rollback(context.Context, validatedRollback) (storedOperation, error)
	EnsureAccount(context.Context, accountSeed) error
	RegisterWalletSession(context.Context, walletSessionSeed) error
	Ping(context.Context) error
}

type serviceMetrics struct {
	requests        atomic.Uint64
	failures        atomic.Uint64
	authFailures    atomic.Uint64
	walletApplies   atomic.Uint64
	walletLookups   atomic.Uint64
	walletRollbacks atomic.Uint64
	launches        atomic.Uint64
	auditAccepted   atomic.Uint64
	logBatches      atomic.Uint64
	alertAccepted   atomic.Uint64
	alertRejected   atomic.Uint64
	active          atomic.Int64
}

type walletHandlerConfig struct {
	OperatorID         string
	Store              walletStore
	Verifier           *operator.RequestVerifier
	ResponseSigningKey operator.SigningKey
	AllowLegacyV1      bool
	Now                func() time.Time
	Metrics            *serviceMetrics
}

type walletHandler struct {
	operatorID    string
	store         walletStore
	verifier      *operator.RequestVerifier
	signing       operator.SigningKey
	allowLegacyV1 bool
	now           func() time.Time
	metrics       *serviceMetrics
}

func newWalletHandler(config walletHandlerConfig) http.Handler {
	if config.Now == nil {
		config.Now = time.Now
	}
	return &walletHandler{
		operatorID: config.OperatorID, store: config.Store, verifier: config.Verifier,
		signing: config.ResponseSigningKey, allowLegacyV1: config.AllowLegacyV1,
		now: config.Now, metrics: config.Metrics,
	}
}

func (h *walletHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request == nil || request.URL == nil || request.Method != http.MethodPost ||
		request.URL.RawQuery != "" || request.URL.RawPath != "" {
		h.write(writer, request, http.StatusNotFound, walletResponse{Status: "REJECTED", Code: "NOT_FOUND"})
		return
	}
	if request.Header.Get("Content-Type") != operator.SignedContentType || request.Header.Get("Content-Encoding") != "" {
		h.write(writer, request, http.StatusUnsupportedMediaType, walletResponse{Status: "REJECTED", Code: "UNSUPPORTED_MEDIA_TYPE"})
		return
	}
	body, err := readBoundedBody(request.Body, maxWalletRequestBytes)
	if err != nil {
		h.write(writer, request, http.StatusBadRequest, walletResponse{Status: "REJECTED", Code: "INVALID_REQUEST"})
		return
	}
	verified, err := h.verifier.Authenticate(request.Context(), request, body)
	if err != nil || verified.OperatorID != h.operatorID {
		h.metrics.authFailures.Add(1)
		h.write(writer, request, http.StatusUnauthorized, walletResponse{Status: "REJECTED", Code: "AUTHENTICATION_FAILED"})
		return
	}
	if err := h.verifier.ConsumeNonce(request.Context(), verified); err != nil {
		h.metrics.authFailures.Add(1)
		h.write(writer, request, http.StatusUnauthorized, walletResponse{Status: "REJECTED", Code: "REPLAY_REJECTED"})
		return
	}

	switch request.URL.Path {
	case "/rgs/wallet/v1/rounds/apply":
		h.handleApply(writer, request, verified, body)
	case "/rgs/wallet/v1/transactions/status":
		h.handleLookup(writer, request, verified, body)
	case "/rgs/wallet/v1/transactions/rollback":
		h.handleRollback(writer, request, verified, body)
	default:
		h.write(writer, request, http.StatusNotFound, walletResponse{Status: "REJECTED", Code: "NOT_FOUND"})
	}
}

func (h *walletHandler) handleApply(
	writer http.ResponseWriter,
	request *http.Request,
	verified operator.VerifiedRequest,
	body []byte,
) {
	var payload roundRequest
	if decodeStrictJSON(body, &payload) != nil || payload.OperatorID != verified.OperatorID ||
		payload.OperationID != verified.IdempotencyKey {
		h.write(writer, request, http.StatusConflict, walletResponse{Status: "CONFLICT", Code: "INVALID_REQUEST_BINDING"})
		return
	}
	validated, err := validateRoundWithPolicy(payload, body, h.allowLegacyV1)
	if err != nil {
		h.write(writer, request, http.StatusConflict, walletResponse{Status: "CONFLICT", Code: "INVALID_COMMAND_BINDING"})
		return
	}
	operation, err := h.store.Apply(request.Context(), validated)
	if err != nil {
		h.writeApplyError(writer, request, validated, err)
		return
	}
	h.metrics.walletApplies.Add(1)
	h.write(writer, request, http.StatusOK, operationResponse("SUCCEEDED", operation))
}

func (h *walletHandler) handleLookup(
	writer http.ResponseWriter,
	request *http.Request,
	verified operator.VerifiedRequest,
	body []byte,
) {
	var payload lookupRequest
	if decodeStrictJSON(body, &payload) != nil || validateLookup(payload) != nil ||
		payload.OperatorID != verified.OperatorID || payload.OperationID != verified.IdempotencyKey {
		h.write(writer, request, http.StatusConflict, walletResponse{Status: "CONFLICT", Code: "INVALID_REQUEST_BINDING"})
		return
	}
	operation, found, err := h.store.Lookup(request.Context(), payload.OperatorID, payload.OperationID)
	if err != nil {
		h.writeStoreError(writer, request, err)
		return
	}
	if found {
		if lookupUsesV2Binding(payload) &&
			(operation.Fingerprint != payload.Fingerprint || operation.CommandDigest != payload.CommandDigest) {
			h.write(writer, request, http.StatusConflict, walletResponse{Status: "CONFLICT", Code: "IDEMPOTENCY_CONFLICT"})
			return
		}
		h.metrics.walletLookups.Add(1)
		status := "SUCCEEDED"
		if operation.RolledBack {
			status = "ROLLED_BACK"
		}
		h.write(writer, request, http.StatusOK, operationResponse(status, operation))
		return
	}
	rejection, found, err := h.store.LookupRejection(
		request.Context(), payload.OperatorID, payload.OperationID,
	)
	if err != nil {
		h.writeStoreError(writer, request, err)
		return
	}
	h.metrics.walletLookups.Add(1)
	if found {
		if lookupUsesV2Binding(payload) &&
			(rejection.Fingerprint != payload.Fingerprint || rejection.CommandDigest != payload.CommandDigest) {
			h.write(writer, request, http.StatusConflict, walletResponse{Status: "CONFLICT", Code: "IDEMPOTENCY_CONFLICT"})
			return
		}
		h.write(writer, request, http.StatusUnprocessableEntity, walletResponse{
			Status: "REJECTED", Code: rejection.Code, OperationID: rejection.OperationID,
			Fingerprint: rejection.Fingerprint, OperatorID: rejection.OperatorID,
			CommandDigest: rejection.CommandDigest,
		})
		return
	}
	response := walletResponse{Status: "NOT_FOUND", Code: "OPERATION_NOT_FOUND"}
	if lookupUsesV2Binding(payload) {
		response.OperatorID = payload.OperatorID
		response.OperationID = payload.OperationID
		response.Fingerprint = payload.Fingerprint
		response.CommandDigest = payload.CommandDigest
	}
	h.write(writer, request, http.StatusNotFound, response)
}

func (h *walletHandler) handleRollback(
	writer http.ResponseWriter,
	request *http.Request,
	verified operator.VerifiedRequest,
	body []byte,
) {
	var payload rollbackRequest
	validated, validationErr := validateRollback(payload)
	if decodeStrictJSON(body, &payload) != nil {
		validationErr = errors.New("invalid JSON")
	} else {
		validated, validationErr = validateRollback(payload)
	}
	if validationErr != nil || payload.OperatorID != verified.OperatorID ||
		payload.RollbackID != verified.IdempotencyKey {
		h.write(writer, request, http.StatusBadRequest, walletResponse{Status: "REJECTED", Code: "INVALID_REQUEST"})
		return
	}
	operation, err := h.store.Rollback(request.Context(), validated)
	if err != nil {
		h.writeStoreError(writer, request, err)
		return
	}
	h.metrics.walletRollbacks.Add(1)
	response := operationResponse("ROLLED_BACK", operation)
	response.RollbackID = payload.RollbackID
	h.write(writer, request, http.StatusOK, response)
}

func (h *walletHandler) writeStoreError(writer http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, errIdempotencyConflict), errors.Is(err, errAlreadyRolledBack):
		h.write(writer, request, http.StatusConflict, walletResponse{Status: "CONFLICT", Code: "IDEMPOTENCY_CONFLICT"})
	case errors.Is(err, errInsufficientFunds):
		h.write(writer, request, http.StatusUnprocessableEntity, walletResponse{Status: "REJECTED", Code: "INSUFFICIENT_FUNDS"})
	case errors.Is(err, errWalletSessionInvalid):
		h.write(writer, request, http.StatusUnprocessableEntity, walletResponse{Status: "REJECTED", Code: "WALLET_SESSION_INVALID"})
	case errors.Is(err, errOperationNotFound), errors.Is(err, errAccountNotFound):
		h.write(writer, request, http.StatusUnprocessableEntity, walletResponse{Status: "REJECTED", Code: "NOT_FOUND"})
	default:
		h.write(writer, request, http.StatusServiceUnavailable, walletResponse{Status: "PENDING", Code: "STORE_UNAVAILABLE"})
	}
}

func (h *walletHandler) writeApplyError(
	writer http.ResponseWriter,
	request *http.Request,
	command validatedRound,
	err error,
) {
	if code, terminal := rejectionCode(err); terminal {
		h.write(writer, request, http.StatusUnprocessableEntity, walletResponse{
			Status: "REJECTED", Code: code, OperationID: command.OperationID,
			Fingerprint: command.Fingerprint, OperatorID: command.OperatorID,
			CommandDigest: command.CommandDigest,
		})
		return
	}
	h.writeStoreError(writer, request, err)
}

func (h *walletHandler) write(writer http.ResponseWriter, request *http.Request, status int, payload walletResponse) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		status = http.StatusInternalServerError
		encoded = []byte(`{"status":"PENDING","code":"ENCODING_FAILED"}`)
	}
	requestID := "invalid-request"
	if request != nil && identifierPattern.MatchString(request.Header.Get(operator.HeaderRequestID)) {
		requestID = request.Header.Get(operator.HeaderRequestID)
	}
	response := &http.Response{StatusCode: status, Header: writer.Header()}
	now := h.now().UTC()
	if err := operator.SignResponse(response, encoded, h.signing, operator.ResponseSignatureParams{
		RequestID: requestID, Created: now, Expires: now.Add(time.Minute),
	}); err != nil {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte(`{"status":"PENDING","code":"RESPONSE_SIGNING_FAILED"}`))
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_, _ = writer.Write(encoded)
}

func readBoundedBody(body io.ReadCloser, maximum int64) ([]byte, error) {
	if body == nil {
		return nil, errors.New("request body is required")
	}
	defer body.Close()
	encoded, err := io.ReadAll(io.LimitReader(body, maximum+1))
	if err != nil || int64(len(encoded)) > maximum || len(encoded) == 0 {
		return nil, errors.New("request body is invalid")
	}
	return encoded, nil
}

func decodeStrictJSON(encoded []byte, target any) error {
	shape := json.NewDecoder(bytes.NewReader(encoded))
	first, err := shape.Token()
	if err != nil || first != json.Delim('{') {
		return errors.New("JSON value must be an object")
	}
	if err := validateJSONObjectTokens(shape); err != nil {
		return err
	}
	if _, err := shape.Token(); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing values")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON contains trailing values")
	}
	return nil
}

func validateJSONObjectTokens(decoder *json.Decoder) error {
	seen := make(map[string]struct{})
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok {
			return errors.New("JSON object contains an invalid field")
		}
		if _, duplicate := seen[key]; duplicate {
			return errors.New("JSON object contains a duplicate field")
		}
		seen[key] = struct{}{}
		if err := validateJSONValueTokens(decoder); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return errors.New("JSON object is not closed")
	}
	return nil
}

func validateJSONValueTokens(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("JSON contains an invalid value")
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		return validateJSONObjectTokens(decoder)
	case '[':
		for decoder.More() {
			if err := validateJSONValueTokens(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("JSON array is not closed")
		}
		return nil
	default:
		return errors.New("JSON contains an unexpected delimiter")
	}
}
