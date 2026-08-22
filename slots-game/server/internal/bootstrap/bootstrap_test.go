package bootstrap

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/operator"
)

func TestLoadDefinitionAuthenticatesExactStrictDocument(t *testing.T) {
	fixture := newDefinitionFixture(t)

	configured, digest, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey)
	if err != nil {
		t.Fatalf("load definition: %v", err)
	}
	if configured.GameID != fixture.config.GameID || digest != fixture.digest {
		t.Fatalf("loaded wrong definition: game=%q digest=%q", configured.GameID, digest)
	}

	t.Run("tampered definition", func(t *testing.T) {
		changed := fixture.config
		changed.Feature.SurgeOneChanceBP++
		writeJSONFile(t, fixture.definition, changed, 0o600)
		if _, _, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey); err == nil ||
			!strings.Contains(err.Error(), "digest mismatch") {
			t.Fatalf("expected authenticated digest failure, got %v", err)
		}
	})
}

func TestLoadDefinitionRejectsTamperedApproval(t *testing.T) {
	fixture := newDefinitionFixture(t)
	fixture.envelope.Approval.ApprovalRef = "tampered-release"
	writeJSONFile(t, fixture.approval, fixture.envelope, 0o600)
	if _, _, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey); err == nil ||
		!strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("expected signature failure, got %v", err)
	}
}

func TestLoadDefinitionProductionPolicyFailsClosed(t *testing.T) {
	t.Run("v1 demo approval", func(t *testing.T) {
		fixture := newDefinitionFixture(t)
		if _, _, err := LoadDefinition(
			fixture.definition, fixture.approval, fixture.publicKey,
			RequireProductionDefinitionApproval(),
		); err == nil || !strings.Contains(err.Error(), "production requires rgs-definition-approval-v2") {
			t.Fatalf("expected production v2 rejection, got %v", err)
		}
	})

	t.Run("v2 exact evidence", func(t *testing.T) {
		fixture := newProductionDefinitionFixture(t)
		configured, digest, err := LoadDefinition(
			fixture.definition, fixture.approval, fixture.publicKey,
			RequireProductionDefinitionApproval(),
		)
		if err != nil {
			t.Fatalf("load production definition: %v", err)
		}
		if configured.GameID != fixture.config.GameID || digest != fixture.digest {
			t.Fatalf("loaded wrong production definition: game=%q digest=%q", configured.GameID, digest)
		}
	})

	for _, test := range []struct {
		name    string
		missing string
		mutate  func(*game.DefinitionApprovalEvidence)
	}{
		{
			name: "v2 missing math evidence", missing: "math report evidence",
			mutate: func(evidence *game.DefinitionApprovalEvidence) { evidence.MathReportRefs = nil },
		},
		{
			name: "v2 missing RNG evidence", missing: "RNG report evidence",
			mutate: func(evidence *game.DefinitionApprovalEvidence) { evidence.RNGReportRefs = nil },
		},
		{
			name: "v2 missing jurisdiction evidence", missing: "jurisdiction approval evidence",
			mutate: func(evidence *game.DefinitionApprovalEvidence) { evidence.JurisdictionApprovals = nil },
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newProductionDefinitionFixture(t)
			test.mutate(fixture.envelope.Approval.ProductionEvidence)
			signDefinitionFixture(t, &fixture, true)
			if _, _, err := LoadDefinition(
				fixture.definition, fixture.approval, fixture.publicKey,
				RequireProductionDefinitionApproval(),
			); err == nil || !strings.Contains(err.Error(), test.missing) {
				t.Fatalf("expected missing %s rejection, got %v", test.missing, err)
			}
		})
	}
}

