// local-production-bootstrap 命令为本机集成验收生成一次性初始化材料。
//
// 该命令只接受一个空目录，绝不覆盖既有文件。生成结果属于
// LOCAL_TECHNICAL_PRODUCTION：它满足运行时生产配置校验，但审批引用仅表示
// 用户授权的本机技术部署，不对外部监管、认证或第三方权利作任何声明。
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
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

const (
	environmentClass = "LOCAL_TECHNICAL_PRODUCTION"
	authorityRef     = "user-authorized-local-production"
	operatorID       = "local-production-operator"
	walletBaseURL    = "https://wallet:8443/rgs/"
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

// localOperatorKeyDocument 只引用本机配套服务实际需要的协议方向。
// 私钥方向与 RGS 配置严格互补，避免部署层手工拼接后误用身份。
type localOperatorKeyDocument struct {
	Schema                        string                    `json:"schema"`
	OperatorID                    string                    `json:"operatorId"`
	WalletRequestVerificationKeys []verificationKeyDocument `json:"walletRequestVerificationKeys"`
	WalletResponseSigningKey      signingKeyDocument        `json:"walletResponseSigningKey"`
	LaunchRequestSigningKey       signingKeyDocument        `json:"launchRequestSigningKey"`
	RGSResponseVerificationKeys   []verificationKeyDocument `json:"rgsResponseVerificationKeys"`
}

type deploymentMetadata struct {
	Schema                   string   `json:"schema"`
	EnvironmentClass         string   `json:"environmentClass"`
	AuthorityReference       string   `json:"authorityReference"`
	Scope                    string   `json:"scope"`
	GeneratedAt              string   `json:"generatedAt"`
	RotateBefore             string   `json:"rotateBefore"`
	ExternalClaimsMade       bool     `json:"externalClaimsMade"`
	DefinitionApprovalSchema string   `json:"definitionApprovalSchema"`
	OperatorSchema           string   `json:"operatorSchema"`
	TLSNames                 []string `json:"tlsNames"`
}

type certificateAuthority struct {
	certificate *x509.Certificate
	privateKey  *ecdsa.PrivateKey
}

type certificateProfile struct {
	name        string
	commonName  string
	dnsNames    []string
	extKeyUsage []x509.ExtKeyUsage
}

func main() {
	if err := run(os.Args[1:], time.Now); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(arguments []string, now func() time.Time) error {
	if now == nil {
		return errors.New("clock is required")
	}
	if len(arguments) == 2 && arguments[0] == "add-shared-admission" {
		directory, err := existingOutputDirectory(arguments[1])
		if err != nil {
			return err
		}
		return addSharedAdmissionMaterial(directory, now().UTC().Truncate(time.Second))
	}
	if len(arguments) != 1 {
		return errors.New("usage: local-production-bootstrap [add-shared-admission] OUTPUT_DIRECTORY")
	}
	directory, err := prepareOutputDirectory(arguments[0])
	if err != nil {
		return err
	}
	return generate(directory, now().UTC().Truncate(time.Second))
}

func existingOutputDirectory(configured string) (string, error) {
	if configured == "" {
		return "", errors.New("output directory is required")
	}
	directory, err := filepath.Abs(configured)
	if err != nil {
		return "", errors.New("resolve output directory")
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", fmt.Errorf("inspect output directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		return "", errors.New("existing output must be a real 0700 directory")
	}
	return directory, nil
}

func prepareOutputDirectory(configured string) (string, error) {
	if configured == "" {
		return "", errors.New("output directory is required")
	}
	directory, err := filepath.Abs(configured)
	if err != nil {
		return "", errors.New("resolve output directory")
	}
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return "", fmt.Errorf("create output directory: %w", err)
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return "", fmt.Errorf("inspect output directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("output must be a real directory")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return "", fmt.Errorf("restrict output directory permissions: %w", err)
	}
	// 初始化材料不可原地覆盖，否则配置文件与密钥可能来自不同代次。
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", fmt.Errorf("read output directory: %w", err)
	}
	if len(entries) != 0 {
		return "", errors.New("output directory must be empty")
	}
	return directory, nil
}

func generate(directory string, now time.Time) error {
	keyNotBefore := now.Add(-5 * time.Minute).Format(time.RFC3339)
	keyNotAfterTime := now.Add(365 * 24 * time.Hour)
	keyNotAfter := keyNotAfterTime.Format(time.RFC3339)

	definition := localProductionDefinition()
	digest, err := game.DefinitionDigest(definition)
	if err != nil {
		return err
	}
	approvalPublic, approvalPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate definition approval key: %w", err)
	}
	defer clear(approvalPrivate)
	approval, err := game.SignProductionDefinitionApproval(game.DefinitionApproval{
		GameID: definition.GameID, Version: definition.DefinitionVersion, SHA256: digest,
		Status: "APPROVED", ApprovalRef: authorityRef + ":definition",
		ProductionEvidence: &game.DefinitionApprovalEvidence{
			MathReportRefs: []string{authorityRef + ":math-definition"},
			RNGReportRefs:  []string{authorityRef + ":rng-runtime"},
			JurisdictionApprovals: []game.DefinitionJurisdictionEvidence{{
				Jurisdiction: "LOCAL", ApprovalRef: authorityRef + ":jurisdiction-local",
			}},
		},
	}, "local-production-definition-key", approvalPrivate)
	if err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(directory, "definition.json"), definition); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(directory, "definition-approval.json"), approval); err != nil {
		return err
	}
	if err := writeEd25519Pair(directory, "definition-approval", approvalPublic, approvalPrivate); err != nil {
		return err
	}

	// 每个协议方向使用独立密钥，避免一个服务泄露后横向伪造其他身份。
	accessPrivate, accessPublic, err := generateEd25519Pair(directory, "access")
	if err != nil {
		return err
	}
	operatorRequestPrivate, operatorRequestPublic, err := generateEd25519Pair(directory, "operator-request")
	if err != nil {
		return err
	}
	operatorResponsePrivate, operatorResponsePublic, err := generateEd25519Pair(directory, "operator-response")
	if err != nil {
		return err
	}
	walletRequestPrivate, walletRequestPublic, err := generateEd25519Pair(directory, "wallet-request")
	if err != nil {
		return err
	}
	walletResponsePrivate, walletResponsePublic, err := generateEd25519Pair(directory, "wallet-response")
	if err != nil {
		return err
	}
	operators := operatorDocument{
		Schema: "rgs-operators-v2", TokenIssuer: "https://rgs.localhost",
		TokenAudience: "slots-production-client",
		Operators: []operatorDocumentEntry{{
			OperatorID: operatorID,
			AccessTokenSigningKey: signingKeyDocument{
				KeyID: "local-access-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
				PrivateKeyFile: accessPrivate, PublicKeyFile: accessPublic,
			},
			OperatorRequestVerificationKeys: []verificationKeyDocument{{
				KeyID: "local-operator-request-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
				PublicKeyFile: operatorRequestPublic,
			}},
			OperatorResponseSigningKey: signingKeyDocument{
				KeyID: "local-operator-response-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
				PrivateKeyFile: operatorResponsePrivate, PublicKeyFile: operatorResponsePublic,
			},
			Wallet: walletDocument{
				BaseURL: walletBaseURL,
				RequestSigningKey: signingKeyDocument{
					KeyID: "local-wallet-request-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
					PrivateKeyFile: walletRequestPrivate, PublicKeyFile: walletRequestPublic,
				},
				ResponseVerificationKeys: []verificationKeyDocument{{
					KeyID: "local-wallet-response-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
					PublicKeyFile: walletResponsePublic,
				}},
			},
		}},
	}
	if err := writeJSON(filepath.Join(directory, "operators.json"), operators); err != nil {
		return err
	}
	localOperatorKeys := localOperatorKeyDocument{
		Schema: "local-operator-keys-v1", OperatorID: operatorID,
		WalletRequestVerificationKeys: []verificationKeyDocument{{
			KeyID: "local-wallet-request-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
			PublicKeyFile: walletRequestPublic,
		}},
		WalletResponseSigningKey: signingKeyDocument{
			KeyID: "local-wallet-response-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
			PrivateKeyFile: walletResponsePrivate, PublicKeyFile: walletResponsePublic,
		},
		LaunchRequestSigningKey: signingKeyDocument{
			KeyID: "local-operator-request-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
			PrivateKeyFile: operatorRequestPrivate, PublicKeyFile: operatorRequestPublic,
		},
		RGSResponseVerificationKeys: []verificationKeyDocument{{
			KeyID: "local-operator-response-1", NotBefore: keyNotBefore, NotAfter: keyNotAfter,
			PublicKeyFile: operatorResponsePublic,
		}},
	}
	if err := writeJSON(filepath.Join(directory, "local-operator-keys.json"), localOperatorKeys); err != nil {
		return err
	}

	// HMAC 密钥使用运行时加载器要求的标准 Base64；口令和承载令牌使用不含命令行及
	// URL 特殊字符的 RawURL Base64，便于作为容器密钥注入。
	for _, secret := range []struct {
		name       string
		size       int
		standard64 bool
	}{
		{name: "launch-hmac.key", size: 32, standard64: true},
		{name: "outbox-hmac.key", size: 32, standard64: true},
		{name: "shared-admission-hmac.key", size: 32, standard64: true},
		{name: "valkey-password", size: 32},
		{name: "operations.token", size: 32},
		{name: "grafana-admin-password", size: 32},
		{name: "alertmanager.token", size: 32},
		{name: "postgres-admin.password", size: 32},
		{name: "rgs-migrator.password", size: 32},
		{name: "rgs-runtime.password", size: 32},
		{name: "local-operator-owner.password", size: 32},
		{name: "local-operator-runtime.password", size: 32},
		{name: "local-operator-admin.token", size: 32},
		{name: "local-operator-metrics.token", size: 32},
		{name: "local-operator-audit-bearer.token", size: 32},
		{name: "local-operator-log-bearer.token", size: 32},
	} {
		if err := writeRandomSecret(filepath.Join(directory, secret.name), secret.size, secret.standard64); err != nil {
			return err
		}
	}

	// 私有 CA 只用于这台机器的服务间 TLS；部署层必须按文件最小挂载，
	// 不能把 CA 私钥暴露给任何在线服务。
	ca, err := writeCertificateAuthority(directory, now)
	if err != nil {
		return err
	}
	profiles := []certificateProfile{
		{
			name: "postgres-server", commonName: "postgres",
			dnsNames:    []string{"localhost", "postgres", "slots-postgres"},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "valkey-server", commonName: "valkey",
			dnsNames:    []string{"localhost", "valkey", "slots-valkey"},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "ingress-server", commonName: "slots.localhost",
			dnsNames: []string{
				"localhost", "ingress", "slots-ingress", "web", "rgs", "rgs-server",
				"slots.localhost", "rgs.localhost",
			},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "wallet-server", commonName: "wallet",
			dnsNames:    []string{"localhost", "wallet", "slots-wallet", "wallet-adapter"},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "audit-server", commonName: "audit",
			dnsNames:    []string{"localhost", "audit", "slots-audit", "audit-sink", "log-sink"},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "local-operator-server", commonName: "local-operator",
			dnsNames: []string{
				"localhost", "local-operator", "wallet", "slots-wallet", "audit", "slots-audit", "log-sink",
			},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "alertmanager-server", commonName: "alertmanager",
			dnsNames:    []string{"localhost", "alertmanager", "alert-proxy"},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		},
		{
			name: "audit-client", commonName: "rgs-outbox",
			dnsNames:    []string{"localhost", "rgs", "rgs-server"},
			extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		},
	}
	for _, profile := range profiles {
		if err := writeLeafCertificate(directory, now, ca, profile); err != nil {
			return err
		}
	}

	metadata := deploymentMetadata{
		Schema: "slots-local-technical-production-v1", EnvironmentClass: environmentClass,
		AuthorityReference: authorityRef, Scope: "local-machine",
		GeneratedAt: now.Format(time.RFC3339), RotateBefore: keyNotAfterTime.Format(time.RFC3339),
		ExternalClaimsMade: false, DefinitionApprovalSchema: game.DefinitionApprovalSchemaV2,
		OperatorSchema: "rgs-operators-v2",
		TLSNames: []string{
			"slots.localhost", "rgs.localhost", "local-operator", "wallet", "audit", "alertmanager", "postgres", "valkey",
		},
	}
	return writeJSON(filepath.Join(directory, "deployment-metadata.json"), metadata)
}

