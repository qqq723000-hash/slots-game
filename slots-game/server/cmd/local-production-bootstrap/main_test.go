package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/bootstrap"
	"slots-game/server/internal/game"
)

func TestGeneratedBundlePassesProductionLoadersAndUsesRestrictedPermissions(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	directory := filepath.Join(t.TempDir(), "local-production")
	if err := run([]string{directory}, func() time.Time { return now }); err != nil {
		t.Fatalf("generate bundle: %v", err)
	}

	info, err := os.Lstat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 || !info.IsDir() {
		t.Fatalf("output directory mode = %v, want 0700 directory", info.Mode())
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 40 {
		t.Fatalf("generated only %d files", len(entries))
	}
	for _, entry := range entries {
		entryInfo, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		if !entryInfo.Mode().IsRegular() || entryInfo.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %v, want regular 0600", entry.Name(), entryInfo.Mode())
		}
	}

	configured, digest, err := bootstrap.LoadDefinition(
		filepath.Join(directory, "definition.json"),
		filepath.Join(directory, "definition-approval.json"),
		filepath.Join(directory, "definition-approval-public.pem"),
		bootstrap.RequireProductionDefinitionApproval(),
	)
	if err != nil {
		t.Fatalf("production definition loader rejected bundle: %v", err)
	}
	if configured.GameID != "iron-colossus" || configured.DefinitionVersion != "local-production-2026-08-16.1" || len(digest) != 64 {
		t.Fatalf("unexpected production definition identity: game=%q version=%q digest=%q", configured.GameID, configured.DefinitionVersion, digest)
	}
	loadedOperators, err := bootstrap.LoadOperatorDocument(
		filepath.Join(directory, "operators.json"), "", "",
		bootstrap.RequirePerOperatorAccessTokenKeys(),
	)
	if err != nil {
		t.Fatalf("production operator loader rejected bundle: %v", err)
	}
	loaded, exists := loadedOperators.Operators[operatorID]
	if !exists || loaded.Wallet.BaseURL != strings.TrimRight(walletBaseURL, "/") {
		t.Fatalf("unexpected loaded operator: exists=%v wallet=%q", exists, loaded.Wallet.BaseURL)
	}
	var companionKeys localOperatorKeyDocument
	decodeJSONFile(t, filepath.Join(directory, "local-operator-keys.json"), &companionKeys)
	if companionKeys.Schema != "local-operator-keys-v1" || companionKeys.OperatorID != operatorID ||
		len(companionKeys.WalletRequestVerificationKeys) != 1 ||
		len(companionKeys.RGSResponseVerificationKeys) != 1 ||
		companionKeys.WalletRequestVerificationKeys[0].PublicKeyFile != "wallet-request-public.pem" ||
		companionKeys.WalletResponseSigningKey.PrivateKeyFile != "wallet-response-private.pem" ||
		companionKeys.LaunchRequestSigningKey.PrivateKeyFile != "operator-request-private.pem" ||
		companionKeys.RGSResponseVerificationKeys[0].PublicKeyFile != "operator-response-public.pem" {
		t.Fatalf("unexpected local operator key document: %+v", companionKeys)
	}
	launchKey, err := bootstrap.LoadLaunchHMACKey(filepath.Join(directory, "launch-hmac.key"))
	if err != nil {
		t.Fatalf("launch key loader rejected bundle: %v", err)
	}
	defer clear(launchKey)
	if len(launchKey) != 32 {
		t.Fatalf("launch key length = %d", len(launchKey))
	}

	var metadata deploymentMetadata
	decodeJSONFile(t, filepath.Join(directory, "deployment-metadata.json"), &metadata)
	if metadata.EnvironmentClass != environmentClass || metadata.AuthorityReference != authorityRef ||
		metadata.ExternalClaimsMade || metadata.DefinitionApprovalSchema != game.DefinitionApprovalSchemaV2 ||
		metadata.OperatorSchema != "rgs-operators-v2" {
		t.Fatalf("unexpected deployment metadata: %+v", metadata)
	}
	var approval game.SignedDefinitionApproval
	decodeJSONFile(t, filepath.Join(directory, "definition-approval.json"), &approval)
	approvalJSON, err := json.Marshal(approval)
	if err != nil {
		t.Fatal(err)
	}
	if approval.Schema != game.DefinitionApprovalSchemaV2 ||
		!strings.Contains(string(approvalJSON), authorityRef) ||
		strings.Contains(string(approvalJSON), "CI"+"_ONLY") {
		t.Fatalf("approval does not carry the local production authority boundary: %s", approvalJSON)
	}
}