func TestLoadDefinitionRejectsUnknownDuplicateTrailingAndOversizeJSON(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		fixture := newDefinitionFixture(t)
		var document map[string]any
		data, err := json.Marshal(fixture.config)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatal(err)
		}
		document["unapprovedField"] = true
		writeJSONFile(t, fixture.definition, document, 0o600)
		if _, _, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey); err == nil ||
			!strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("expected unknown-field failure, got %v", err)
		}
	})

	t.Run("duplicate", func(t *testing.T) {
		fixture := newDefinitionFixture(t)
		data, err := os.ReadFile(fixture.definition)
		if err != nil {
			t.Fatal(err)
		}
		needle := `"gameId":"` + fixture.config.GameID + `"`
		duplicated := strings.Replace(string(data), needle, needle+","+needle, 1)
		if duplicated == string(data) {
			t.Fatal("test did not inject duplicate member")
		}
		writeBytes(t, fixture.definition, []byte(duplicated), 0o600)
		if _, _, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey); err == nil ||
			!strings.Contains(err.Error(), "duplicate object member") {
			t.Fatalf("expected duplicate-member failure, got %v", err)
		}
	})

	t.Run("trailing", func(t *testing.T) {
		fixture := newDefinitionFixture(t)
		data, err := os.ReadFile(fixture.definition)
		if err != nil {
			t.Fatal(err)
		}
		writeBytes(t, fixture.definition, append(data, []byte("\n{}")...), 0o600)
		if _, _, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey); err == nil ||
			!strings.Contains(err.Error(), "trailing") {
			t.Fatalf("expected trailing-data failure, got %v", err)
		}
	})

	t.Run("oversize", func(t *testing.T) {
		fixture := newDefinitionFixture(t)
		data, err := os.ReadFile(fixture.definition)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, make([]byte, maximumJSONBytes-int64(len(data))+1)...)
		writeBytes(t, fixture.definition, data, 0o600)
		if _, _, err := LoadDefinition(fixture.definition, fixture.approval, fixture.publicKey); err == nil ||
			!strings.Contains(err.Error(), "1048576-byte limit") {
			t.Fatalf("expected size-limit failure, got %v", err)
		}
	})
}

func TestLoadOperatorDocumentBuildsTenantBoundRuntimeMaterial(t *testing.T) {
	fixture := newOperatorFixture(t)
	loaded, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic)
	if err != nil {
		t.Fatalf("load operator document: %v", err)
	}
	if loaded.Schema != OperatorDocumentSchema || loaded.TokenIssuer != "https://rgs.example.test" ||
		loaded.TokenAudience != "iron-colossus-client" || len(loaded.Operators) != 1 ||
		len(loaded.VerificationKeys) != 3 {
		t.Fatalf("unexpected loaded material counts or metadata")
	}
	configured := loaded.Operators["operator-a"]
	if configured.OperatorID != "operator-a" || configured.Wallet.BaseURL != "https://wallet.example.test/rgs" ||
		configured.AccessTokenSigningKey.Purpose != operator.KeyPurposeAccessToken ||
		configured.OperatorResponseSigningKey.Purpose != operator.KeyPurposeHTTPResponse ||
		configured.Wallet.RequestSigningKey.Purpose != operator.KeyPurposeHTTPRequest ||
		len(configured.Wallet.ResponseVerificationKeys) != 1 {
		t.Fatalf("wrong operator routing material")
	}
	ring, err := operator.NewMemoryKeyRing(loaded.VerificationKeys...)
	if err != nil {
		t.Fatalf("construct key ring: %v", err)
	}
	key, found, err := ring.ResolveKey(context.Background(), operator.KeyPurposeAccessToken, "access-a")
	if err != nil || !found || key.OperatorID != "operator-a" {
		t.Fatalf("access verification key not tenant-bound: found=%v key=%+v err=%v", found, key, err)
	}
}

func TestLoadOperatorDocumentWorkerProfileDoesNotReadAPIKeyMaterial(t *testing.T) {
	fixture := newOperatorFixture(t)
	configured := fixture.config.Operators[0]
	for _, relative := range []string{
		configured.AccessTokenSigningKey.PrivateKeyFile,
		configured.AccessTokenSigningKey.PublicKeyFile,
		configured.OperatorRequestVerificationKeys[0].PublicKeyFile,
		configured.OperatorResponseSigningKey.PrivateKeyFile,
		configured.OperatorResponseSigningKey.PublicKeyFile,
	} {
		if err := os.Remove(filepath.Join(fixture.directory, relative)); err != nil {
			t.Fatal(err)
		}
	}

	loaded, err := LoadOperatorDocument(
		fixture.document,
		"",
		"",
		RequirePerOperatorAccessTokenKeys(),
		LoadWalletMaterialOnlyForWorker(),
	)
	if err != nil {
		t.Fatalf("load worker wallet material: %v", err)
	}
	operatorConfig := loaded.Operators["operator-a"]
	if operatorConfig.AccessTokenSigningKey.PrivateKey != nil ||
		operatorConfig.OperatorResponseSigningKey.PrivateKey != nil {
		t.Fatal("worker profile retained API signing material")
	}
	if operatorConfig.Wallet.RequestSigningKey.PrivateKey == nil ||
		len(operatorConfig.Wallet.ResponseVerificationKeys) != 1 ||
		len(loaded.VerificationKeys) != 1 {
		t.Fatal("worker profile did not retain the exact wallet material")
	}
}

