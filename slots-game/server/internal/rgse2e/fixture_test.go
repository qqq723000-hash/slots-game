// rgse2e 包包含仅供浏览器端到端测试套件使用的回环 RGS。它刻意组合生产领域及
// HTTP 适配器；只有熵源、钱包传输和测试夹具进程控制使用测试替身。
package rgse2e

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"slots-game/server/internal/application"
	"slots-game/server/internal/game"
	"slots-game/server/internal/launch"
	"slots-game/server/internal/operator"
	"slots-game/server/internal/platform"
	"slots-game/server/internal/rgs"
	"slots-game/server/internal/rgsapi"
	"slots-game/server/internal/rng"
)

const (
	testOrigin     = "https://game.e2e"
	testOperatorID = "operator-e2e"
	testSessionID  = "session-e2e"
	testGameID     = "primal-rampage-e2e"
	testBetMinor   = int64(100)
)

type bootstrap struct {
	BaseURL              string `json:"baseUrl"`
	CertificateDERBase64 string `json:"certificateDerBase64"`
	LaunchCode           string `json:"launchCode"`
	OperatorID           string `json:"operatorId"`
	SessionID            string `json:"sessionId"`
	GameID               string `json:"gameId"`
	DefinitionVersion    string `json:"definitionVersion"`
	DefinitionHash       string `json:"definitionHash"`
	Currency             string `json:"currency"`
	CurrencyExponent     int    `json:"currencyExponent"`
	Jurisdiction         string `json:"jurisdiction"`
	BetMinor             string `json:"betMinor"`
	ExpectedRNGCalls     int    `json:"expectedRngCalls"`
	ExpectedRounds       int    `json:"expectedRounds"`
}

type countedSpinner struct {
	inner game.Spinner
	calls atomic.Int64
}

func (s *countedSpinner) Spin(ctx context.Context, input game.SpinInput) (game.SpinOutcome, error) {
	s.calls.Add(1)
	return s.inner.Spin(ctx, input)
}

// idempotentWallet 模拟必要的原子扣款及入账操作，并拒绝使用不同指纹复用操作标识。
type idempotentWallet struct {
	mu              sync.Mutex
	balance         int64
	receipts        map[string]rgs.WalletReceipt
	applyCalls      atomic.Int64
	lookupCalls     atomic.Int64
	economicApplies int64
}

func newIdempotentWallet(balance int64) *idempotentWallet {
	return &idempotentWallet{balance: balance, receipts: make(map[string]rgs.WalletReceipt)}
}

func (w *idempotentWallet) ApplyRound(ctx context.Context, command rgs.WalletRound) (rgs.WalletReceipt, error) {
	if err := ctx.Err(); err != nil {
		return rgs.WalletReceipt{}, err
	}
	w.applyCalls.Add(1)
	w.mu.Lock()
	defer w.mu.Unlock()
	if receipt, exists := w.receipts[command.OperationID]; exists {
		if receipt.Fingerprint != command.Fingerprint {
			return rgs.WalletReceipt{}, rgs.ErrIdempotencyConflict
		}
		return receipt, nil
	}
	if w.balance < command.DebitMinor {
		return rgs.WalletReceipt{}, rgs.ErrWalletRejected
	}
	w.balance = w.balance - command.DebitMinor + command.CreditMinor
	receipt := rgs.WalletReceipt{
		OperationID: command.OperationID, Fingerprint: command.Fingerprint,
		TransactionID: "wallet-tx-" + command.RoundID,
		OperatorID:    command.OperatorID, Currency: command.Currency,
		DebitMinor: command.DebitMinor, CreditMinor: command.CreditMinor,
		BalanceMinor: w.balance,
	}
	w.receipts[command.OperationID] = receipt
	w.economicApplies++
	return receipt, nil
}

func (w *idempotentWallet) ProfileFor(operatorID string) (rgs.Profile, error) {
	if operatorID != testOperatorID {
		return rgs.Profile{}, rgs.ErrWalletUnavailable
	}
	return rgs.AtomicHTTPProfile(rgs.WalletRouteBindingIDForCanonicalTarget("https://wallet.fixture.invalid/ledger")), nil
}

