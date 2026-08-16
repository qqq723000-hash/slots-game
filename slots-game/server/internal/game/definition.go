package game

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var definitionVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

const (
	DefinitionApprovalSchemaV1 = "rgs-definition-approval-v1"
	DefinitionApprovalSchemaV2 = "rgs-definition-approval-v2"
)

// DefinitionDigest 是引擎使用的全部数学输入的稳定身份。encoding/json 会对字符串映射键排序，
// 而 Config 中其他集合的顺序均具有经济意义。
func DefinitionDigest(config Config) (string, error) {
	if err := config.Validate(); err != nil {
		return "", fmt.Errorf("invalid game definition: %w", err)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("encode game definition: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// DefinitionApproval 是由外部发布及认证流程提供的部署元数据。本包只验证身份，
// 不声明相关定义已经通过认证。
type DefinitionApproval struct {
	GameID             string                      `json:"gameId"`
	Version            string                      `json:"version"`
	SHA256             string                      `json:"sha256"`
	Status             string                      `json:"status"`
	ApprovalRef        string                      `json:"approvalRef"`
	ProductionEvidence *DefinitionApprovalEvidence `json:"productionEvidence,omitempty"`
}

// DefinitionApprovalEvidence 记录由外部控制的证据身份。运行时只验证这些引用存在于
// 独立签名的 v2 信封中，不声明引用的工作已经通过认证。
type DefinitionApprovalEvidence struct {
	MathReportRefs        []string                         `json:"mathReportRefs"`
	RNGReportRefs         []string                         `json:"rngReportRefs"`
	JurisdictionApprovals []DefinitionJurisdictionEvidence `json:"jurisdictionApprovals"`
}

type DefinitionJurisdictionEvidence struct {
	Jurisdiction string `json:"jurisdiction"`
	ApprovalRef  string `json:"approvalRef"`
}

// SignedDefinitionApproval 是部署时完整性信封。受信 Ed25519 公钥独立于此文件配置，
// 例如由密钥管理服务或密钥管理系统提供；因此同时修改磁盘上的数学定义和本清单，
// 也不能伪造已审批部署。
type SignedDefinitionApproval struct {
	Schema    string             `json:"schema"`
	KeyID     string             `json:"keyId"`
	Algorithm string             `json:"algorithm"`
	Approval  DefinitionApproval `json:"approval"`
	Signature string             `json:"signature"`
}

// VerifyDefinitionApproval 仅在清单明确批准确切的游戏、版本和摘要时才成功，否则失效即关闭。
// 清单的密码学签名属于部署及密钥管理边界；ApprovalRef 是不透明的实验室或发布管理引用。
func VerifyDefinitionApproval(config Config, approval DefinitionApproval) error {
	if approval.Status != "APPROVED" {
		return errors.New("game definition is not approved")
	}
	if !definitionVersionPattern.MatchString(config.DefinitionVersion) {
		return errors.New("invalid game definition version")
	}
	if approval.GameID != config.GameID || approval.Version != config.DefinitionVersion {
		return errors.New("game definition approval identity mismatch")
	}
	if approval.ApprovalRef == "" {
		return errors.New("game definition approval reference is required")
	}
	digest, err := DefinitionDigest(config)
	if err != nil {
		return err
	}
	if approval.SHA256 != digest {
		return errors.New("game definition approval digest mismatch")
	}
	return nil
}

func VerifySignedDefinitionApproval(
	config Config,
	envelope SignedDefinitionApproval,
	trustedKey ed25519.PublicKey,
) error {
	if (envelope.Schema != DefinitionApprovalSchemaV1 && envelope.Schema != DefinitionApprovalSchemaV2) ||
		envelope.Algorithm != "Ed25519" ||
		!definitionVersionPattern.MatchString(envelope.KeyID) ||
		len(trustedKey) != ed25519.PublicKeySize {
		return errors.New("invalid signed definition approval profile")
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		base64.StdEncoding.EncodeToString(signature) != envelope.Signature {
		return errors.New("invalid definition approval signature encoding")
	}
	payload, err := approvalSigningPayload(envelope.Schema, envelope.Approval)
	if err != nil {
		return err
	}
	if !ed25519.Verify(trustedKey, payload, signature) {
		return errors.New("definition approval signature verification failed")
	}
	if err := VerifyDefinitionApproval(config, envelope.Approval); err != nil {
		return err
	}
	switch envelope.Schema {
	case DefinitionApprovalSchemaV1:
		if envelope.Approval.ProductionEvidence != nil {
			return errors.New("v1 definition approval must not contain production evidence")
		}
		return nil
	case DefinitionApprovalSchemaV2:
		return VerifyProductionDefinitionApproval(config, envelope.Approval)
	default:
		return errors.New("invalid signed definition approval profile")
	}
}

// VerifyProductionDefinitionApproval 验证额外签名的 v2 生产配置。证据引用仍是不透明的
// 外部身份；接受这些引用不代表作出认证声明。
func VerifyProductionDefinitionApproval(config Config, approval DefinitionApproval) error {
	if hasDemoMarker(config.GameID) || hasDemoMarker(config.DefinitionVersion) {
		return errors.New("production game definition identity must not contain a demo marker")
	}
	if !validEvidenceReference(approval.ApprovalRef) {
		return errors.New("invalid production definition approval reference")
	}
	evidence := approval.ProductionEvidence
	if evidence == nil {
		return errors.New("production definition approval evidence is required")
	}
	if err := validateEvidenceReferences("math report", evidence.MathReportRefs); err != nil {
		return err
	}
	if err := validateEvidenceReferences("RNG report", evidence.RNGReportRefs); err != nil {
		return err
	}
	if len(evidence.JurisdictionApprovals) < 1 || len(evidence.JurisdictionApprovals) > 64 {
		return errors.New("production jurisdiction approval evidence is required")
	}
	seenJurisdictions := make(map[string]struct{}, len(evidence.JurisdictionApprovals))
	for _, item := range evidence.JurisdictionApprovals {
		if !validJurisdiction(item.Jurisdiction) || !validEvidenceReference(item.ApprovalRef) {
			return errors.New("invalid production jurisdiction approval evidence")
		}
		if _, duplicate := seenJurisdictions[item.Jurisdiction]; duplicate {
			return errors.New("duplicate production jurisdiction approval evidence")
		}
		seenJurisdictions[item.Jurisdiction] = struct{}{}
	}
	return nil
}

// SignDefinitionApproval 用于离线发布或认证流水线。运行时服务器只需要调用
// VerifySignedDefinitionApproval 完成验证。
func SignDefinitionApproval(
	approval DefinitionApproval,
	keyID string,
	privateKey ed25519.PrivateKey,
) (SignedDefinitionApproval, error) {
	if !definitionVersionPattern.MatchString(keyID) ||
		len(privateKey) != ed25519.PrivateKeySize {
		return SignedDefinitionApproval{}, errors.New("invalid definition approval signing key")
	}
	payload, err := approvalSigningPayload(DefinitionApprovalSchemaV1, approval)
	if err != nil {
		return SignedDefinitionApproval{}, err
	}
	return SignedDefinitionApproval{
		Schema: DefinitionApprovalSchemaV1, KeyID: keyID, Algorithm: "Ed25519",
		Approval:  approval,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
	}, nil
}

// SignProductionDefinitionApproval 用于独立控制的离线审批流水线。它只签署提供的元数据；
// 运行时验证仍负责拒绝不完整证据。
func SignProductionDefinitionApproval(
	approval DefinitionApproval,
	keyID string,
	privateKey ed25519.PrivateKey,
) (SignedDefinitionApproval, error) {
	if !definitionVersionPattern.MatchString(keyID) ||
		len(privateKey) != ed25519.PrivateKeySize {
		return SignedDefinitionApproval{}, errors.New("invalid definition approval signing key")
	}
	payload, err := approvalSigningPayload(DefinitionApprovalSchemaV2, approval)
	if err != nil {
		return SignedDefinitionApproval{}, err
	}
	return SignedDefinitionApproval{
		Schema: DefinitionApprovalSchemaV2, KeyID: keyID, Algorithm: "Ed25519",
		Approval:  approval,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
	}, nil
}

func approvalSigningPayload(schema string, approval DefinitionApproval) ([]byte, error) {
	payload := struct {
		Schema   string             `json:"schema"`
		Approval DefinitionApproval `json:"approval"`
	}{
		Schema: schema, Approval: approval,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode definition approval signing payload: %w", err)
	}
	return encoded, nil
}

func hasDemoMarker(value string) bool {
	return strings.Contains(strings.ToLower(value), "demo")
}

func validateEvidenceReferences(kind string, references []string) error {
	if len(references) < 1 || len(references) > 64 {
		return fmt.Errorf("production %s evidence is required", kind)
	}
	seen := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if !validEvidenceReference(reference) {
			return fmt.Errorf("invalid production %s evidence reference", kind)
		}
		if _, duplicate := seen[reference]; duplicate {
			return fmt.Errorf("duplicate production %s evidence reference", kind)
		}
		seen[reference] = struct{}{}
	}
	return nil
}

func validEvidenceReference(reference string) bool {
	if len(reference) < 1 || len(reference) > 512 || strings.TrimSpace(reference) != reference {
		return false
	}
	for _, character := range reference {
		if character < 0x21 || character == 0x7f {
			return false
		}
	}
	return true
}

func validJurisdiction(jurisdiction string) bool {
	if len(jurisdiction) < 2 || len(jurisdiction) > 16 {
		return false
	}
	for index, character := range jurisdiction {
		if (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') ||
			(index > 0 && character == '-') {
			continue
		}
		return false
	}
	return true
}