func TestLoadOperatorDocumentV2IsolatesAccessTokenKeysAcrossOperators(t *testing.T) {
	fixture := newOperatorFixture(t)
	secondPrivate, secondPublic := writeEd25519KeyPair(t, fixture.directory, "access-b")
	second := secondOperatorEntry(fixture.config.Operators[0], "operator-b")
	second.AccessTokenSigningKey.PrivateKeyFile = filepath.Base(secondPrivate)
	second.AccessTokenSigningKey.PublicKeyFile = filepath.Base(secondPublic)
	fixture.config.Operators = append(fixture.config.Operators, second)
	writeJSONFile(t, fixture.document, fixture.config, 0o600)

	loaded, err := LoadOperatorDocument(
		fixture.document, "", "", RequirePerOperatorAccessTokenKeys(),
	)
	if err != nil {
		t.Fatalf("load isolated v2 document: %v", err)
	}
	first := loaded.Operators["operator-a"].AccessTokenSigningKey
	other := loaded.Operators["operator-b"].AccessTokenSigningKey
	firstPublic := first.PrivateKey.Public().(ed25519.PublicKey)
	otherPublic := other.PrivateKey.Public().(ed25519.PublicKey)
	if first.KeyID == other.KeyID || bytes.Equal(firstPublic, otherPublic) {
		t.Fatal("operator access-token signing material is not isolated")
	}

	ring, err := operator.NewMemoryKeyRing(loaded.VerificationKeys...)
	if err != nil {
		t.Fatalf("construct key ring: %v", err)
	}
	for keyID, operatorID := range map[string]string{"access-a": "operator-a", "access-b": "operator-b"} {
		key, found, err := ring.ResolveKey(context.Background(), operator.KeyPurposeAccessToken, keyID)
		if err != nil || !found || key.OperatorID != operatorID {
			t.Fatalf("resolve %s: found=%v operator=%q err=%v", keyID, found, key.OperatorID, err)
		}
	}
}

func TestLoadOperatorDocumentV2RejectsReusedAccessTokenMaterial(t *testing.T) {
	fixture := newOperatorFixture(t)
	second := secondOperatorEntry(fixture.config.Operators[0], "operator-b")
	fixture.config.Operators = append(fixture.config.Operators, second)
	writeJSONFile(t, fixture.document, fixture.config, 0o600)

	_, err := LoadOperatorDocument(
		fixture.document, "", "", RequirePerOperatorAccessTokenKeys(),
	)
	if err == nil || !strings.Contains(err.Error(), "public key material is reused") {
		t.Fatalf("expected shared access-token key rejection, got %v", err)
	}
}