func (w *idempotentWallet) SubmitRound(ctx context.Context, command rgs.WalletRound) rgs.Resolution {
	receipt, err := w.ApplyRound(ctx, command)
	switch {
	case err == nil:
		return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
	case errors.Is(err, rgs.ErrWalletRejected):
		return rgs.Resolution{Status: rgs.ResolutionRejectedFinal, Cause: err}
	case errors.Is(err, rgs.ErrIdempotencyConflict), errors.Is(err, rgs.ErrWalletReceiptInvalid):
		return rgs.Resolution{Status: rgs.ResolutionConflict, Cause: err}
	default:
		return rgs.Resolution{Status: rgs.ResolutionUnknown, Cause: err}
	}
}

func (w *idempotentWallet) Resolve(ctx context.Context, reference rgs.OperationRef) rgs.Resolution {
	receipt, found, err := w.Lookup(ctx, reference.OperatorID, reference.OperationID)
	switch {
	case err == nil && found:
		return rgs.Resolution{Status: rgs.ResolutionSucceeded, Receipt: receipt}
	case err == nil:
		return rgs.Resolution{Status: rgs.ResolutionNotFound}
	case errors.Is(err, rgs.ErrIdempotencyConflict), errors.Is(err, rgs.ErrWalletReceiptInvalid):
		return rgs.Resolution{Status: rgs.ResolutionConflict, Cause: err}
	default:
		return rgs.Resolution{Status: rgs.ResolutionUnknown, Cause: err}
	}
}

func (w *idempotentWallet) Lookup(ctx context.Context, operatorID, operationID string) (rgs.WalletReceipt, bool, error) {
	if err := ctx.Err(); err != nil {
		return rgs.WalletReceipt{}, false, err
	}
	w.lookupCalls.Add(1)
	w.mu.Lock()
	defer w.mu.Unlock()
	receipt, exists := w.receipts[operationID]
	if exists && receipt.OperatorID != operatorID {
		return rgs.WalletReceipt{}, false, rgs.ErrWalletReceiptInvalid
	}
	return receipt, exists, nil
}

func (w *idempotentWallet) Rollback(ctx context.Context, rollback rgs.WalletRollback) (rgs.WalletReceipt, error) {
	if err := ctx.Err(); err != nil {
		return rgs.WalletReceipt{}, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	receipt, exists := w.receipts[rollback.OperationID]
	if !exists || receipt.OperatorID != rollback.OperatorID {
		return rgs.WalletReceipt{}, rgs.ErrRoundNotFound
	}
	return receipt, nil
}

func (w *idempotentWallet) snapshot() (balance, economicApplies int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.balance, w.economicApplies
}

type unusedOperatorVerifier struct{}

func (unusedOperatorVerifier) Authenticate(context.Context, *http.Request, []byte) (operator.VerifiedRequest, error) {
	return operator.VerifiedRequest{}, operator.ErrSignatureInvalid
}

func (unusedOperatorVerifier) ConsumeNonce(context.Context, operator.VerifiedRequest) error {
	return operator.ErrSignatureInvalid
}

type fixture struct {
	server      *httptest.Server
	repository  *rgs.MemoryRepository
	wallet      *idempotentWallet
	random      *rng.SequenceSource
	spinner     *countedSpinner
	spinHTTP    atomic.Int64
	statusHTTP  atomic.Int64
	definition  game.Config
	digest      string
	launchCode  string
	expectedRNG int
	expectedRun int
}

func TestMain(m *testing.M) {
	scenario := os.Getenv("RGS_E2E_SCENARIO")
	if scenario == "" {
		os.Exit(m.Run())
	}

	instance, err := newFixture(scenario)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "rgse2e fixture: %v\n", err)
		os.Exit(1)
	}
	defer instance.server.Close()

	encoded := bootstrap{
		BaseURL:              instance.server.URL,
		CertificateDERBase64: base64.StdEncoding.EncodeToString(instance.server.Certificate().Raw),
		LaunchCode:           instance.launchCode,
		OperatorID:           testOperatorID, SessionID: testSessionID,
		GameID: testGameID, DefinitionVersion: instance.definition.DefinitionVersion,
		DefinitionHash: instance.digest, Currency: "USD", CurrencyExponent: 2,
		Jurisdiction: "GB", BetMinor: "100", ExpectedRNGCalls: instance.expectedRNG,
		ExpectedRounds: instance.expectedRun,
	}
	if err := json.NewEncoder(os.Stdout).Encode(encoded); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "rgse2e fixture bootstrap: %v\n", err)
		os.Exit(1)
	}

	terminated := make(chan os.Signal, 1)
	signal.Notify(terminated, os.Interrupt, syscall.SIGTERM)
	<-terminated
}