func localProductionDefinition() game.Config {
	// 将当前引擎支持的完整数学参数固化为非演示用途的生产身份，避免运行时依赖
	// 开发默认值或环境分支。版本变化必须重新生成摘要和 v2 签名审批。
	return game.Config{
		GameID: "iron-colossus", DefinitionVersion: "local-production-2026-08-16.1",
		Bet: game.BetConfig{
			MinMinor: 10, MaxMinor: 10_000, StepMinor: 10, PayUnitMinor: 100,
			DefaultMinor: 100,
			OptionsMinor: []int64{10, 20, 50, 100, 200, 300, 400, 600, 1_000, 2_000, 5_000, 10_000},
		},
		Reels: [3][]game.WeightedSymbol{
			{
				{Value: game.SymbolOrbit, Weight: 22}, {Value: game.SymbolPrism, Weight: 21},
				{Value: game.SymbolPulse, Weight: 19}, {Value: game.SymbolNova, Weight: 17},
				{Value: game.SymbolCircuit, Weight: 9}, {Value: game.SymbolTank, Weight: 6},
				{Value: game.SymbolSurge, Weight: 6},
			},
			{
				{Value: game.SymbolOrbit, Weight: 19}, {Value: game.SymbolPrism, Weight: 18},
				{Value: game.SymbolPulse, Weight: 17}, {Value: game.SymbolNova, Weight: 15},
				{Value: game.SymbolCircuit, Weight: 9}, {Value: game.SymbolTank, Weight: 5},
				{Value: game.SymbolWild, Weight: 7}, {Value: game.SymbolVault, Weight: 5},
				{Value: game.SymbolSurge, Weight: 5},
			},
			{
				{Value: game.SymbolOrbit, Weight: 22}, {Value: game.SymbolPrism, Weight: 20},
				{Value: game.SymbolPulse, Weight: 19}, {Value: game.SymbolNova, Weight: 17},
				{Value: game.SymbolCircuit, Weight: 10}, {Value: game.SymbolTank, Weight: 6},
				{Value: game.SymbolSurge, Weight: 6},
			},
		},
		Paytable: map[game.Symbol]int64{
			game.SymbolPrism: 10, game.SymbolOrbit: 30, game.SymbolPulse: 80,
			game.SymbolNova: 100, game.SymbolTank: 150, game.SymbolCircuit: 200,
		},
		WildMultipliers: []game.WeightedInt{
			{Value: 0, Weight: 30}, {Value: 1, Weight: 25}, {Value: 2, Weight: 24},
			{Value: 3, Weight: 10}, {Value: 5, Weight: 6}, {Value: 10, Weight: 3},
			{Value: 25, Weight: 1}, {Value: 50, Weight: 1}, {Value: 100, Weight: 1},
		},
		VaultMultipliers: []game.WeightedInt{
			{Value: 1, Weight: 22}, {Value: 2, Weight: 18}, {Value: 3, Weight: 15},
			{Value: 4, Weight: 12}, {Value: 5, Weight: 9}, {Value: 6, Weight: 7},
			{Value: 7, Weight: 5}, {Value: 8, Weight: 4}, {Value: 9, Weight: 3},
			{Value: 10, Weight: 3}, {Value: 30, Weight: 1}, {Value: 75, Weight: 1},
			{Value: 250, Weight: 1}, {Value: 1000, Weight: 1},
		},
		OverdriveMultipliers: []game.WeightedInt{
			{Value: 2, Weight: 18}, {Value: 3, Weight: 16}, {Value: 4, Weight: 14},
			{Value: 5, Weight: 12}, {Value: 6, Weight: 10}, {Value: 7, Weight: 8},
			{Value: 8, Weight: 7}, {Value: 9, Weight: 6}, {Value: 10, Weight: 5},
			{Value: 20, Weight: 3}, {Value: 30, Weight: 4}, {Value: 60, Weight: 2},
			{Value: 75, Weight: 3}, {Value: 150, Weight: 2}, {Value: 250, Weight: 2},
			{Value: 500, Weight: 1}, {Value: 1000, Weight: 1},
		},
		Feature: game.FeatureConfig{
			SurgeOneChanceBP: 800, SurgeTwoChanceBP: 2_400,
			InitialFreeSpins: 8, MaxExpansionSpins: 30,
			VaultUnlockChanceBP: 2_500, VaultFreeSpinWeight: 8,
			KingSpinUpgradeChanceBP: 2_800, KingSpinMaxUpgradeRounds: 3,
			OverdriveDoubleChanceBP: 1_500,
			ExpansionRows: []game.WeightedInt{
				{Value: 3, Weight: 1}, {Value: 4, Weight: 1}, {Value: 5, Weight: 1},
				{Value: 6, Weight: 1}, {Value: 7, Weight: 1}, {Value: 8, Weight: 1},
			},
			RageLevelThresholds: []int{0, 12, 24, 36, 48, 60},
			Wheel: []game.WeightedWheel{
				{Kind: game.WheelInstant, Multiplier: 10, Weight: 35},
				{Kind: game.WheelInstant, Multiplier: 30, Weight: 25},
				{Kind: game.WheelInstant, Multiplier: 75, Weight: 15},
				{Kind: game.WheelInstant, Multiplier: 250, Weight: 8},
				{Kind: game.WheelInstant, Multiplier: 1000, Weight: 2},
				{Kind: game.WheelExpansion, Weight: 9},
				{Kind: game.WheelOverdrive, Weight: 6},
			},
		},
	}
}

