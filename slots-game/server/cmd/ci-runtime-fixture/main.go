// ci-runtime-fixture 命令只为 deploy/observability 的容器启动冒烟生成
// 仅限开发使用的临时信任材料。必须显式设置 RGS_CI_RUNTIME_FIXTURE=1；
// 这些材料会在 CI 退出时删除，绝不能作为生产审批或发布证据。
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"

	"slots-game/server/internal/game"
)

type signingKeyDocument struct {
	KeyID          string `json:"keyId"`
	NotBefore      string `json:"notBefore"`
	NotAfter       string `json:"notAfter"`
	PrivateKeyFile string `json:"privateKeyFile"`
	PublicKeyFile  string `json:"publicKeyFile"`
}

type verificationKeyDocument struct {
	KeyID         string `json:"keyId"`
	NotBefore     string `json:"notBefore"`
	NotAfter      string `json:"notAfter"`
	PublicKeyFile string `json:"publicKeyFile"`
}

type walletDocument struct {
	BaseURL                  string                    `json:"baseUrl"`
	RequestSigningKey        signingKeyDocument        `json:"requestSigningKey"`
	ResponseVerificationKeys []verificationKeyDocument `json:"responseVerificationKeys"`
}

type operatorDocumentEntry struct {
	OperatorID                      string                    `json:"operatorId"`
	AccessTokenSigningKey           signingKeyDocument        `json:"accessTokenSigningKey"`
	OperatorRequestVerificationKeys []verificationKeyDocument `json:"operatorRequestVerificationKeys"`
	OperatorResponseSigningKey      signingKeyDocument        `json:"operatorResponseSigningKey"`
	Wallet                          walletDocument            `json:"wallet"`
}

type operatorDocument struct {
	Schema        string                  `json:"schema"`
	TokenIssuer   string                  `json:"tokenIssuer"`
	TokenAudience string                  `json:"tokenAudience"`
	Operators     []operatorDocumentEntry `json:"operators"`
}

const (
	fixtureProfileDevelopment = "development"
	fixtureProfileProduction  = "production"
)

func main() {
	if err := run(os.Args[1:], os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(arguments []string, getenv func(string) string) error {
	if getenv == nil || getenv("RGS_CI_RUNTIME_FIXTURE") != "1" {
		return errors.New("ci-runtime-fixture is disabled outside the explicit CI smoke")
	}
	if len(arguments) != 1 {
		return errors.New("usage: ci-runtime-fixture OUTPUT_DIRECTORY")
	}
	directory, err := filepath.Abs(arguments[0])
	if err != nil {
		return errors.New("resolve fixture output directory")
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return errors.New("fixture output directory must already exist")
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("fixture output must be a real directory")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return errors.New("read fixture output directory")
	}
	if len(entries) != 0 {
		return errors.New("fixture output directory must be empty")
	}
	profile := getenv("RGS_CI_RUNTIME_FIXTURE_PROFILE")
	if profile == "" {
		profile = fixtureProfileDevelopment
	}
	if profile != fixtureProfileDevelopment && profile != fixtureProfileProduction {
		return errors.New("ci-runtime-fixture profile must be development or production")
	}
	return generate(directory, time.Now().UTC().Truncate(time.Second), profile)
}

func generate(directory string, now time.Time, profile string) error {
	from := now.Add(-time.Hour).Format(time.RFC3339)
	until := now.Add(24 * time.Hour).Format(time.RFC3339)

	definition := game.DemoConfig()
	if profile == fixtureProfileProduction {
		// 只让持续集成走到生产模式的真实失败闭合分支；该身份刻意包含 ci-only 标记，
		// 且其审批引用全部声明非发布证据，绝不能移入发布配置。
		definition.GameID = "iron-colossus-ci-only-contract"
		definition.DefinitionVersion = "ci-only-contract-2026-08-16"
	}
	digest, err := game.DefinitionDigest(definition)
	if err != nil {
		return err
	}
	approvalPublic, approvalPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	defer clear(approvalPrivate)
	approvalMetadata := game.DefinitionApproval{
		GameID: definition.GameID, Version: definition.DefinitionVersion, SHA256: digest,
		Status: "APPROVED", ApprovalRef: "ci-runtime-smoke-not-release-evidence",
	}
	var approval game.SignedDefinitionApproval
	if profile == fixtureProfileProduction {
		approvalMetadata.ApprovalRef = "ci-only-not-release-evidence:definition"
		approvalMetadata.ProductionEvidence = &game.DefinitionApprovalEvidence{
			MathReportRefs: []string{"ci-only-not-release-evidence:math"},
			RNGReportRefs:  []string{"ci-only-not-release-evidence:rng"},
			JurisdictionApprovals: []game.DefinitionJurisdictionEvidence{{
				Jurisdiction: "CI-ONLY", ApprovalRef: "ci-only-not-release-evidence:jurisdiction",
			}},
		}
		approval, err = game.SignProductionDefinitionApproval(
			approvalMetadata, "ci-only-contract-key", approvalPrivate,
		)
	} else {
		approval, err = game.SignDefinitionApproval(
			approvalMetadata, "ci-runtime-smoke-key", approvalPrivate,
		)
	}
	if err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(directory, "definition.json"), definition); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(directory, "definition-approval.json"), approval); err != nil {
		return err
	}
	if err := writePublicKey(filepath.Join(directory, "definition-approval-public.pem"), approvalPublic); err != nil {
		return err
	}

	accessPrivate, accessPublic, err := writeKeyPair(directory, "access")
	if err != nil {
		return err
	}
	_, operatorRequestPublic, err := writeKeyPair(directory, "operator-request")
	if err != nil {
		return err
	}
	operatorResponsePrivate, operatorResponsePublic, err := writeKeyPair(directory, "operator-response")
	if err != nil {
		return err
	}
	walletRequestPrivate, walletRequestPublic, err := writeKeyPair(directory, "wallet-request")
	if err != nil {
		return err
	}
	_, walletResponsePublic, err := writeKeyPair(directory, "wallet-response")
	if err != nil {
		return err
	}
	walletBaseURL := "http://127.0.0.1:18082/rgs/"
	if profile == fixtureProfileProduction {
		walletBaseURL = "https://127.0.0.1:18444/rgs/"
	}
	operators := operatorDocument{
		Schema: "rgs-operators-v2", TokenIssuer: "https://ci.invalid/rgs",
		TokenAudience: "ci-runtime-smoke-client",
		Operators: []operatorDocumentEntry{{
			OperatorID: "ci-operator",
			AccessTokenSigningKey: signingKeyDocument{
				KeyID: "access-ci", NotBefore: from, NotAfter: until,
				PrivateKeyFile: accessPrivate, PublicKeyFile: accessPublic,
			},
			OperatorRequestVerificationKeys: []verificationKeyDocument{{
				KeyID: "operator-request-ci", NotBefore: from, NotAfter: until,
				PublicKeyFile: operatorRequestPublic,
			}},
			OperatorResponseSigningKey: signingKeyDocument{
				KeyID: "operator-response-ci", NotBefore: from, NotAfter: until,
				PrivateKeyFile: operatorResponsePrivate, PublicKeyFile: operatorResponsePublic,
			},
			Wallet: walletDocument{
				BaseURL: walletBaseURL,
				RequestSigningKey: signingKeyDocument{
					KeyID: "wallet-request-ci", NotBefore: from, NotAfter: until,
					PrivateKeyFile: walletRequestPrivate, PublicKeyFile: walletRequestPublic,
				},
				ResponseVerificationKeys: []verificationKeyDocument{{
					KeyID: "wallet-response-ci", NotBefore: from, NotAfter: until,
					PublicKeyFile: walletResponsePublic,
				}},
			},
		}},
	}
	if err := writeJSON(filepath.Join(directory, "operators.json"), operators); err != nil {
		return err
	}
	if err := writeRandomBase64(filepath.Join(directory, "launch-hmac.key"), 32, false); err != nil {
		return err
	}
	if err := writeRandomBase64(filepath.Join(directory, "operations.token"), 32, true); err != nil {
		return err
	}
	if profile != fixtureProfileProduction {
		return nil
	}
	if err := writeRandomBase64(filepath.Join(directory, "outbox-hmac.key"), 32, false); err != nil {
		return err
	}
	if err := writeCIOnlyTLSMaterial(directory, now); err != nil {
		return err
	}
	return write(
		filepath.Join(directory, "CI_ONLY_NOT_RELEASE_EVIDENCE"),
		[]byte("EPHEMERAL CI-ONLY PRODUCTION-CONFIGURATION FIXTURE; NOT RELEASE EVIDENCE\n"),
		0o600,
	)
}