func newFixture(scenario string) (*fixture, error) {
	definition, values, expectedRounds, err := deterministicDefinition(scenario)
	if err != nil {
		return nil, err
	}
	digest, err := game.DefinitionDigest(definition)
	if err != nil {
		return nil, err
	}

	definitionSeed := sha256.Sum256([]byte("TEST-ONLY rgse2e definition signing seed"))
	definitionPrivate := ed25519.NewKeyFromSeed(definitionSeed[:])
	approval, err := game.SignDefinitionApproval(game.DefinitionApproval{
		GameID: definition.GameID, Version: definition.DefinitionVersion,
		SHA256: digest, Status: "APPROVED", ApprovalRef: "TEST-ONLY-RGS-E2E",
	}, "test-definition-key", definitionPrivate)
	if err != nil {
		return nil, err
	}
	if err := game.VerifySignedDefinitionApproval(definition, approval, definitionPrivate.Public().(ed25519.PublicKey)); err != nil {
		return nil, fmt.Errorf("verify signed deterministic definition: %w", err)
	}

	sequence := rng.NewSequenceSource(values...)
	engine, err := game.NewEngine(definition, sequence)
	if err != nil {
		return nil, err
	}
	spinner := &countedSpinner{inner: engine}
	registry, err := rgs.NewMemoryDefinitionRegistry(rgs.DefinitionEntry{
		GameID: definition.GameID, Version: definition.DefinitionVersion,
		SHA256: digest, Spinner: spinner,
	})
	if err != nil {
		return nil, err
	}
	repository := rgs.NewMemoryRepository()
	wallet := newIdempotentWallet(10_000)
	coordinator, err := rgs.NewCoordinator(rgs.CoordinatorConfig{
		WalletLease: time.Second, PendingWait: time.Second,
		PollInterval: time.Millisecond, MaxWalletAttempts: 3,
	}, repository, wallet, registry)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	accessSeed := sha256.Sum256([]byte("TEST-ONLY rgse2e access token signing seed"))
	accessPrivate := ed25519.NewKeyFromSeed(accessSeed[:])
	accessSigning := operator.SigningKey{
		KeyID: "test-access-key", OperatorID: testOperatorID,
		Purpose: operator.KeyPurposeAccessToken, PrivateKey: accessPrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}
	issuer, err := operator.NewAccessTokenIssuer(accessSigning, operator.AccessTokenIssuerOptions{
		Issuer: "rgse2e", Audience: "slot-client", MaxLifetime: time.Hour,
	})
	if err != nil {
		return nil, err
	}
	keyRing, err := operator.NewMemoryKeyRing(operator.VerificationKey{
		KeyID: accessSigning.KeyID, OperatorID: accessSigning.OperatorID,
		Purpose: accessSigning.Purpose, PublicKey: accessPrivate.Public().(ed25519.PublicKey),
		NotBefore: accessSigning.NotBefore, NotAfter: accessSigning.NotAfter,
	})
	if err != nil {
		return nil, err
	}
	verifier, err := operator.NewAccessTokenVerifier(keyRing, operator.AccessTokenVerifierOptions{
		ExpectedIssuer: "rgse2e", ExpectedAudience: "slot-client", MaxLifetime: time.Hour,
	})
	if err != nil {
		return nil, err
	}

	launchService, err := launch.NewService(launch.NewMemoryStore(), launch.Options{TTL: 2 * time.Minute})
	if err != nil {
		return nil, err
	}
	unstarted := httptest.NewUnstartedServer(nil)
	publicBaseURL := "https://" + unstarted.Listener.Addr().String()
	launchManager, err := application.NewLaunchManager(application.LaunchManagerConfig{
		PublicBaseURL:  publicBaseURL,
		LaunchHMACKey:  []byte("TEST-ONLY launch HMAC key with at least thirty-two bytes"),
		AccessTokenTTL: 30 * time.Minute, GameID: definition.GameID,
		DefinitionVersion: definition.DefinitionVersion, DefinitionHash: digest,
	}, repository, launchService, map[string]*operator.AccessTokenIssuer{testOperatorID: issuer})
	if err != nil {
		unstarted.Close()
		return nil, err
	}

	responseSeed := sha256.Sum256([]byte("TEST-ONLY rgse2e response signing seed"))
	responsePrivate := ed25519.NewKeyFromSeed(responseSeed[:])
	responseKey := operator.SigningKey{
		KeyID: "test-response-key", OperatorID: testOperatorID,
		Purpose: operator.KeyPurposeHTTPResponse, PrivateKey: responsePrivate,
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
	}
	handler, err := rgsapi.NewHandler(rgsapi.Config{
		OperatorRequests: unusedOperatorVerifier{}, AccessTokens: verifier,
		ResponseSigningKeys: rgsapi.ResponseSigningKeyResolverFunc(func(_ context.Context, operatorID string) (operator.SigningKey, error) {
			if operatorID != testOperatorID {
				return operator.SigningKey{}, errors.New("unknown test operator")
			}
			return responseKey, nil
		}),
		Launches: launchManager, Spins: coordinator, Rounds: coordinator,
		MaxRequestBytes: rgsapi.DefaultMaxRequestBytes,
	})
	if err != nil {
		unstarted.Close()
		return nil, err
	}

	created, err := launchManager.CreateLaunch(context.Background(), rgsapi.LaunchCommand{
		OperatorID: testOperatorID, RequestID: "request-e2e", IdempotencyKey: "launch-e2e",
		PlayerID: "player-e2e", WalletAccountID: "wallet-account-e2e",
		WalletSessionID: "wallet-session-e2e", SessionID: testSessionID,
		GameID: definition.GameID, DefinitionVersion: definition.DefinitionVersion,
		DefinitionHash: digest, Currency: "USD", CurrencyExponent: 2,
		Jurisdiction: "GB", BalanceMinor: 10_000, SessionTTL: time.Hour,
		IdleDisconnect: 20 * time.Minute,
	})
	if err != nil {
		unstarted.Close()
		return nil, err
	}

	instance := &fixture{
		server: unstarted, repository: repository, wallet: wallet,
		random: sequence, spinner: spinner, definition: definition, digest: digest,
		launchCode: created.LaunchCode, expectedRNG: len(values), expectedRun: expectedRounds,
	}
	root := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/__e2e/metrics":
			instance.serveMetrics(writer, request)
		case rgsapi.ClientSpinPath:
			instance.spinHTTP.Add(1)
			handler.ServeHTTP(writer, request)
		case rgsapi.ClientRoundStatusPath:
			instance.statusHTTP.Add(1)
			handler.ServeHTTP(writer, request)
		default:
			handler.ServeHTTP(writer, request)
		}
	})
	secured := platform.Middleware{
		MaxRequestBytes: rgsapi.DefaultMaxRequestBytes,
		AllowedOrigins:  map[string]struct{}{testOrigin: {}},
	}.Wrap(root)
	unstarted.Config.Handler = secured
	unstarted.StartTLS()
	return instance, nil
}

