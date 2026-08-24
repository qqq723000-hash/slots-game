package application

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/rgs"
	"slots-game/server/internal/rgsapi"
)

func TestLaunchManagerIdempotentlyCreatesAndExchangesOnce(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signing := operator.SigningKey{
		KeyID: "access-operator-a", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeAccessToken, PrivateKey: privateKey,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}
	issuer, err := operator.NewAccessTokenIssuer(signing, operator.AccessTokenIssuerOptions{
		Issuer: "rgs-test", Audience: "game-client",
		Now: func() time.Time { return now }, MaxLifetime: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	repository := rgs.NewMemoryRepository()
	launchService, err := launch.NewService(launch.NewMemoryStore(), launch.Options{TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	manager, err := NewLaunchManager(LaunchManagerConfig{
		PublicBaseURL: "https://rgs.example", LaunchHMACKey: []byte(strings.Repeat("k", 32)),
		AccessTokenTTL: 15 * time.Minute, GameID: "iron-colossus",
		DefinitionVersion: "math-v1", DefinitionHash: hash,
		Now: func() time.Time { return now },
	}, repository, launchService, map[string]*operator.AccessTokenIssuer{"operator-a": issuer})
	if err != nil {
		t.Fatal(err)
	}
	command := rgsapi.LaunchCommand{
		OperatorID: "operator-a", RequestID: "request-1",
		IdempotencyKey: "session-1", SessionID: "session-1",
		PlayerID: "player-1", WalletAccountID: "wallet-account-1",
		WalletSessionID: "wallet-session-1", GameID: "iron-colossus",
		DefinitionVersion: "math-v1", DefinitionHash: hash,
		Currency: "EUR", CurrencyExponent: 2, Jurisdiction: "MT",
		BalanceMinor: 10_000, SessionTTL: time.Hour, IdleDisconnect: 20 * time.Minute,
	}
	first, err := manager.CreateLaunch(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := manager.CreateLaunch(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first != replayed || first.LaunchCode == "" {
		t.Fatalf("launch replay differs: %+v %+v", first, replayed)
	}
	changed := command
	changed.BalanceMinor++
	if _, err := manager.CreateLaunch(context.Background(), changed); !errors.Is(err, rgs.ErrIdempotencyConflict) {
		t.Fatalf("changed launch error = %v", err)
	}

	// 模拟应用 Pod 时钟比存储时钟快两小时；按存储库时钟，持久会话仍有近一小时。
	// exchange/relaunch 不得因偏移的进程时钟烧掉 launch code 并错误拒绝。
	now = now.Add(2 * time.Hour)
	exchanged, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
		LaunchCode: first.LaunchCode, OperatorID: command.OperatorID,
		SessionID: command.SessionID, RequestID: "exchange-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.BalanceMinor != command.BalanceMinor || exchanged.AccessToken == "" {
		t.Fatalf("exchange = %+v", exchanged)
	}
	if !exchanged.Session.ServerTime.Before(now) {
		t.Fatalf("test did not exercise a fast Pod clock: server=%s pod=%s", exchanged.Session.ServerTime, now)
	}
	ring, err := operator.NewMemoryKeyRing(operator.VerificationKey{
		KeyID: signing.KeyID, OperatorID: signing.OperatorID,
		Purpose: operator.KeyPurposeAccessToken, PublicKey: publicKey,
		NotBefore: signing.NotBefore, NotAfter: signing.NotAfter,
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := operator.NewAccessTokenVerifier(ring, operator.AccessTokenVerifierOptions{
		ExpectedIssuer: "rgs-test", ExpectedAudience: "game-client",
		Now: func() time.Time { return now }, MaxLifetime: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := verifier.Verify(context.Background(), exchanged.AccessToken, "operator-a")
	if err != nil {
		t.Fatal(err)
	}
	if claims.GameDefinitionHash != hash || claims.SessionID != command.SessionID {
		t.Fatalf("token claims = %+v", claims)
	}
	if claims.TransportGeneration != exchanged.Session.TransportGeneration ||
		claims.TransportGeneration < 2 || exchanged.Session.IdleDisconnectAt.IsZero() {
		t.Fatalf("exchange transport fencing = claims:%+v session:%+v", claims, exchanged.Session)
	}
	refreshed, err := manager.RefreshSession(context.Background(), rgsapi.RefreshCommand{
		Claims: claims, RequestID: "refresh-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken == exchanged.AccessToken {
		t.Fatal("refresh did not rotate the access token")
	}
	refreshedClaims, err := verifier.Verify(context.Background(), refreshed.AccessToken, "operator-a")
	if err != nil {
		t.Fatal(err)
	}
	if refreshedClaims.SessionID != claims.SessionID ||
		refreshedClaims.GameDefinitionHash != claims.GameDefinitionHash ||
		refreshedClaims.TokenID == claims.TokenID ||
		refreshedClaims.TransportGeneration != claims.TransportGeneration {
		t.Fatalf("refreshed token claims = %+v, previous = %+v", refreshedClaims, claims)
	}
	if _, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
		LaunchCode: first.LaunchCode, OperatorID: command.OperatorID,
		SessionID: command.SessionID, RequestID: "exchange-2",
	}); !errors.Is(err, rgsapi.ErrLaunchUnavailable) {
		t.Fatalf("second exchange error = %v", err)
	}
	consumedReplay, err := manager.CreateLaunch(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if consumedReplay != first {
		t.Fatalf("consumed handoff replay differs: %+v %+v", first, consumedReplay)
	}

	relaunchCommand := command
	relaunchCommand.RequestID = "request-2"
	relaunchCommand.IdempotencyKey = "handoff-2"
	relaunchCommand.BalanceMinor = command.BalanceMinor + 50_000
	relaunchCommand.SessionTTL = 2 * time.Hour
	relaunched, err := manager.CreateLaunch(context.Background(), relaunchCommand)
	if err != nil {
		t.Fatal(err)
	}
	relaunchReplay, err := manager.CreateLaunch(context.Background(), relaunchCommand)
	if err != nil {
		t.Fatal(err)
	}
	if relaunched != relaunchReplay {
		t.Fatalf("relaunch replay differs: %+v %+v", relaunched, relaunchReplay)
	}
	if relaunched.LaunchCode == first.LaunchCode {
		t.Fatal("new handoff reused the consumed launch code")
	}
	if _, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
		LaunchCode: relaunched.LaunchCode, OperatorID: command.OperatorID,
		SessionID: "session-other", RequestID: "exchange-wrong-binding",
	}); !errors.Is(err, rgsapi.ErrLaunchUnavailable) {
		t.Fatalf("relaunch binding mismatch error = %v", err)
	}
	relaunchedSession, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
		LaunchCode: relaunched.LaunchCode, OperatorID: command.OperatorID,
		SessionID: command.SessionID, RequestID: "exchange-3",
	})
	if err != nil {
		t.Fatal(err)
	}
	if relaunchedSession.Session.SessionID != exchanged.Session.SessionID ||
		relaunchedSession.Session.Revision != exchanged.Session.Revision ||
		relaunchedSession.Session.Feature != exchanged.Session.Feature ||
		relaunchedSession.Session.BalanceMinor != exchanged.Session.BalanceMinor ||
		!relaunchedSession.Session.ExpiresAt.Equal(exchanged.Session.ExpiresAt) {
		t.Fatalf("relaunch changed durable session: before=%+v after=%+v", exchanged.Session, relaunchedSession.Session)
	}
	if relaunchedSession.Session.TransportGeneration != exchanged.Session.TransportGeneration+1 {
		t.Fatalf("relaunch generation = %d, want %d", relaunchedSession.Session.TransportGeneration, exchanged.Session.TransportGeneration+1)
	}
	if _, err := manager.AuthorizeSession(context.Background(), rgsapi.SessionAuthorizationCommand{
		Claims: claims, AllowIdleRecovery: true,
	}); !errors.Is(err, rgs.ErrSessionTimeout) {
		t.Fatalf("old transport generation authorization = %v, want session timeout", err)
	}
	if _, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
		LaunchCode: relaunched.LaunchCode, OperatorID: command.OperatorID,
		SessionID: command.SessionID, RequestID: "exchange-4",
	}); !errors.Is(err, rgsapi.ErrLaunchUnavailable) {
		t.Fatalf("second relaunched exchange error = %v", err)
	}
}

func TestLaunchManagerRejectsUnapprovedDefinition(t *testing.T) {
	_, err := NewLaunchManager(LaunchManagerConfig{
		PublicBaseURL: "https://rgs.example", LaunchHMACKey: []byte(strings.Repeat("k", 32)),
		AccessTokenTTL: time.Minute, GameID: "game", DefinitionVersion: "math-v1",
		DefinitionHash: "invalid",
	}, rgs.NewMemoryRepository(), mustLaunchService(t), map[string]*operator.AccessTokenIssuer{
		"operator": nil,
	})
	if err == nil {
		t.Fatal("invalid definition unexpectedly accepted")
	}
}

func mustLaunchService(t *testing.T) *launch.Service {
	t.Helper()
	service, err := launch.NewService(launch.NewMemoryStore(), launch.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return service
}