func TestLoadOperatorDocumentV2RetainsVerificationKeysForRotation(t *testing.T) {
	fixture := newOperatorFixture(t)
	previousPrivatePath, previousPublic := writeEd25519KeyPair(t, fixture.directory, "access-previous")
	fixture.config.Operators[0].AccessTokenVerificationKeys = []verificationKeyDocument{{
		KeyID: "access-a-previous", NotBefore: "2025-01-01T00:00:00Z",
		NotAfter: "2035-01-01T00:00:00Z", PublicKeyFile: filepath.Base(previousPublic),
	}}
	writeJSONFile(t, fixture.document, fixture.config, 0o600)

	loaded, err := LoadOperatorDocument(
		fixture.document, "", "", RequirePerOperatorAccessTokenKeys(),
	)
	if err != nil {
		t.Fatalf("load rotating v2 document: %v", err)
	}
	ring, err := operator.NewMemoryKeyRing(loaded.VerificationKeys...)
	if err != nil {
		t.Fatalf("construct key ring: %v", err)
	}
	for _, keyID := range []string{"access-a", "access-a-previous"} {
		key, found, err := ring.ResolveKey(context.Background(), operator.KeyPurposeAccessToken, keyID)
		if err != nil || !found || key.OperatorID != "operator-a" {
			t.Fatalf("rotation key %s missing or unbound: found=%v key=%+v err=%v", keyID, found, key, err)
		}
	}

	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	options := operator.AccessTokenIssuerOptions{
		Issuer: loaded.TokenIssuer, Audience: loaded.TokenAudience,
		Now: func() time.Time { return now }, MaxLifetime: time.Minute,
	}
	activeIssuer, err := operator.NewAccessTokenIssuer(
		loaded.Operators["operator-a"].AccessTokenSigningKey, options,
	)
	if err != nil {
		t.Fatalf("construct active issuer: %v", err)
	}
	previousPrivate, _, err := loadMatchingEd25519KeyPair(previousPrivatePath, previousPublic)
	if err != nil {
		t.Fatalf("load previous signing key: %v", err)
	}
	defer clear(previousPrivate)
	previousIssuer, err := operator.NewAccessTokenIssuer(operator.SigningKey{
		KeyID: "access-a-previous", OperatorID: "operator-a",
		Purpose: operator.KeyPurposeAccessToken, PrivateKey: previousPrivate,
		NotBefore: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:  time.Date(2035, 1, 1, 0, 0, 0, 0, time.UTC),
	}, options)
	if err != nil {
		t.Fatalf("construct previous issuer: %v", err)
	}
	verifier, err := operator.NewAccessTokenVerifier(ring, operator.AccessTokenVerifierOptions{
		ExpectedIssuer: loaded.TokenIssuer, ExpectedAudience: loaded.TokenAudience,
		Now: func() time.Time { return now }, MaxLifetime: time.Minute,
	})
	if err != nil {
		t.Fatalf("construct verifier: %v", err)
	}
	subject := operator.AccessTokenSubject{
		OperatorID: "operator-a", PlayerID: "player-a", WalletSessionID: "wallet-a",
		SessionID: "session-a", GameID: "game-a", GameDefinitionVersion: "math-v1",
		GameDefinitionHash: strings.Repeat("a", 64), Currency: "USD",
		CurrencyExponent: 2, Jurisdiction: "GB",
	}
	for name, issuer := range map[string]*operator.AccessTokenIssuer{
		"active": activeIssuer, "retained": previousIssuer,
	} {
		token, _, err := issuer.Issue(subject, time.Minute)
		if err != nil {
			t.Fatalf("issue %s token: %v", name, err)
		}
		if _, err := verifier.Verify(context.Background(), token, "operator-a"); err != nil {
			t.Fatalf("verify %s token: %v", name, err)
		}
	}
}

func TestLoadOperatorDocumentLegacySchemaIsMigrationOnly(t *testing.T) {
	fixture := newOperatorFixture(t)
	active := fixture.config.Operators[0].AccessTokenSigningKey
	fixture.config.Schema = LegacyOperatorDocumentSchema
	fixture.config.Operators[0].AccessTokenSigningKey = signingKeyDocument{}
	fixture.config.Operators[0].AccessTokenKeyID = active.KeyID
	fixture.config.Operators[0].NotBefore = active.NotBefore
	fixture.config.Operators[0].NotAfter = active.NotAfter
	writeJSONFile(t, fixture.document, fixture.config, 0o600)

	loaded, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic)
	if err != nil || loaded.Schema != LegacyOperatorDocumentSchema {
		t.Fatalf("legacy migration load failed: schema=%q err=%v", loaded.Schema, err)
	}
	_, err = LoadOperatorDocument(
		fixture.document, fixture.accessPrivate, fixture.accessPublic,
		RequirePerOperatorAccessTokenKeys(),
	)
	if err == nil || !strings.Contains(err.Error(), "per-operator access-token keys") {
		t.Fatalf("production accepted legacy shared key schema: %v", err)
	}
}

func TestLoadOperatorDocumentRejectsUnknownAndDuplicateMembers(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		fixture := newOperatorFixture(t)
		var document map[string]any
		data, err := os.ReadFile(fixture.document)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatal(err)
		}
		document["unexpected"] = true
		writeJSONFile(t, fixture.document, document, 0o600)
		if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
			!strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("expected unknown-field failure, got %v", err)
		}
	})

	t.Run("duplicate", func(t *testing.T) {
		fixture := newOperatorFixture(t)
		data, err := os.ReadFile(fixture.document)
		if err != nil {
			t.Fatal(err)
		}
		needle := `"schema":"` + OperatorDocumentSchema + `"`
		duplicated := strings.Replace(string(data), needle, needle+","+needle, 1)
		writeBytes(t, fixture.document, []byte(duplicated), 0o600)
		if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
			!strings.Contains(err.Error(), "duplicate object member") {
			t.Fatalf("expected duplicate-member failure, got %v", err)
		}
	})
}

