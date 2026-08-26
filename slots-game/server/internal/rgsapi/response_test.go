package rgsapi

import (
	"encoding/json"
	"strings"
	"testing"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rgs"
)

func TestSessionResponseCarriesAuthoritativeEngineRulesVersion(t *testing.T) {
	response := makeSessionResponse(rgs.Session{})
	if response.EngineRulesVersion != game.EngineRulesVersion {
		t.Fatalf("engine rules version = %q, want %q", response.EngineRulesVersion, game.EngineRulesVersion)
	}
}

func TestSpinResponseCarriesAuthoritativePreMultiplierPathAmount(t *testing.T) {
	response, err := makeSpinResultResponse(rgs.SpinResult{
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1,
			AmountMinor: 250, PaidAmountMinor: 250,
			Cells: []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []game.PathAward{{
				Cells: []game.Position{
					{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0},
				},
				Multiplier: 5, BaseAmountMinor: 50, AmountMinor: 250, PaidAmountMinor: 250,
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(response.Wins) != 1 || len(response.Wins[0].PathAwards) != 1 {
		t.Fatalf("response wins = %+v", response.Wins)
	}
	win := response.Wins[0]
	if win.NominalAmountMinor != "250" || win.AmountMinor != "250" {
		t.Fatalf("win response = %+v", win)
	}
	path := response.Wins[0].PathAwards[0]
	if path.Multiplier != "5" || path.BaseAmountMinor != "50" ||
		path.NominalAmountMinor != "250" || path.AmountMinor != "250" {
		t.Fatalf("path response = %+v", path)
	}
	if response.Wins[0].Multiplier != "5" {
		t.Fatalf("uniform record multiplier = %q, want 5", response.Wins[0].Multiplier)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"baseAmountMinor":"50"`) ||
		!strings.Contains(string(encoded), `"nominalAmountMinor":"250"`) {
		t.Fatalf("response JSON omitted authoritative nominal facts: %s", encoded)
	}
}

func TestSpinResponseSeparatesNominalAndPaidCappedWays(t *testing.T) {
	cells := []game.Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}}
	response, err := makeSpinResultResponse(rgs.SpinResult{
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 1,
			AmountMinor: 1_000, PaidAmountMinor: 75,
			Cells: cells,
			PathAwards: []game.PathAward{{
				Cells: cells, Multiplier: 10, BaseAmountMinor: 100,
				AmountMinor: 1_000, PaidAmountMinor: 75,
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(response.Wins) != 1 || len(response.Wins[0].PathAwards) != 1 {
		t.Fatalf("response wins = %+v", response.Wins)
	}
	win := response.Wins[0]
	if win.NominalAmountMinor != "1000" || win.AmountMinor != "75" ||
		win.Ways != 1 || len(win.Cells) != len(cells) {
		t.Fatalf("capped win response = %+v", win)
	}
	path := win.PathAwards[0]
	if path.BaseAmountMinor != "100" || path.NominalAmountMinor != "1000" ||
		path.AmountMinor != "75" || len(path.Cells) != len(cells) {
		t.Fatalf("capped path response = %+v", path)
	}
}

func TestSpinResponseOmitsRecordMultiplierForMixedWays(t *testing.T) {
	response, err := makeSpinResultResponse(rgs.SpinResult{
		Wins: []game.Win{{
			ID: "orbit-3", Symbol: game.SymbolOrbit, Ways: 2, AmountMinor: 30, PaidAmountMinor: 30,
			PathAwards: []game.PathAward{
				{Multiplier: 1, BaseAmountMinor: 10, AmountMinor: 10, PaidAmountMinor: 10},
				{Multiplier: 2, BaseAmountMinor: 10, AmountMinor: 20, PaidAmountMinor: 20},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Wins[0].Multiplier != "" {
		t.Fatalf("mixed Ways exposed multiplier %q", response.Wins[0].Multiplier)
	}
	if response.Wins[0].NominalAmountMinor != "30" || response.Wins[0].AmountMinor != "30" {
		t.Fatalf("mixed Ways amounts = %+v", response.Wins[0])
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

func TestSpinResponseCarriesAuthoritativeMaxWinBoundary(t *testing.T) {
	response, err := makeSpinResultResponse(rgs.SpinResult{
		Events: []game.Event{{
			Type: "win_cap.reached", Multiplier: 2_500, CumulativeWinMinor: 250_000,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Events) != 1 || response.Events[0].Type != "win_cap.reached" ||
		response.Events[0].Multiplier != "2500" ||
		response.Events[0].CumulativeWinMinor != "250000" ||
		response.Events[0].AmountMinor != "0" {
		t.Fatalf("max-win response event = %+v", response.Events)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"type":"win_cap.reached"`) ||
		!strings.Contains(string(encoded), `"multiplier":"2500"`) ||
		!strings.Contains(string(encoded), `"cumulativeWinMinor":"250000"`) {
		t.Fatalf("max-win JSON projection = %s", encoded)
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
