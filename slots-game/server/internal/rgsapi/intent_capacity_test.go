package rgsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
)

type recordingIntentCapacity struct {
	decision AdmissionDecision
	active   int
	maximum  int
	calls    int
	releases int
}

func (capacity *recordingIntentCapacity) TryAcquire(context.Context) (func(), AdmissionResult) {
	capacity.calls++
	if capacity.decision != AdmissionAllowed {
		return nil, AdmissionResult{Decision: capacity.decision}
	}
	capacity.active++
	if capacity.active > capacity.maximum {
		capacity.maximum = capacity.active
	}
	return func() {
		capacity.active--
		capacity.releases++
	}, AdmissionResult{Decision: AdmissionAllowed}
}

func TestNewIntentCapacityRejectsOnlyNewSessionAndEconomicIntentsAndReleasesPermits(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &recordingIntentCapacity{decision: AdmissionCapacityUnavailable}
	pendingCalls := 0
	acknowledgementCalls := 0
	launches := &fakeLaunchService{
		exchange: func(context.Context, ExchangeCommand) (ExchangeResult, error) {
			t.Fatal("capacity-rejected request reached session exchange service")
			return ExchangeResult{}, nil
		},
		refresh: func(context.Context, RefreshCommand) (ExchangeResult, error) {
			return ExchangeResult{}, ErrUnavailable
		},
	}
	spins := &fakeCoordinator{
		spin: func(context.Context, rgs.SpinRequest) (rgs.SpinResult, error) {
			t.Fatal("capacity-rejected request reached spin coordinator")
			return rgs.SpinResult{}, nil
		},
		pending: func(context.Context, string, string) (rgs.ResultDelivery, error) {
			pendingCalls++
			return rgs.ResultDelivery{}, rgs.ErrResultDeliveryNotFound
		},
		acknowledge: func(context.Context, rgs.ResultDeliveryAcknowledgement) (rgs.ResultDelivery, bool, error) {
			acknowledgementCalls++
			return rgs.ResultDelivery{}, false, rgs.ErrResultDeliveryNotFound
		},
	}
	rounds := &fakeRoundReader{}
	handler := security.newHandler(t, launches, spins, rounds)
	handler.newIntentCapacity = capacity

	launchRecorder := httptest.NewRecorder()
	handler.ServeHTTP(launchRecorder, security.signOperatorRequest(
		t, OperatorLaunchPath, operatorLaunchBody("12500"),
	))
	if launchRecorder.Code != http.StatusServiceUnavailable ||
		launchRecorder.Header().Get("Retry-After") != "1" ||
		!strings.Contains(launchRecorder.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) ||
		launches.createCalls != 0 {
		t.Fatalf("launch capacity response = status:%d retry:%q calls:%d body:%s",
			launchRecorder.Code, launchRecorder.Header().Get("Retry-After"),
			launches.createCalls, launchRecorder.Body.String())
	}

	token := security.issueAccessTokenForSession(t, testSessionID, testDefinitionHash)
	spinRecorder := httptest.NewRecorder()
	handler.ServeHTTP(spinRecorder, clientRequest(ClientSpinPath, clientSpinBody(testDefinitionHash), token))
	if spinRecorder.Code != http.StatusServiceUnavailable || spins.calls != 0 {
		t.Fatalf("spin capacity response = status:%d calls:%d body:%s",
			spinRecorder.Code, spins.calls, spinRecorder.Body.String())
	}

	exchangeBody := []byte(`{"launchCode":"` + validTestLaunchCode(31) + `","operatorId":"operator-a","sessionId":"session-a"}`)
	exchangeRecorder := httptest.NewRecorder()
	handler.ServeHTTP(exchangeRecorder, clientRequest(ClientSessionExchangePath, exchangeBody, ""))
	if exchangeRecorder.Code != http.StatusServiceUnavailable ||
		exchangeRecorder.Header().Get("Retry-After") != "1" ||
		!strings.Contains(exchangeRecorder.Body.String(), `"code":"CAPACITY_UNAVAILABLE"`) ||
		launches.exchangeCalls != 0 {
		t.Fatalf("exchange capacity response = status:%d retry:%q calls:%d body:%s",
			exchangeRecorder.Code, exchangeRecorder.Header().Get("Retry-After"),
			launches.exchangeCalls, exchangeRecorder.Body.String())
	}

	statusRecorder := httptest.NewRecorder()
	handler.ServeHTTP(statusRecorder, clientRequest(ClientRoundStatusPath, roundStatusBody(), token))
	if rounds.calls != 1 {
		t.Fatalf("status route consumed new-intent capacity: calls=%d status=%d body=%s",
			capacity.calls, statusRecorder.Code, statusRecorder.Body.String())
	}

	sessionStatusRecorder := httptest.NewRecorder()
	handler.ServeHTTP(sessionStatusRecorder, clientRequest(
		ClientSessionStatusPath, sessionBindingBody(testDefinitionHash), token,
	))
	if sessionStatusRecorder.Code != http.StatusOK {
		t.Fatalf("session status route consumed new-intent capacity: calls=%d status=%d body=%s",
			capacity.calls, sessionStatusRecorder.Code, sessionStatusRecorder.Body.String())
	}

	refreshRecorder := httptest.NewRecorder()
	handler.ServeHTTP(refreshRecorder, clientRequest(ClientSessionRefreshPath, sessionBindingBody(testDefinitionHash), token))
	if launches.refreshCalls != 1 {
		t.Fatalf("refresh route consumed new-intent capacity: calls=%d status=%d body=%s",
			capacity.calls, refreshRecorder.Code, refreshRecorder.Body.String())
	}

	pendingRequest := httptest.NewRequest(http.MethodGet, "https://rgs.example"+ClientPendingResultPath, nil)
	pendingRequest.Header.Set(operator.HeaderOperatorID, testOperatorID)
	pendingRequest.Header.Set("Authorization", "Bearer "+token)
	pendingRecorder := httptest.NewRecorder()
	handler.ServeHTTP(pendingRecorder, pendingRequest)
	if pendingCalls != 1 || pendingRecorder.Code != http.StatusNoContent {
		t.Fatalf("pending route did not bypass new-intent capacity: calls=%d status=%d body=%s",
			pendingCalls, pendingRecorder.Code, pendingRecorder.Body.String())
	}

	acknowledgementBody, _ := json.Marshal(map[string]any{
		"operatorId": testOperatorID, "sessionId": testSessionID,
		"gameId": testGameID, "definitionVersion": testDefinition,
		"definitionHash": testDefinitionHash, "currency": testCurrency,
		"currencyExponent": 2, "jurisdiction": testRegion,
		"roundId": "round-a", "sequence": "1", "resultHash": strings.Repeat("b", 64),
	})
	acknowledgementRecorder := httptest.NewRecorder()
	handler.ServeHTTP(acknowledgementRecorder, clientRequest(ClientResultAckPath, acknowledgementBody, token))
	if acknowledgementCalls != 1 {
		t.Fatalf("ack route did not bypass new-intent capacity: calls=%d status=%d body=%s",
			acknowledgementCalls, acknowledgementRecorder.Code, acknowledgementRecorder.Body.String())
	}
	if capacity.calls != 3 || capacity.active != 0 || capacity.releases != 0 {
		t.Fatalf("capacity calls=%d active=%d releases=%d", capacity.calls, capacity.active, capacity.releases)
	}
}