func TestGeneratedEd25519KeyPairsAreMatchingAndMutuallyDistinct(t *testing.T) {
	directory := generateTestBundle(t)
	names := []string{
		"definition-approval", "access", "operator-request",
		"operator-response", "wallet-request", "wallet-response",
	}
	seenPublicKeys := make(map[string]string, len(names))
	for _, name := range names {
		privateKey := readEd25519PrivateKey(t, filepath.Join(directory, name+"-private.pem"))
		publicKey := readEd25519PublicKey(t, filepath.Join(directory, name+"-public.pem"))
		derived, ok := privateKey.Public().(ed25519.PublicKey)
		if !ok || !bytes.Equal(derived, publicKey) {
			t.Fatalf("%s public/private key mismatch", name)
		}
		identity := string(publicKey)
		if previous, duplicate := seenPublicKeys[identity]; duplicate {
			t.Fatalf("Ed25519 material reused by %s and %s", previous, name)
		}
		seenPublicKeys[identity] = name
		clear(privateKey)
	}
}

func TestGeneratedTLSCertificatesCoverComposeAndHostNames(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	directory := filepath.Join(t.TempDir(), "bundle")
	if err := run([]string{directory}, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	ca := readCertificate(t, filepath.Join(directory, "local-production-root-ca.pem"))
	if !ca.IsCA {
		t.Fatal("root certificate is not a CA")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	serverNames := map[string][]string{
		"postgres-server":       {"postgres", "slots-postgres"},
		"valkey-server":         {"valkey", "slots-valkey"},
		"ingress-server":        {"slots.localhost", "rgs.localhost", "ingress", "web", "rgs"},
		"wallet-server":         {"wallet", "slots-wallet", "wallet-adapter"},
		"audit-server":          {"audit", "slots-audit", "audit-sink", "log-sink"},
		"local-operator-server": {"local-operator", "wallet", "audit", "log-sink"},
		"alertmanager-server":   {"alertmanager", "alert-proxy"},
	}
	serials := map[string]string{ca.SerialNumber.String(): "root"}
	for fileName, expectedNames := range serverNames {
		certificate := readCertificate(t, filepath.Join(directory, fileName+".pem"))
		if err := certificate.CheckSignatureFrom(ca); err != nil {
			t.Fatalf("%s is not signed by local CA: %v", fileName, err)
		}
		for _, expectedName := range append(expectedNames, "localhost", "127.0.0.1", "::1") {
			if err := certificate.VerifyHostname(expectedName); err != nil {
				t.Errorf("%s does not cover %s: %v", fileName, expectedName, err)
			}
		}
		if _, err := certificate.Verify(x509.VerifyOptions{
			Roots: roots, CurrentTime: now, DNSName: expectedNames[0],
			KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		}); err != nil {
			t.Fatalf("verify %s: %v", fileName, err)
		}
		assertTLSKeyMatchesCertificate(t, filepath.Join(directory, fileName+"-key.pem"), certificate)
		if previous, duplicate := serials[certificate.SerialNumber.String()]; duplicate {
			t.Fatalf("certificate serial reused by %s and %s", previous, fileName)
		}
		serials[certificate.SerialNumber.String()] = fileName
	}

	auditClient := readCertificate(t, filepath.Join(directory, "audit-client.pem"))
	if _, err := auditClient.Verify(x509.VerifyOptions{
		Roots: roots, CurrentTime: now,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("verify audit client certificate: %v", err)
	}
	assertTLSKeyMatchesCertificate(t, filepath.Join(directory, "audit-client-key.pem"), auditClient)
}

func TestGeneratedSecretsHaveExpectedEncodingAndDoNotReuseMaterial(t *testing.T) {
	directory := generateTestBundle(t)
	standardBase64 := []string{"launch-hmac.key", "outbox-hmac.key", "shared-admission-hmac.key"}
	rawURLBase64 := []string{
		"valkey-password",
		"operations.token", "grafana-admin-password", "alertmanager.token",
		"postgres-admin.password", "rgs-migrator.password", "rgs-runtime.password",
		"local-operator-owner.password", "local-operator-runtime.password",
		"local-operator-admin.token", "local-operator-metrics.token",
		"local-operator-audit-bearer.token", "local-operator-log-bearer.token",
	}
	seen := make(map[string]string)
	for _, name := range standardBase64 {
		encoded := strings.TrimSuffix(readTextFile(t, filepath.Join(directory, name)), "\n")
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != encoded {
			t.Fatalf("%s is not canonical standard base64 for 32 bytes", name)
		}
		if previous, duplicate := seen[encoded]; duplicate {
			t.Fatalf("secret reused by %s and %s", previous, name)
		}
		seen[encoded] = name
		clear(decoded)
	}
	for _, name := range rawURLBase64 {
		encoded := strings.TrimSuffix(readTextFile(t, filepath.Join(directory, name)), "\n")
		decoded, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != encoded {
			t.Fatalf("%s is not canonical raw URL base64 for 32 bytes", name)
		}
		if previous, duplicate := seen[encoded]; duplicate {
			t.Fatalf("secret reused by %s and %s", previous, name)
		}
		seen[encoded] = name
		clear(decoded)
	}
}

func TestAddSharedAdmissionMaterialUpgradesAnExistingBundleWithoutRotation(t *testing.T) {
	now := time.Date(2026, 8, 25, 1, 0, 0, 0, time.UTC)
	directory := filepath.Join(t.TempDir(), "bundle")
	if err := run([]string{directory}, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	existingDigest := fileSHA256(t, filepath.Join(directory, "launch-hmac.key"))
	for _, name := range sharedAdmissionMaterialNames {
		if err := os.Remove(filepath.Join(directory, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := run([]string{"add-shared-admission", directory}, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	if got := fileSHA256(t, filepath.Join(directory, "launch-hmac.key")); got != existingDigest {
		t.Fatal("existing secret rotated during shared admission augmentation")
	}
	certificate := readCertificate(t, filepath.Join(directory, "valkey-server.pem"))
	if err := certificate.VerifyHostname("valkey"); err != nil {
		t.Fatal(err)
	}
	assertTLSKeyMatchesCertificate(t, filepath.Join(directory, "valkey-server-key.pem"), certificate)
	if err := run([]string{"add-shared-admission", directory}, func() time.Time { return now.Add(time.Hour) }); err != nil {
		t.Fatalf("idempotent augmentation failed: %v", err)
	}
}

func TestRunRefusesToOverwriteOrFollowOutputSymlink(t *testing.T) {
	now := func() time.Time { return time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC) }
	directory := filepath.Join(t.TempDir(), "bundle")
	if err := run([]string{directory}, now); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{directory}, now); err == nil || !strings.Contains(err.Error(), "must be empty") {
		t.Fatalf("expected overwrite rejection, got %v", err)
	}

	realDirectory := t.TempDir()
	link := filepath.Join(t.TempDir(), "linked-output")
	if err := os.Symlink(realDirectory, link); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{link}, now); err == nil || !strings.Contains(err.Error(), "real directory") {
		t.Fatalf("expected symlink rejection, got %v", err)
	}
}

func generateTestBundle(t *testing.T) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "bundle")
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	if err := run([]string{directory}, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	return directory
}

func fileSHA256(t *testing.T, path string) [sha256.Size]byte {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(contents)
}

func readCertificate(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	block := readPEMBlock(t, path, "CERTIFICATE")
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse %s: %v", filepath.Base(path), err)
	}
	return certificate
}

func readEd25519PrivateKey(t *testing.T, path string) ed25519.PrivateKey {
	t.Helper()
	block := readPEMBlock(t, path, "PRIVATE KEY")
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		t.Fatalf("%s is not an Ed25519 private key", filepath.Base(path))
	}
	return key
}

func readEd25519PublicKey(t *testing.T, path string) ed25519.PublicKey {
	t.Helper()
	block := readPEMBlock(t, path, "PUBLIC KEY")
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("%s is not an Ed25519 public key", filepath.Base(path))
	}
	return key
}

func assertTLSKeyMatchesCertificate(t *testing.T, path string, certificate *x509.Certificate) {
	t.Helper()
	block := readPEMBlock(t, path, "PRIVATE KEY")
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		t.Fatalf("%s is not an ECDSA private key", filepath.Base(path))
	}
	publicKey, ok := certificate.PublicKey.(*ecdsa.PublicKey)
	if !ok || privateKey.PublicKey.X.Cmp(publicKey.X) != 0 || privateKey.PublicKey.Y.Cmp(publicKey.Y) != 0 {
		t.Fatalf("%s does not match certificate", filepath.Base(path))
	}
}

func readPEMBlock(t *testing.T, path, blockType string) *pem.Block {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	block, rest := pem.Decode(data)
	if block == nil || block.Type != blockType || len(bytes.TrimSpace(rest)) != 0 {
		t.Fatalf("%s does not contain exactly one %s PEM block", filepath.Base(path), blockType)
	}
	return block
}

func decodeJSONFile(t *testing.T, path string, target any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("decode %s: %v", filepath.Base(path), err)
	}
}

func readTextFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
