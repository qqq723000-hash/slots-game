package rgs

import (
	"context"
	"errors"
	"fmt"

	"slots-game/server/internal/game"
)

// DefinitionEntry 将不可变数学定义绑定到其确切内容摘要。注册表构造会拒绝重复身份，
// 防止部署以另一引擎静默遮蔽已审批引擎。
// English: DefinitionEntry binds an immutable mathematical definition to a summary of its exact content. Registry
// constructs reject duplicate identities, preventing deployments from silently masking an approved engine with
// another engine.
type DefinitionEntry struct {
	GameID  string
	Version string
	SHA256  string
	Spinner game.Spinner
}

// MemoryDefinitionRegistry 构造后不可变，因此进程中的所有 HTTP 工作协程可安全并发使用。
// English: MemoryDefinitionRegistry is constructed immutable, so it is safe for concurrent use by all HTTP worker
// coroutines in the process.
type MemoryDefinitionRegistry struct {
	entries map[string]game.Spinner
}

func NewMemoryDefinitionRegistry(entries ...DefinitionEntry) (*MemoryDefinitionRegistry, error) {
	if len(entries) == 0 {
		return nil, errors.New("rgs: at least one approved definition is required")
	}
	registry := &MemoryDefinitionRegistry{entries: make(map[string]game.Spinner, len(entries))}
	for _, entry := range entries {
		if entry.Spinner == nil {
			return nil, errors.New("rgs: definition spinner is required")
		}
		identity := SpinRequest{
			OperatorID: "validation", SessionID: "validation", RoundID: "validation",
			GameID: entry.GameID, DefinitionVersion: entry.Version,
			DefinitionHash: entry.SHA256, Currency: "USD", RoundKind: RoundKindBase,
			BetMinor: 1, TransportGeneration: 1,
		}
		if err := validateSpinRequest(identity); err != nil {
			return nil, fmt.Errorf("rgs: invalid definition identity: %w", err)
		}
		key := definitionKey(entry.GameID, entry.Version, entry.SHA256)
		if _, exists := registry.entries[key]; exists {
			return nil, errors.New("rgs: duplicate definition identity")
		}
		registry.entries[key] = entry.Spinner
	}
	return registry, nil
}

func (r *MemoryDefinitionRegistry) Resolve(
	ctx context.Context,
	gameID, version, hash string,
) (game.Spinner, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r == nil {
		return nil, errors.New("rgs: definition registry is nil")
	}
	spinner, exists := r.entries[definitionKey(gameID, version, hash)]
	if !exists {
		return nil, errors.New("rgs: approved game definition not found")
	}
	return spinner, nil
}

func definitionKey(gameID, version, hash string) string {
	return gameID + "\x00" + version + "\x00" + hash
}

var _ DefinitionRegistry = (*MemoryDefinitionRegistry)(nil)
