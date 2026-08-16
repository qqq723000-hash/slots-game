package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"slots-game/server/internal/game"
)

func TestRunRequiresExplicitCIGate(t *testing.T) {
	err := run([]string{t.TempDir()}, func(string) string { return "" })
	if err == nil || !strings.Contains(err.Error(), "disabled outside") {
		t.Fatalf("run without CI gate error = %v", err)
	}
}

func TestRunGeneratesEphemeralDevelopmentFixture(t *testing.T) {
	directory := t.TempDir()
	if err := run([]string{directory}, func(name string) string {
		if name == "RGS_CI_RUNTIME_FIXTURE" {
			return "1"
		}
		return ""
	}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"definition.json",
		"definition-approval.json",
		"definition-approval-public.pem",
		"operators.json",
		"launch-hmac.key",
		"operations.token",
	} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil || info.Size() == 0 {
			t.Fatalf("generated %s stat = (%v, %v)", name, info, err)
		}
	}

	var approval game.SignedDefinitionApproval
	encoded, err := os.ReadFile(filepath.Join(directory, "definition-approval.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &approval); err != nil {
		t.Fatal(err)
	}
	if approval.Schema != game.DefinitionApprovalSchemaV1 ||
		approval.Approval.ApprovalRef != "ci-runtime-smoke-not-release-evidence" ||
		!strings.Contains(approval.Approval.GameID, "demo") {
		t.Fatalf("fixture could be mistaken for release evidence: %+v", approval.Approval)
	}
}

func TestRunRefusesNonEmptyOutputDirectory(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "keep"), []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := run([]string{directory}, func(string) string { return "1" })
	if err == nil || !strings.Contains(err.Error(), "must be empty") {
		t.Fatalf("run non-empty output error = %v", err)
	}
}

func TestRunGeneratesExplicitCIOnlyProductionConfigurationFixture(t *testing.T) {
	directory := t.TempDir()
	if err := run([]string{directory}, func(name string) string {
		switch name {
		case "RGS_CI_RUNTIME_FIXTURE":
			return "1"
		case "RGS_CI_RUNTIME_FIXTURE_PROFILE":
			return "production"
		default:
			return ""
		}
	}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"CI_ONLY_NOT_RELEASE_EVIDENCE",
		"ci-root-ca.pem",
		"audit-server.pem",
		"audit-server-key.pem",
		"postgres-server.pem",
		"postgres-server-key.pem",
		"outbox-hmac.key",
	} {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil || info.Size() == 0 {
			t.Fatalf("generated production-configuration fixture %s stat = (%v, %v)", name, info, err)
		}
	}

	var approval game.SignedDefinitionApproval
	encoded, err := os.ReadFile(filepath.Join(directory, "definition-approval.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &approval); err != nil {
		t.Fatal(err)
	}
	evidence := approval.Approval.ProductionEvidence
	if approval.Schema != game.DefinitionApprovalSchemaV2 ||
		strings.Contains(strings.ToLower(approval.Approval.GameID), "demo") ||
		evidence == nil ||
		len(evidence.MathReportRefs) != 1 ||
		!strings.Contains(evidence.MathReportRefs[0], "ci-only-not-release-evidence") ||
		len(evidence.RNGReportRefs) != 1 ||
		!strings.Contains(evidence.RNGReportRefs[0], "ci-only-not-release-evidence") ||
		len(evidence.JurisdictionApprovals) != 1 ||
		!strings.Contains(evidence.JurisdictionApprovals[0].ApprovalRef, "ci-only-not-release-evidence") {
		t.Fatalf("fixture could be mistaken for real production approval: %+v", approval.Approval)
	}

	var operators operatorDocument
	encoded, err = os.ReadFile(filepath.Join(directory, "operators.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &operators); err != nil {
		t.Fatal(err)
	}
	if len(operators.Operators) != 1 ||
		!strings.HasPrefix(operators.Operators[0].Wallet.BaseURL, "https://") {
		t.Fatalf("production configuration fixture wallet is not HTTPS: %+v", operators)
	}

	ca := parseCertificateFixture(t, filepath.Join(directory, "ci-root-ca.pem"))
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	for _, name := range []string{"audit-server", "postgres-server"} {
		certificate := parseCertificateFixture(t, filepath.Join(directory, name+".pem"))
		if _, err := certificate.Verify(x509.VerifyOptions{
			Roots: roots, DNSName: "127.0.0.1",
			KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		}); err != nil {
			t.Fatalf("verify %s CI-only TLS certificate: %v", name, err)
		}
		encodedKey, err := os.ReadFile(filepath.Join(directory, name+"-key.pem"))
		if err != nil {
			t.Fatal(err)
		}
		block, _ := pem.Decode(encodedKey)
		if block == nil || block.Type != "PRIVATE KEY" {
			t.Fatalf("%s private key PEM is invalid", name)
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		privateKey, ok := parsed.(ed25519.PrivateKey)
		publicKey, publicOK := certificate.PublicKey.(ed25519.PublicKey)
		if !ok || !publicOK || !bytes.Equal(privateKey.Public().(ed25519.PublicKey), publicKey) {
			t.Fatalf("%s certificate/private key mismatch", name)
		}
	}
	encodedHMAC, err := os.ReadFile(filepath.Join(directory, "outbox-hmac.key"))
	if err != nil {
		t.Fatal(err)
	}
	decodedHMAC, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encodedHMAC)))
	if err != nil || len(decodedHMAC) != 32 {
		t.Fatalf("outbox HMAC fixture is not canonical 256-bit base64: %v", err)
	}
}

func TestRunRejectsUnknownFixtureProfile(t *testing.T) {
	err := run([]string{t.TempDir()}, func(name string) string {
		if name == "RGS_CI_RUNTIME_FIXTURE" {
			return "1"
		}
		return "release-evidence"
	})
	if err == nil || !strings.Contains(err.Error(), "fixture profile") {
		t.Fatalf("run unknown fixture profile error = %v", err)
	}
}

func parseCertificateFixture(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	block, trailing := pem.Decode(encoded)
	if block == nil || block.Type != "CERTIFICATE" || len(trailing) != 0 {
		t.Fatalf("invalid certificate fixture %s", filepath.Base(path))
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}
