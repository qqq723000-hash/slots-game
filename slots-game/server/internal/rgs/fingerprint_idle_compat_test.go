package rgs

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/game"
)

func TestIdleDeadlineDoesNotChangeLegacyEconomicHashesOrJSON(t *testing.T) {
	legacy := SpinResult{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "iron-colossus-demo", DefinitionVersion: "definition-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Currency:       "EUR", RoundKind: RoundKindBase,
		ServerTransactionID: "server-transaction-a",
		StartRevision:       7, EndRevision: 8, Sequence: 9,
		BetMinor: 100, ChargedBetMinor: 100, BalanceMinor: 9900,
	}
	legacyOutcomeHash, err := OutcomeHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}
	legacyCommittedHash, err := CommittedResultHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}

	hydrated := legacy
	hydrated.IdleDisconnectAt = time.Date(2026, 8, 25, 1, 2, 3, 0, time.UTC)
	hydratedOutcomeHash, err := OutcomeHashFor(hydrated)
	if err != nil {
		t.Fatal(err)
	}
	hydratedCommittedHash, err := CommittedResultHashFor(hydrated)
	if err != nil {
		t.Fatal(err)
	}
	if hydratedOutcomeHash != legacyOutcomeHash || hydratedCommittedHash != legacyCommittedHash {
		t.Fatalf(
			"transport hydration changed economic hashes: outcome %q/%q committed %q/%q",
			legacyOutcomeHash, hydratedOutcomeHash, legacyCommittedHash, hydratedCommittedHash,
		)
	}
	encoded, err := json.Marshal(hydrated)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("IdleDisconnect")) || bytes.Contains(encoded, []byte("idleDisconnect")) {
		t.Fatalf("transport deadline leaked into legacy result_json: %s", encoded)
	}
}

func TestLegacyPaidFactsHydrateWithoutChangingEconomicHash(t *testing.T) {
	legacy := SpinResult{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "iron-colossus", DefinitionVersion: "legacy-v5",
		DefinitionHash: strings.Repeat("a", 64), Currency: "EUR", RoundKind: RoundKindBase,
		ServerTransactionID: "server-transaction-a", StartRevision: 1, Sequence: 2,
		BetMinor: 100, ChargedBetMinor: 100, TotalWinMinor: 250,
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolWild, Multiplier: 5}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
		},
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1, AmountMinor: 250,
			Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []game.PathAward{{
				Cells:      []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
				Multiplier: 5, BaseAmountMinor: 50, AmountMinor: 250,
			}},
		}},
		FeatureState: game.EmptyFeatureState(),
	}
	before, err := PreparedOutcomeHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}
	const frozenLegacyPreparedHash = "a80dc55cbc8fee26002d65bb358324c6b6d4985a11e2e0d4798049a1ba327d4f"
	if before != frozenLegacyPreparedHash {
		t.Fatalf("legacy prepared hash = %s, want frozen %s", before, frozenLegacyPreparedHash)
	}
	if err := NormalizePersistedSpinResult(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.Wins[0].PaidAmountMinor != 250 ||
		legacy.Wins[0].PathAwards[0].PaidAmountMinor != 250 {
		t.Fatalf("legacy paid facts = %+v", legacy.Wins)
	}
	after, err := PreparedOutcomeHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("legacy hydration changed economic hash: before=%s after=%s", before, after)
	}
	if err := game.ValidateOutcomeStructure(
		game.SpinInput{BetMinor: 100},
		game.SpinOutcome{Grid: legacy.Grid, Wins: legacy.Wins, TotalWinMinor: 250, NextFeature: legacy.FeatureState},
	); err != nil {
		t.Fatalf("hydrated legacy result failed structural validation: %v", err)
	}

	current := legacy
	current.ResultSchemaVersion = ResultSchemaPaidFactsV1
	currentHash, err := PreparedOutcomeHashFor(current)
	if err != nil {
		t.Fatal(err)
	}
	if currentHash == before {
		t.Fatal("current paid-facts schema reused a legacy economic hash")
	}

	legacy.WalletTransactionID = "wallet-transaction-a"
	legacy.BalanceMinor = 9_850
	legacy.EndRevision = 2
	committedHash, err := CommittedResultHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}
	const frozenLegacyCommittedHash = "1bfb0f08a94f9b51e22ef59de6600c869f7134c17c3bc8b3dc53de6fdd23b912"
	if committedHash != frozenLegacyCommittedHash {
		t.Fatalf(
			"legacy committed hash = %s, want frozen %s",
			committedHash,
			frozenLegacyCommittedHash,
		)
	}
}

func TestEconomicHashRejectsUnknownResultSchema(t *testing.T) {
	_, err := OutcomeHashFor(SpinResult{ResultSchemaVersion: "foreign-schema"})
	if err == nil {
		t.Fatal("OutcomeHashFor accepted an unknown result schema")
	}
}