func generateEd25519Pair(directory, name string) (string, string, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate %s key: %w", name, err)
	}
	defer clear(privateKey)
	if err := writeEd25519Pair(directory, name, publicKey, privateKey); err != nil {
		return "", "", err
	}
	return name + "-private.pem", name + "-public.pem", nil
}

func writeEd25519Pair(
	directory, name string,
	publicKey ed25519.PublicKey,
	privateKey ed25519.PrivateKey,
) error {
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return fmt.Errorf("marshal %s private key: %w", name, err)
	}
	defer clear(privateDER)
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return fmt.Errorf("marshal %s public key: %w", name, err)
	}
	if err := writeExclusive(
		filepath.Join(directory, name+"-private.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}),
	); err != nil {
		return err
	}
	return writeExclusive(
		filepath.Join(directory, name+"-public.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}),
	)
}

func writeRandomSecret(path string, size int, standardBase64 bool) error {
	value := make([]byte, size)
	defer clear(value)
	if _, err := rand.Read(value); err != nil {
		return fmt.Errorf("generate %s: %w", filepath.Base(path), err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(value)
	if standardBase64 {
		encoded = base64.StdEncoding.EncodeToString(value)
	}
	return writeExclusive(path, []byte(encoded+"\n"))
}

var sharedAdmissionMaterialNames = []string{
	"shared-admission-hmac.key",
	"valkey-password",
	"valkey-server-key.pem",
	"valkey-server.pem",
}

// addSharedAdmissionMaterial 在不轮换或复制任何既有密钥的前提下升级 Valkey 引入前的
// 本地状态目录。材料包不完整时失败关闭，防止中断或人工迁移静默混用不同代际。
func addSharedAdmissionMaterial(directory string, now time.Time) error {
	present := 0
	for _, name := range sharedAdmissionMaterialNames {
		info, err := os.Lstat(filepath.Join(directory, name))
		if err == nil {
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
				return fmt.Errorf("%s must be a restricted regular file", name)
			}
			present++
			continue
		}
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect %s: %w", name, err)
		}
	}
	if present == len(sharedAdmissionMaterialNames) {
		return nil
	}
	if present != 0 {
		return errors.New("shared admission material is incomplete; refusing to mix generations")
	}

	ca, err := readCertificateAuthority(directory)
	if err != nil {
		return err
	}
	if err := writeRandomSecret(filepath.Join(directory, "shared-admission-hmac.key"), 32, true); err != nil {
		return err
	}
	if err := writeRandomSecret(filepath.Join(directory, "valkey-password"), 32, false); err != nil {
		return err
	}
	return writeLeafCertificate(directory, now, ca, certificateProfile{
		name: "valkey-server", commonName: "valkey",
		dnsNames:    []string{"localhost", "valkey", "slots-valkey"},
		extKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
}

func readCertificateAuthority(directory string) (certificateAuthority, error) {
	certificatePEM, err := readRestrictedMaterial(filepath.Join(directory, "local-production-root-ca.pem"))
	if err != nil {
		return certificateAuthority{}, err
	}
	certificateBlock, certificateRest := pem.Decode(certificatePEM)
	if certificateBlock == nil || certificateBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(certificateRest)) != 0 {
		return certificateAuthority{}, errors.New("local production root CA certificate is invalid")
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil || !certificate.IsCA {
		return certificateAuthority{}, errors.New("local production root CA certificate is invalid")
	}

	privatePEM, err := readRestrictedMaterial(filepath.Join(directory, "local-production-root-ca-key.pem"))
	if err != nil {
		return certificateAuthority{}, err
	}
	privateBlock, privateRest := pem.Decode(privatePEM)
	if privateBlock == nil || privateBlock.Type != "PRIVATE KEY" || len(bytes.TrimSpace(privateRest)) != 0 {
		return certificateAuthority{}, errors.New("local production root CA key is invalid")
	}
	parsedPrivate, err := x509.ParsePKCS8PrivateKey(privateBlock.Bytes)
	if err != nil {
		return certificateAuthority{}, errors.New("local production root CA key is invalid")
	}
	privateKey, ok := parsedPrivate.(*ecdsa.PrivateKey)
	if !ok {
		return certificateAuthority{}, errors.New("local production root CA key is invalid")
	}
	certificatePublic, err := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	if err != nil {
		return certificateAuthority{}, errors.New("marshal local production root CA public key")
	}
	privatePublic, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil || !bytes.Equal(certificatePublic, privatePublic) {
		return certificateAuthority{}, errors.New("local production root CA certificate and key do not match")
	}
	return certificateAuthority{certificate: certificate, privateKey: privateKey}, nil
}

func readRestrictedMaterial(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", filepath.Base(path), err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s must be a restricted regular file", filepath.Base(path))
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	if len(contents) == 0 || len(contents) > 1<<20 {
		return nil, fmt.Errorf("%s has an invalid size", filepath.Base(path))
	}
	return contents, nil
}

func writeCertificateAuthority(directory string, now time.Time) (certificateAuthority, error) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return certificateAuthority{}, fmt.Errorf("generate local CA key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return certificateAuthority{}, err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		return certificateAuthority{}, fmt.Errorf("marshal local CA public key: %w", err)
	}
	subjectKeyID := sha256.Sum256(publicDER)
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "Slots Local Technical Production Root CA",
			Organization: []string{"Slots Local Technical Production"},
		},
		NotBefore: now.Add(-5 * time.Minute), NotAfter: now.Add(10 * 365 * 24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true,
		KeyUsage:     x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		SubjectKeyId: subjectKeyID[:],
	}
	certificateDER, err := x509.CreateCertificate(
		rand.Reader, template, template, &privateKey.PublicKey, privateKey,
	)
	if err != nil {
		return certificateAuthority{}, fmt.Errorf("create local CA certificate: %w", err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return certificateAuthority{}, fmt.Errorf("marshal local CA private key: %w", err)
	}
	if err := writeExclusive(
		filepath.Join(directory, "local-production-root-ca-key.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}),
	); err != nil {
		return certificateAuthority{}, err
	}
	if err := writeExclusive(
		filepath.Join(directory, "local-production-root-ca.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}),
	); err != nil {
		return certificateAuthority{}, err
	}
	return certificateAuthority{certificate: template, privateKey: privateKey}, nil
}

func writeLeafCertificate(
	directory string,
	now time.Time,
	ca certificateAuthority,
	profile certificateProfile,
) error {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate %s TLS key: %w", profile.name, err)
	}
	serial, err := randomSerial()
	if err != nil {
		return err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		return fmt.Errorf("marshal %s TLS public key: %w", profile.name, err)
	}
	subjectKeyID := sha256.Sum256(publicDER)
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   profile.commonName,
			Organization: []string{"Slots Local Technical Production"},
		},
		NotBefore: now.Add(-5 * time.Minute), NotAfter: now.Add(825 * 24 * time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           profile.extKeyUsage,
		DNSNames:              append([]string(nil), profile.dnsNames...),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		SubjectKeyId:          subjectKeyID[:], AuthorityKeyId: ca.certificate.SubjectKeyId,
	}
	certificateDER, err := x509.CreateCertificate(
		rand.Reader, template, ca.certificate, &privateKey.PublicKey, ca.privateKey,
	)
	if err != nil {
		return fmt.Errorf("create %s TLS certificate: %w", profile.name, err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return fmt.Errorf("marshal %s TLS private key: %w", profile.name, err)
	}
	if err := writeExclusive(
		filepath.Join(directory, profile.name+"-key.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}),
	); err != nil {
		return err
	}
	return writeExclusive(
		filepath.Join(directory, profile.name+".pem"),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}),
	)
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("generate certificate serial: %w", err)
	}
	if serial.Sign() == 0 {
		serial.SetInt64(1)
	}
	return serial, nil
}

func writeJSON(path string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", filepath.Base(path), err)
	}
	return writeExclusive(path, append(encoded, '\n'))
}

func writeExclusive(path string, value []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", filepath.Base(path), err)
	}
	writeErr := error(nil)
	if _, err := file.Write(value); err != nil {
		writeErr = fmt.Errorf("write %s: %w", filepath.Base(path), err)
	}
	if syncErr := file.Sync(); syncErr != nil && writeErr == nil {
		writeErr = fmt.Errorf("sync %s: %w", filepath.Base(path), syncErr)
	}
	if closeErr := file.Close(); closeErr != nil && writeErr == nil {
		writeErr = fmt.Errorf("close %s: %w", filepath.Base(path), closeErr)
	}
	if writeErr != nil {
		return writeErr
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("restrict %s permissions: %w", filepath.Base(path), err)
	}
	return nil
}
