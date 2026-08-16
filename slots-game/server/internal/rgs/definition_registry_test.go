package rgs

import (
	"context"
	"strings"
	"testing"

	"slots-game/server/internal/game"
)

func TestDefinitionRegistryRequiresExactImmutableIdentity(t *testing.T) {
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return game.SpinOutcome{}, nil
	}}
	hash := strings.Repeat("a", 64)
	registry, err := NewMemoryDefinitionRegistry(DefinitionEntry{
		GameID: "game-a", Version: "math-v1", SHA256: hash, Spinner: spinner,
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := registry.Resolve(context.Background(), "game-a", "math-v1", hash)
	if err != nil || resolved != spinner {
		t.Fatalf("Resolve exact identity = %v, %v", resolved, err)
	}
	for _, identity := range [][3]string{
		{"game-b", "math-v1", hash},
		{"game-a", "math-v2", hash},
		{"game-a", "math-v1", strings.Repeat("b", 64)},
	} {
		if _, err := registry.Resolve(context.Background(), identity[0], identity[1], identity[2]); err == nil {
			t.Fatalf("mismatched identity unexpectedly resolved: %v", identity)
		}
	}
}

func TestDefinitionRegistryRejectsDuplicateOrInvalidEntries(t *testing.T) {
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return game.SpinOutcome{}, nil
	}}
	entry := DefinitionEntry{
		GameID: "game-a", Version: "math-v1",
		SHA256: strings.Repeat("a", 64), Spinner: spinner,
	}
	if _, err := NewMemoryDefinitionRegistry(); err == nil {
		t.Fatal("empty registry unexpectedly accepted")
	}
	if _, err := NewMemoryDefinitionRegistry(entry, entry); err == nil {
		t.Fatal("duplicate definition unexpectedly accepted")
	}
	entry.SHA256 = "not-a-digest"
	if _, err := NewMemoryDefinitionRegistry(entry); err == nil {
		t.Fatal("invalid definition digest unexpectedly accepted")
	}
}