func TestLoadOperatorDocumentRejectsDuplicateTenantAndPurposeKeyIDs(t *testing.T) {
	t.Run("tenant", func(t *testing.T) {
		fixture := newOperatorFixture(t)
		fixture.config.Operators = append(fixture.config.Operators, fixture.config.Operators[0])
		writeJSONFile(t, fixture.document, fixture.config, 0o600)
		if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
			!strings.Contains(err.Error(), "duplicate operatorId") {
			t.Fatalf("expected duplicate tenant failure, got %v", err)
		}
	})

	t.Run("purpose key id", func(t *testing.T) {
		fixture := newOperatorFixture(t)
		fixture.config.Operators[0].Wallet.RequestSigningKey.KeyID =
			fixture.config.Operators[0].OperatorRequestVerificationKeys[0].KeyID
		writeJSONFile(t, fixture.document, fixture.config, 0o600)
		if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
			!strings.Contains(err.Error(), "duplicate keyId") {
			t.Fatalf("expected duplicate purpose/key failure, got %v", err)
		}
	})
}

func TestLoadOperatorDocumentRejectsKeyMismatch(t *testing.T) {
	t.Run("operator access pair", func(t *testing.T) {
		fixture := newOperatorFixture(t)
		_, unrelatedPublic := writeEd25519KeyPair(t, fixture.directory, "unrelated-access")
		fixture.config.Operators[0].AccessTokenSigningKey.PublicKeyFile = filepath.Base(unrelatedPublic)
		writeJSONFile(t, fixture.document, fixture.config, 0o600)
		if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
			!strings.Contains(err.Error(), "do not match") {
			t.Fatalf("expected global key mismatch, got %v", err)
		}
	})

	t.Run("signing pair", func(t *testing.T) {
		fixture := newOperatorFixture(t)
		_, unrelatedPublic := writeEd25519KeyPair(t, fixture.directory, "unrelated-response")
		fixture.config.Operators[0].OperatorResponseSigningKey.PublicKeyFile = filepath.Base(unrelatedPublic)
		writeJSONFile(t, fixture.document, fixture.config, 0o600)
		if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
			!strings.Contains(err.Error(), "do not match") {
			t.Fatalf("expected signing key mismatch, got %v", err)
		}
	})
}

func TestLoadOperatorDocumentRejectsUnsafePrivateKeyPermissions(t *testing.T) {
	tests := []struct {
		name       string
		permission os.FileMode
	}{
		{name: "world read", permission: 0o604},
		{name: "group write", permission: 0o620},
		{name: "world write", permission: 0o602},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOperatorFixture(t)
			if err := os.Chmod(fixture.accessPrivate, test.permission); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
				!strings.Contains(err.Error(), "permissions") {
				t.Fatalf("expected permission failure, got %v", err)
			}
		})
	}
}

func TestLoadOperatorDocumentRequiresHTTPSUnlessExplicitDevelopmentOverride(t *testing.T) {
	fixture := newOperatorFixture(t)
	fixture.config.Operators[0].Wallet.BaseURL = "http://127.0.0.1:18080/wallet"
	writeJSONFile(t, fixture.document, fixture.config, 0o600)
	if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
		!strings.Contains(err.Error(), "must use HTTPS") {
		t.Fatalf("expected HTTPS failure, got %v", err)
	}
	loaded, err := LoadOperatorDocument(
		fixture.document, fixture.accessPrivate, fixture.accessPublic,
		AllowInsecureWalletHTTPForDevelopment(),
	)
	if err != nil {
		t.Fatalf("explicit development override failed: %v", err)
	}
	if loaded.Operators["operator-a"].Wallet.BaseURL != "http://127.0.0.1:18080/wallet" {
		t.Fatal("development URL was not retained")
	}
}

func TestLoadOperatorDocumentRejectsNonEd25519PEM(t *testing.T) {
	fixture := newOperatorFixture(t)
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	writeBytes(t, fixture.accessPublic, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}), 0o644)
	if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
		!strings.Contains(err.Error(), "must be Ed25519") {
		t.Fatalf("expected Ed25519-only failure, got %v", err)
	}
}

