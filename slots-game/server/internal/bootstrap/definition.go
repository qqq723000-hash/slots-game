package bootstrap

import (
	"errors"
	"fmt"

	"slots-game/server/internal/game"
)

type definitionLoadPolicy struct {
	requireProductionApproval bool
}

// DefinitionLoadOption 在不削弱既有 v1 签名开发及预发布契约的前提下收紧部署策略。
type DefinitionLoadOption func(*definitionLoadPolicy) error

// RequireProductionDefinitionApproval 要求使用 v2 签名证据配置，并拒绝游戏或版本身份
// 标记为演示用途的定义。
func RequireProductionDefinitionApproval() DefinitionLoadOption {
	return func(policy *definitionLoadPolicy) error {
		if policy == nil {
			return errors.New("definition load policy is required")
		}
		policy.requireProductionApproval = true
		return nil
	}
}

// LoadDefinition 加载并认证运行时将执行的确切数学定义。受信发布密钥必须作为单独配置的
// PKIX PEM 资源提供。
func LoadDefinition(
	definitionPath, signedApprovalPath, trustedPublicKeyPath string,
	options ...DefinitionLoadOption,
) (game.Config, string, error) {
	policy := definitionLoadPolicy{}
	for _, option := range options {
		if option == nil {
			return game.Config{}, "", errors.New("definition load option is required")
		}
		if err := option(&policy); err != nil {
			return game.Config{}, "", fmt.Errorf("configure definition load policy: %w", err)
		}
	}
	var definition game.Config
	if err := decodeStrictJSONFile(definitionPath, &definition); err != nil {
		return game.Config{}, "", fmt.Errorf("load game definition: %w", err)
	}
	var approval game.SignedDefinitionApproval
	if err := decodeStrictJSONFile(signedApprovalPath, &approval); err != nil {
		return game.Config{}, "", fmt.Errorf("load signed definition approval: %w", err)
	}
	trustedKey, err := loadEd25519PublicKey(trustedPublicKeyPath)
	if err != nil {
		return game.Config{}, "", fmt.Errorf("load definition approval key: %w", err)
	}
	if err := game.VerifySignedDefinitionApproval(definition, approval, trustedKey); err != nil {
		return game.Config{}, "", fmt.Errorf("verify signed definition approval: %w", err)
	}
	if policy.requireProductionApproval && approval.Schema != game.DefinitionApprovalSchemaV2 {
		return game.Config{}, "", errors.New("production requires rgs-definition-approval-v2")
	}
	if policy.requireProductionApproval {
		if err := game.VerifyProductionDefinitionApproval(definition, approval.Approval); err != nil {
			return game.Config{}, "", fmt.Errorf("verify production definition approval: %w", err)
		}
	}
	digest, err := game.DefinitionDigest(definition)
	if err != nil {
		return game.Config{}, "", fmt.Errorf("digest game definition: %w", err)
	}
	return definition, digest, nil
}