func writeCIOnlyTLSMaterial(directory string, now time.Time) error {
	caPublic, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	defer clear(caPrivate)
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "RGS CI Only Not Release Evidence Root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caPublic, caPrivate)
	if err != nil {
		return err
	}
	if err := write(
		filepath.Join(directory, "ci-root-ca.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		0o600,
	); err != nil {
		return err
	}
	for index, name := range []string{"audit-server", "postgres-server"} {
		publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		serial := big.NewInt(int64(index + 2))
		template := &x509.Certificate{
			SerialNumber: serial,
			Subject:      pkix.Name{CommonName: "RGS CI Only " + name},
			NotBefore:    now.Add(-time.Hour),
			NotAfter:     now.Add(24 * time.Hour),
			KeyUsage:     x509.KeyUsageDigitalSignature,
			ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			DNSNames:     []string{"localhost"},
			IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		}
		certificateDER, createErr := x509.CreateCertificate(
			rand.Reader, template, caTemplate, publicKey, caPrivate,
		)
		if createErr != nil {
			clear(privateKey)
			return createErr
		}
		privateDER, marshalErr := x509.MarshalPKCS8PrivateKey(privateKey)
		clear(privateKey)
		if marshalErr != nil {
			return marshalErr
		}
		if err := write(
			filepath.Join(directory, name+".pem"),
			pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}),
			0o600,
		); err != nil {
			return err
		}
		if err := write(
			filepath.Join(directory, name+"-key.pem"),
			pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}),
			0o600,
		); err != nil {
			return err
		}
	}
	return nil
}

func writeKeyPair(directory, name string) (string, string, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	defer clear(privateKey)
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return "", "", err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", "", err
	}
	privateName := name + "-private.pem"
	publicName := name + "-public.pem"
	if err := write(filepath.Join(directory, privateName), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0o600); err != nil {
		return "", "", err
	}
	if err := write(filepath.Join(directory, publicName), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}), 0o600); err != nil {
		return "", "", err
	}
	return privateName, publicName, nil
}

func writePublicKey(path string, key ed25519.PublicKey) error {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return err
	}
	return write(path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600)
}

func writeRandomBase64(path string, size int, rawURL bool) error {
	value := make([]byte, size)
	defer clear(value)
	if _, err := rand.Read(value); err != nil {
		return err
	}
	encoded := base64.StdEncoding.EncodeToString(value)
	if rawURL {
		encoded = base64.RawURLEncoding.EncodeToString(value)
	}
	return write(path, []byte(encoded+"\n"), 0o600)
}

func writeJSON(path string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return write(path, encoded, 0o600)
}

func write(path string, value []byte, permission os.FileMode) error {
	if err := os.WriteFile(path, value, permission); err != nil {
		return fmt.Errorf("write %s: %w", filepath.Base(path), err)
	}
	return nil
}