func TestLoadOperatorDocumentRejectsInvalidKeyWindow(t *testing.T) {
	fixture := newOperatorFixture(t)
	fixture.config.Operators[0].AccessTokenSigningKey.NotBefore = "2035-01-01T00:00:00Z"
	fixture.config.Operators[0].AccessTokenSigningKey.NotAfter = "2025-01-01T00:00:00Z"
	writeJSONFile(t, fixture.document, fixture.config, 0o600)
	if _, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic); err == nil ||
		!strings.Contains(err.Error(), "notAfter must be later") {
		t.Fatalf("expected invalid key-window failure, got %v", err)
	}
}

func TestLoadOperatorDocumentIsSafeForConcurrentStartupValidation(t *testing.T) {
	fixture := newOperatorFixture(t)
	const workers = 12
	var group sync.WaitGroup
	errorsFound := make(chan error, workers)
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := LoadOperatorDocument(fixture.document, fixture.accessPrivate, fixture.accessPublic)
			errorsFound <- err
		}()
	}
	group.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatalf("concurrent load failed: %v", err)
		}
	}
}

type definitionFixture struct {
	definition string
	approval   string
	publicKey  string
	config     game.Config
	digest     string
	envelope   game.SignedDefinitionApproval
	privateKey ed25519.PrivateKey
}

func newDefinitionFixture(t *testing.T) definitionFixture {
	t.Helper()
	directory := t.TempDir()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	config := game.DemoConfig()
	digest, err := game.DefinitionDigest(config)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := game.SignDefinitionApproval(game.DefinitionApproval{
		GameID: config.GameID, Version: config.DefinitionVersion, SHA256: digest,
		Status: "APPROVED", ApprovalRef: "lab-release-42",
	}, "release-key-1", private)
	if err != nil {
		t.Fatal(err)
	}
	definitionPath := filepath.Join(directory, "definition.json")
	approvalPath := filepath.Join(directory, "approval.json")
	publicPath := filepath.Join(directory, "release-public.pem")
	writeJSONFile(t, definitionPath, config, 0o600)
	writeJSONFile(t, approvalPath, envelope, 0o600)
	writePublicKey(t, publicPath, public)
	return definitionFixture{
		definition: definitionPath, approval: approvalPath, publicKey: publicPath,
		config: config, digest: digest, envelope: envelope, privateKey: private,
	}
}

func newProductionDefinitionFixture(t *testing.T) definitionFixture {
	t.Helper()
	fixture := newDefinitionFixture(t)
	fixture.config.GameID = "iron-colossus"
	fixture.config.DefinitionVersion = "math-2026-08-13.1"
	var err error
	fixture.digest, err = game.DefinitionDigest(fixture.config)
	if err != nil {
		t.Fatal(err)
	}
	fixture.envelope.Approval = game.DefinitionApproval{
		GameID: fixture.config.GameID, Version: fixture.config.DefinitionVersion,
		SHA256: fixture.digest, Status: "APPROVED", ApprovalRef: "release-record:placeholder",
		ProductionEvidence: &game.DefinitionApprovalEvidence{
			MathReportRefs: []string{"math-report:placeholder"},
			RNGReportRefs:  []string{"rng-report:placeholder"},
			JurisdictionApprovals: []game.DefinitionJurisdictionEvidence{
				{Jurisdiction: "TEST-REGION", ApprovalRef: "approval:placeholder"},
			},
		},
	}
	writeJSONFile(t, fixture.definition, fixture.config, 0o600)
	signDefinitionFixture(t, &fixture, true)
	return fixture
}

func signDefinitionFixture(t *testing.T, fixture *definitionFixture, production bool) {
	t.Helper()
	var (
		envelope game.SignedDefinitionApproval
		err      error
	)
	if production {
		envelope, err = game.SignProductionDefinitionApproval(
			fixture.envelope.Approval, "release-key-2", fixture.privateKey,
		)
	} else {
		envelope, err = game.SignDefinitionApproval(
			fixture.envelope.Approval, "release-key-1", fixture.privateKey,
		)
	}
	if err != nil {
		t.Fatal(err)
	}
	fixture.envelope = envelope
	writeJSONFile(t, fixture.approval, fixture.envelope, 0o600)
}

