package rgsapi

import (
	"encoding/json"
	"strings"
	"testing"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rgs"
)

func TestSpinResponseCarriesAuthoritativePreMultiplierPathAmount(t *testing.T) {
	response, err := makeSpinResultResponse(rgs.SpinResult{
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1, AmountMinor: 250,
			Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []game.PathAward{{
				Cells: []game.Position{
					{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0},
				},
				Multiplier: 5, BaseAmountMinor: 50, AmountMinor: 250,
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(response.Wins) != 1 || len(response.Wins[0].PathAwards) != 1 {
		t.Fatalf("response wins = %+v", response.Wins)
	}
	path := response.Wins[0].PathAwards[0]
	if path.Multiplier != "5" || path.BaseAmountMinor != "50" || path.AmountMinor != "250" {
		t.Fatalf("path response = %+v", path)
	}
	if response.Wins[0].Multiplier != "5" {
		t.Fatalf("uniform record multiplier = %q, want 5", response.Wins[0].Multiplier)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"baseAmountMinor":"50"`) {
		t.Fatalf("response JSON omitted authoritative base amount: %s", encoded)
	}
}

func TestSpinResponseOmitsRecordMultiplierForMixedWays(t *testing.T) {
	response, err := makeSpinResultResponse(rgs.SpinResult{
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 2, AmountMinor: 30,
			PathAwards: []game.PathAward{
				{Multiplier: 1, BaseAmountMinor: 10, AmountMinor: 10},
				{Multiplier: 2, BaseAmountMinor: 10, AmountMinor: 20},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Wins[0].Multiplier != "" {
		t.Fatalf("mixed Ways exposed multiplier %q", response.Wins[0].Multiplier)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Wins []map[string]json.RawMessage `json:"wins"`
	}
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	if _, exists := envelope.Wins[0]["multiplier"]; exists {
		t.Fatalf("mixed Ways leaked a record multiplier: %s", encoded)
	}
}

func TestSpinResponseCarriesTheCanonicalCommittedResultHash(t *testing.T) {
	result := rgs.SpinResult{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "primal-rampage", DefinitionVersion: "definition-1",
		DefinitionHash: strings.Repeat("a", 64), Currency: "EUR", RoundKind: rgs.RoundKindBase,
		ServerTransactionID: "server-tx-a", WalletTransactionID: "wallet-tx-a",
		Sequence: 1, BetMinor: 100, ChargedBetMinor: 100, BalanceMinor: 900,
		Grid: game.Grid{
			{{Symbol: game.SymbolOrbit}, {Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}},
			{{Symbol: game.SymbolNova}, {Symbol: game.SymbolCircuit}, {Symbol: game.SymbolTank}},
			{{Symbol: game.SymbolPrism}, {Symbol: game.SymbolPulse}, {Symbol: game.SymbolNova}},
		},
		FeatureState: game.FeatureState{Mode: game.FeatureNone, RageLevel: 1},
	}
	want, err := rgs.CommittedResultHashFor(result)
	if err != nil {
		t.Fatal(err)
	}
	response, err := makeSpinResultResponse(result)
	if err != nil {
		t.Fatal(err)
	}
	if response.ResultHash != want {
		t.Fatalf("result hash = %q, want %q", response.ResultHash, want)
	}
}
