package application

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/game"
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
	if first.LaunchCode == "" || replayed.LaunchCode != first.LaunchCode ||
		replayed.ExchangeURL != first.ExchangeURL || !replayed.ExpiresAt.Equal(first.ExpiresAt) ||
		replayed.HistoricalReplay != first.HistoricalReplay ||
		first.ValidatedAt.IsZero() || replayed.ValidatedAt.IsZero() {
		t.Fatalf("launch replay differs: %+v %+v", first, replayed)
	}
	changed := command
	changed.BalanceMinor++
	if _, err := manager.CreateLaunch(context.Background(), changed); !errors.Is(err, rgs.ErrIdempotencyConflict) {
		t.Fatalf("changed launch error = %v", err)
	}

	// 模拟应用 Pod 时钟比存储时钟快两小时；按存储库时钟，持久会话仍有近一小时。
	// exchange/relaunch 不得因偏移的进程时钟烧掉 launch code 并错误拒绝。
	// English: The simulated app pod clock is two hours ahead of the storage clock; by the repository clock, the
	// persistent session is still nearly an hour away. exchange/relaunch must not burn launch code and reject with
	// error due to offset process clock.
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
	verifyNow := exchanged.Session.ServerTime
	verifier, err := operator.NewAccessTokenVerifier(ring, operator.AccessTokenVerifierOptions{
		ExpectedIssuer: "rgs-test", ExpectedAudience: "game-client",
		Now: func() time.Time { return verifyNow }, MaxLifetime: time.Hour,
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
	if claims.IssuedAt != exchanged.Session.ServerTime.Truncate(time.Second).Unix() ||
		time.Unix(claims.ExpiresAt, 0).After(exchanged.Session.ExpiresAt) {
		t.Fatalf(
			"token did not use repository authority: claims=%+v session=%+v pod=%v",
			claims, exchanged.Session, now,
		)
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
	verifyNow = refreshed.Session.ServerTime
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
	if consumedReplay.LaunchCode != first.LaunchCode ||
		consumedReplay.ExchangeURL != first.ExchangeURL ||
		!consumedReplay.ExpiresAt.Equal(first.ExpiresAt) ||
		consumedReplay.HistoricalReplay != first.HistoricalReplay ||
		consumedReplay.ValidatedAt.IsZero() {
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
	if relaunchReplay.LaunchCode != relaunched.LaunchCode ||
		relaunchReplay.ExchangeURL != relaunched.ExchangeURL ||
		!relaunchReplay.ExpiresAt.Equal(relaunched.ExpiresAt) ||
		relaunchReplay.HistoricalReplay != relaunched.HistoricalReplay ||
		relaunched.ValidatedAt.IsZero() || relaunchReplay.ValidatedAt.IsZero() {
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

func TestLaunchManagerNewHandoffUsesAuthoritativeTerminalState(t *testing.T) {
	now := time.Now().UTC()
	tests := []struct {
		name      string
		status    rgs.SessionStatus
		expiresAt time.Time
		want      error
	}{
		{
			name: "active absolute expired", status: rgs.SessionActive,
			expiresAt: now.Add(-time.Minute), want: rgs.ErrSessionExpired,
		},
		{
			name: "blocked", status: rgs.SessionBlocked,
			expiresAt: now.Add(time.Hour), want: rgs.ErrManualReview,
		},
		{
			name: "closed", status: rgs.SessionClosed,
			expiresAt: now.Add(time.Hour), want: rgs.ErrSessionExpired,
		},
		{
			name: "expired status", status: rgs.SessionExpired,
			expiresAt: now.Add(-time.Minute), want: rgs.ErrSessionExpired,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := rgs.NewMemoryRepository()
			launchStore := launch.NewMemoryStore()
			manager, command := newRelaunchTestManager(t, repository, launchStore)
			session := relaunchTestSession(command, test.expiresAt, now.Add(-2*time.Minute))
			session.Status = test.status
			if err := repository.CreateSession(context.Background(), session); err != nil {
				t.Fatal(err)
			}

			if _, err := manager.CreateLaunch(context.Background(), command); !errors.Is(err, test.want) {
				t.Fatalf("new handoff error = %v, want %v", err, test.want)
			}
			code := manager.launchCode(command.OperatorID, command.SessionID, command.IdempotencyKey)
			digest := launch.CodeDigest(sha256.Sum256([]byte(code)))
			if _, err := launchStore.Get(
				context.Background(), digest,
			); !errors.Is(err, launch.ErrCodeUnavailable) {
				t.Fatalf("terminal new handoff persisted a launch code: %v", err)
			}
		})
	}
}

func TestLaunchManagerReplaysExactHandoffBeforeDurableStatusGates(t *testing.T) {
	now := time.Now().UTC()
	tests := []struct {
		name          string
		status        rgs.SessionStatus
		expiresAt     time.Time
		idleAt        time.Time
		exchangeError error
	}{
		{
			name: "active absolute expired", status: rgs.SessionActive,
			expiresAt: now.Add(-time.Minute), idleAt: now.Add(-2 * time.Minute),
			exchangeError: rgs.ErrSessionExpired,
		},
		{
			name: "blocked", status: rgs.SessionBlocked,
			expiresAt: now.Add(time.Hour), idleAt: now.Add(20 * time.Minute),
			exchangeError: rgsapi.ErrLaunchUnavailable,
		},
		{
			name: "closed", status: rgs.SessionClosed,
			expiresAt: now.Add(time.Hour), idleAt: now.Add(20 * time.Minute),
			exchangeError: rgsapi.ErrLaunchUnavailable,
		},
		{
			name: "expired status", status: rgs.SessionExpired,
			expiresAt: now.Add(-time.Minute), idleAt: now.Add(-2 * time.Minute),
			exchangeError: rgsapi.ErrLaunchUnavailable,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := rgs.NewMemoryRepository()
			launchStore := launch.NewMemoryStore()
			manager, command := newRelaunchTestManager(t, repository, launchStore)
			session := relaunchTestSession(command, test.expiresAt, test.idleAt)
			session.Status = test.status
			if err := repository.CreateSession(context.Background(), session); err != nil {
				t.Fatal(err)
			}
			claims := launch.Claims{
				OperatorID: command.OperatorID, SessionID: command.SessionID,
				PlayerID: command.PlayerID, WalletSessionID: command.WalletSessionID,
				GameID: command.GameID, DefinitionVersion: command.DefinitionVersion,
				DefinitionHash:     command.DefinitionHash,
				RequestFingerprint: launchRequestFingerprint(command),
				Currency:           command.Currency, CurrencyExponent: command.CurrencyExponent,
				Jurisdiction:          command.Jurisdiction,
				IdleDisconnectSeconds: int64(command.IdleDisconnect / time.Second),
			}
			code := manager.launchCode(command.OperatorID, command.SessionID, command.IdempotencyKey)
			original, err := manager.launches.IssueCode(context.Background(), claims, code)
			if err != nil {
				t.Fatal(err)
			}

			replayed, err := manager.CreateLaunch(context.Background(), command)
			if err != nil {
				t.Fatalf("durable status blocked exact handoff replay: %v", err)
			}
			if replayed.LaunchCode != original.Code || !replayed.ExpiresAt.Equal(original.ExpiresAt) {
				t.Fatalf("handoff replay = %+v, original = %+v", replayed, original)
			}

			changed := command
			changed.BalanceMinor++
			if _, err := manager.CreateLaunch(
				context.Background(), changed,
			); !errors.Is(err, rgs.ErrIdempotencyConflict) {
				t.Fatalf("changed claims error = %v, want ErrIdempotencyConflict", err)
			}
			if _, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
				LaunchCode: replayed.LaunchCode, OperatorID: command.OperatorID,
				SessionID: command.SessionID, RequestID: "exchange-terminal-replay",
			}); !errors.Is(err, test.exchangeError) {
				t.Fatalf("terminal replay exchange error = %v, want %v", err, test.exchangeError)
			}
		})
	}
}

func TestLaunchManagerExactReplaySurvivesDefinitionRotationWithoutCreatingSession(t *testing.T) {
	repository := rgs.NewMemoryRepository()
	launchStore := launch.NewMemoryStore()
	manager, command := newRelaunchTestManager(t, repository, launchStore)
	claims := launch.Claims{
		OperatorID: command.OperatorID, SessionID: command.SessionID,
		PlayerID: command.PlayerID, WalletSessionID: command.WalletSessionID,
		GameID: command.GameID, DefinitionVersion: command.DefinitionVersion,
		DefinitionHash:     command.DefinitionHash,
		RequestFingerprint: launchRequestFingerprint(command),
		Currency:           command.Currency, CurrencyExponent: command.CurrencyExponent,
		Jurisdiction:          command.Jurisdiction,
		IdleDisconnectSeconds: int64(command.IdleDisconnect / time.Second),
	}
	code := manager.launchCode(command.OperatorID, command.SessionID, command.IdempotencyKey)
	original, err := manager.launches.IssueCode(context.Background(), claims, code)
	if err != nil {
		t.Fatal(err)
	}
	manager.version = "math-v2"
	manager.hash = strings.Repeat("c", 64)
	delete(manager.issuers, command.OperatorID)
	manager.idleDisconnectMin = command.IdleDisconnect + time.Second

	replayed, err := manager.CreateLaunch(context.Background(), command)
	if err != nil || replayed.LaunchCode != original.Code ||
		!replayed.ExpiresAt.Equal(original.ExpiresAt) {
		t.Fatalf("missing-session exact replay = %+v err=%v, want %+v", replayed, err, original)
	}
	if _, err := repository.GetSession(
		context.Background(), command.OperatorID, command.SessionID,
	); !errors.Is(err, rgs.ErrSessionNotFound) {
		t.Fatalf("exact replay created a durable session: %v", err)
	}
}

func TestLaunchManagerRelaunchRecoversIdleExpiredDurableSession(t *testing.T) {
	repository := rgs.NewMemoryRepository()
	launchStore := launch.NewMemoryStore()
	manager, command := newRelaunchTestManager(t, repository, launchStore)
	now := time.Now().UTC()
	original := relaunchTestSession(command, now.Add(time.Hour), now.Add(-time.Minute))
	original.BalanceMinor = 4_321
	if err := repository.CreateSession(context.Background(), original); err != nil {
		t.Fatal(err)
	}

	issued, err := manager.CreateLaunch(context.Background(), command)
	if err != nil {
		t.Fatalf("idle-expired relaunch: %v", err)
	}
	beforeExchange, err := repository.GetSession(
		context.Background(), command.OperatorID, command.SessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if beforeExchange.TransportGeneration != original.TransportGeneration ||
		!beforeExchange.IdleDisconnectAt.Equal(original.IdleDisconnectAt) ||
		beforeExchange.BalanceMinor != original.BalanceMinor {
		t.Fatalf("launch mutated durable session before exchange: before=%+v after=%+v", original, beforeExchange)
	}

	exchanged, err := manager.ExchangeSession(context.Background(), rgsapi.ExchangeCommand{
		LaunchCode: issued.LaunchCode, OperatorID: command.OperatorID,
		SessionID: command.SessionID, RequestID: "exchange-idle-relaunch",
	})
	if err != nil {
		t.Fatalf("idle-expired exchange: %v", err)
	}
	if exchanged.Session.TransportGeneration != original.TransportGeneration+1 ||
		!exchanged.Session.IdleDisconnectAt.After(now) ||
		exchanged.Session.BalanceMinor != original.BalanceMinor ||
		!exchanged.Session.ExpiresAt.Equal(original.ExpiresAt) {
		t.Fatalf("idle relaunch did not preserve economics/reset transport: %+v", exchanged.Session)
	}
}

func newRelaunchTestManager(
	t *testing.T,
	repository rgs.Repository,
	launchStore *launch.MemoryStore,
) (*LaunchManager, rgsapi.LaunchCommand) {
	t.Helper()
	now := time.Now().UTC()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := operator.NewAccessTokenIssuer(operator.SigningKey{
		KeyID: "access-operator-relaunch", OperatorID: "operator-relaunch",
		Purpose: operator.KeyPurposeAccessToken, PrivateKey: privateKey,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}, operator.AccessTokenIssuerOptions{
		Issuer: "rgs-test", Audience: "game-client", MaxLifetime: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	launchService, err := launch.NewService(launchStore, launch.Options{TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	definitionHash := strings.Repeat("b", 64)
	manager, err := NewLaunchManager(LaunchManagerConfig{
		PublicBaseURL: "https://rgs.example", LaunchHMACKey: []byte(strings.Repeat("r", 32)),
		AccessTokenTTL: 15 * time.Minute, GameID: "iron-colossus",
		DefinitionVersion: "math-v1", DefinitionHash: definitionHash,
	}, repository, launchService, map[string]*operator.AccessTokenIssuer{
		"operator-relaunch": issuer,
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, rgsapi.LaunchCommand{
		OperatorID: "operator-relaunch", RequestID: "request-relaunch",
		IdempotencyKey: "handoff-relaunch", SessionID: "session-relaunch",
		PlayerID: "player-relaunch", WalletAccountID: "wallet-account-relaunch",
		WalletSessionID: "wallet-session-relaunch", GameID: "iron-colossus",
		DefinitionVersion: "math-v1", DefinitionHash: definitionHash,
		Currency: "EUR", CurrencyExponent: 2, Jurisdiction: "MT",
		BalanceMinor: 10_000, SessionTTL: time.Hour, IdleDisconnect: 20 * time.Minute,
	}
}

func relaunchTestSession(
	command rgsapi.LaunchCommand,
	expiresAt, idleDisconnectAt time.Time,
) rgs.Session {
	return rgs.Session{
		OperatorID: command.OperatorID, SessionID: command.SessionID,
		PlayerID: command.PlayerID, WalletAccountID: command.WalletAccountID,
		WalletSessionID: command.WalletSessionID, GameID: command.GameID,
		DefinitionVersion: command.DefinitionVersion, DefinitionHash: command.DefinitionHash,
		Currency: command.Currency, CurrencyExponent: command.CurrencyExponent,
		Jurisdiction: command.Jurisdiction, Status: rgs.SessionActive,
		ExpiresAt: expiresAt, IdleDisconnectAt: idleDisconnectAt,
		IdleDisconnect: command.IdleDisconnect, TransportGeneration: 1,
		BalanceMinor: command.BalanceMinor, Feature: game.EmptyFeatureState(),
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