func (f *fixture) serveMetrics(writer http.ResponseWriter, request *http.Request) {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		http.NotFound(writer, request)
		return
	}
	session, err := f.repository.GetSession(request.Context(), testOperatorID, testSessionID)
	if err != nil {
		http.Error(writer, "metrics unavailable", http.StatusInternalServerError)
		return
	}
	walletBalance, economicApplies := f.wallet.snapshot()
	payload := map[string]any{
		"rngConsumed": f.random.Consumed(), "rngExpected": f.expectedRNG,
		"engineSpins": f.spinner.calls.Load(), "walletApplyCalls": f.wallet.applyCalls.Load(),
		"walletLookupCalls": f.wallet.lookupCalls.Load(), "walletEconomicApplies": economicApplies,
		"walletBalanceMinor": walletBalance, "spinHttpCalls": f.spinHTTP.Load(),
		"statusHttpCalls": f.statusHTTP.Load(), "sessionRevision": session.Revision,
		"sessionSequence": session.Sequence, "sessionBalanceMinor": session.BalanceMinor,
		"pendingRound": session.PendingRoundID != "", "featureMode": session.Feature.Mode,
		"featureRemaining": session.Feature.Remaining, "featureAwarded": session.Feature.Awarded,
	}
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(payload)
}

func deterministicDefinition(scenario string) (game.Config, []uint64, int, error) {
	config := game.DemoConfig()
	config.GameID = testGameID
	config.DefinitionVersion = "e2e-" + scenario
	config.Bet = game.BetConfig{
		MinMinor: 100, MaxMinor: 100, StepMinor: 100, PayUnitMinor: 100,
		DefaultMinor: 100, OptionsMinor: []int64{100},
	}
	config.Reels = [3][]game.WeightedSymbol{
		{{Value: game.SymbolOrbit, Weight: 1}, {Value: game.SymbolSurge, Weight: 1}},
		{{Value: game.SymbolPrism, Weight: 1}, {Value: game.SymbolVault, Weight: 1}, {Value: game.SymbolSurge, Weight: 1}},
		{{Value: game.SymbolPulse, Weight: 1}, {Value: game.SymbolSurge, Weight: 1}},
	}
	config.WildMultipliers = []game.WeightedInt{{Value: 0, Weight: 1}}
	config.VaultMultipliers = []game.WeightedInt{{Value: 1, Weight: 1}}
	config.OverdriveMultipliers = []game.WeightedInt{{Value: 2, Weight: 1}, {Value: 10, Weight: 1}, {Value: 30, Weight: 1}}
	config.Feature = game.FeatureConfig{
		InitialFreeSpins: 8, MaxExpansionSpins: 30,
		ExpansionRows: []game.WeightedInt{
			{Value: 3, Weight: 1}, {Value: 4, Weight: 1}, {Value: 5, Weight: 1},
			{Value: 6, Weight: 1}, {Value: 7, Weight: 1}, {Value: 8, Weight: 1},
		},
		RageLevelThresholds: []int{0},
	}

	// 基础结果在每列恰好包含一个怒气符号，且不存在可赔付连线。
	base := []uint64{0, 0, 1, 0, 0, 2, 0, 0, 1, 0}
	switch scenario {
	case "wheel":
		config.Feature.Wheel = []game.WeightedWheel{{Kind: game.WheelInstant, Multiplier: 10, Weight: 1}}
		return config, base, 1, nil
	case "kong":
		config.Feature.Wheel = []game.WeightedWheel{{Kind: game.WheelExpansion, Weight: 1}}
		config.Feature.VaultUnlockChanceBP = 10_000
		config.Feature.VaultFreeSpinWeight = 1
		values := append([]uint64(nil), base...)
		values = append(values, 5) // first free spin expands to 8 rows
		values = append(values, make([]uint64, 8)...)
		values = append(values, 1, 0, 0, 0, 0, 0, 0, 0) // one Vault on reel two
		values = append(values, make([]uint64, 8)...)
		values = append(values, 1) // choose FREE_SPIN after the x1 reward
		for range 8 {
			values = append(values, 0) // remaining grids use three rows
			values = append(values, make([]uint64, 9)...)
		}
		return config, values, 10, nil
	case "king":
		config.Feature.Wheel = []game.WeightedWheel{{Kind: game.WheelOverdrive, Weight: 1}}
		config.Feature.KingSpinUpgradeChanceBP = 10_000
		config.Feature.KingSpinMaxUpgradeRounds = 2
		values := append([]uint64(nil), base...)
		for range 7 {
			values = append(values, make([]uint64, 9)...)
		}
		values = append(values, 0, 0, 0) // left reel
		values = append(values, 1, 1, 1) // three Vaults on the middle reel
		values = append(values, 0, 0, 0) // right reel
		values = append(values, 0, 0, 0) // Vaults initially resolve to x1
		values = append(values, 0, 0, 0) // upgrade batch one resolves to x2
		values = append(values, 0, 0, 0) // upgrade batch two resolves to MINI x10
		return config, values, 9, nil
	default:
		return game.Config{}, nil, 0, fmt.Errorf("unknown scenario %q", scenario)
	}
}