func TestNewIntentCapacityPermitCoversSessionExchangeAndIsReleased(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &recordingIntentCapacity{decision: AdmissionAllowed}
	launches := &fakeLaunchService{exchange: func(context.Context, ExchangeCommand) (ExchangeResult, error) {
		if capacity.active != 1 {
			t.Fatalf("capacity was not held during session exchange: active=%d", capacity.active)
		}
		return ExchangeResult{}, ErrUnavailable
	}}
	handler := security.newHandler(t, launches, &fakeCoordinator{}, &fakeRoundReader{})
	handler.newIntentCapacity = capacity
	body := []byte(`{"launchCode":"` + validTestLaunchCode(32) + `","operatorId":"operator-a","sessionId":"session-a"}`)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, clientRequest(ClientSessionExchangePath, body, ""))

	if recorder.Code != http.StatusServiceUnavailable || launches.exchangeCalls != 1 ||
		capacity.calls != 1 || capacity.releases != 1 || capacity.active != 0 || capacity.maximum != 1 {
		t.Fatalf("exchange permit lifecycle = status:%d service-calls:%d capacity-calls:%d releases:%d active:%d max:%d body:%s",
			recorder.Code, launches.exchangeCalls, capacity.calls, capacity.releases,
			capacity.active, capacity.maximum, recorder.Body.String())
	}
}

func TestNewIntentCapacityPermitCoversCoordinatorAndIsReleased(t *testing.T) {
	security := newSecurityFixture(t)
	capacity := &recordingIntentCapacity{decision: AdmissionAllowed}
	spins := &fakeCoordinator{spin: func(_ context.Context, request rgs.SpinRequest) (rgs.SpinResult, error) {
		if capacity.active != 1 {
			t.Fatalf("capacity was not held during spin: active=%d", capacity.active)
		}
		return committedResult(request), nil
	}}
	handler := security.newHandler(t, &fakeLaunchService{}, spins, &fakeRoundReader{})
	handler.newIntentCapacity = capacity
	token := security.issueAccessTokenForSession(t, testSessionID, testDefinitionHash)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, clientRequest(ClientSpinPath, clientSpinBody(testDefinitionHash), token))
	if recorder.Code != http.StatusOK || capacity.calls != 1 || capacity.releases != 1 ||
		capacity.active != 0 || capacity.maximum != 1 {
		t.Fatalf("permit lifecycle = status:%d calls:%d releases:%d active:%d max:%d body:%s",
			recorder.Code, capacity.calls, capacity.releases, capacity.active, capacity.maximum,
			recorder.Body.String())
	}
}