type operatorFixture struct {
	directory     string
	document      string
	accessPrivate string
	accessPublic  string
	config        operatorDocument
}

func newOperatorFixture(t *testing.T) operatorFixture {
	t.Helper()
	directory := t.TempDir()
	accessPrivate, accessPublic := writeEd25519KeyPair(t, directory, "access")
	requestPrivate, requestPublic := writeEd25519KeyPair(t, directory, "operator-request")
	_ = requestPrivate
	responsePrivate, responsePublic := writeEd25519KeyPair(t, directory, "operator-response")
	walletRequestPrivate, walletRequestPublic := writeEd25519KeyPair(t, directory, "wallet-request")
	walletResponsePrivate, walletResponsePublic := writeEd25519KeyPair(t, directory, "wallet-response")
	_ = walletResponsePrivate
	from, until := "2025-01-01T00:00:00Z", "2035-01-01T00:00:00Z"
	document := operatorDocument{
		Schema: OperatorDocumentSchema, TokenIssuer: "https://rgs.example.test",
		TokenAudience: "iron-colossus-client",
		Operators: []operatorDocumentEntry{{
			OperatorID: "operator-a",
			AccessTokenSigningKey: signingKeyDocument{
				KeyID: "access-a", NotBefore: from, NotAfter: until,
				PrivateKeyFile: filepath.Base(accessPrivate), PublicKeyFile: filepath.Base(accessPublic),
			},
			OperatorRequestVerificationKeys: []verificationKeyDocument{{
				KeyID: "operator-request-a", NotBefore: from, NotAfter: until,
				PublicKeyFile: filepath.Base(requestPublic),
			}},
			OperatorResponseSigningKey: signingKeyDocument{
				KeyID: "operator-response-a", NotBefore: from, NotAfter: until,
				PrivateKeyFile: filepath.Base(responsePrivate), PublicKeyFile: filepath.Base(responsePublic),
			},
			Wallet: walletDocument{
				BaseURL: "https://wallet.example.test/rgs/",
				RequestSigningKey: signingKeyDocument{
					KeyID: "wallet-request-a", NotBefore: from, NotAfter: until,
					PrivateKeyFile: filepath.Base(walletRequestPrivate), PublicKeyFile: filepath.Base(walletRequestPublic),
				},
				ResponseVerificationKeys: []verificationKeyDocument{{
					KeyID: "wallet-response-a", NotBefore: from, NotAfter: until,
					PublicKeyFile: filepath.Base(walletResponsePublic),
				}},
			},
		}},
	}
	documentPath := filepath.Join(directory, "operators.json")
	writeJSONFile(t, documentPath, document, 0o600)
	return operatorFixture{
		directory: directory, document: documentPath,
		accessPrivate: accessPrivate, accessPublic: accessPublic, config: document,
	}
}

func secondOperatorEntry(source operatorDocumentEntry, operatorID string) operatorDocumentEntry {
	result := source
	result.OperatorID = operatorID
	result.AccessTokenSigningKey.KeyID = "access-b"
	result.OperatorRequestVerificationKeys = append([]verificationKeyDocument(nil), source.OperatorRequestVerificationKeys...)
	result.OperatorRequestVerificationKeys[0].KeyID = "operator-request-b"
	result.OperatorResponseSigningKey.KeyID = "operator-response-b"
	result.Wallet.ResponseVerificationKeys = append([]verificationKeyDocument(nil), source.Wallet.ResponseVerificationKeys...)
	result.Wallet.RequestSigningKey.KeyID = "wallet-request-b"
	result.Wallet.ResponseVerificationKeys[0].KeyID = "wallet-response-b"
	return result
}

func writeEd25519KeyPair(t *testing.T, directory, name string) (string, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(directory, name+"-private.pem")
	publicPath := filepath.Join(directory, name+"-public.pem")
	writeBytes(t, privatePath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0o600)
	writeBytes(t, publicPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}), 0o644)
	return privatePath, publicPath
}

func writePublicKey(t *testing.T, path string, key ed25519.PublicKey) {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	writeBytes(t, path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644)
}

func writeJSONFile(t *testing.T, path string, value any, permission os.FileMode) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeBytes(t, path, data, permission)
}

func writeBytes(t *testing.T, path string, data []byte, permission os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, permission); err != nil {
		t.Fatal(err)
	}
}
