package game

import (
	"math"
	"testing"
)

func TestEvaluateWaysTwoByOneByThree(t *testing.T) {
	grid := Grid{
		{{Symbol: SymbolOrbit}, {Symbol: SymbolOrbit}, {Symbol: SymbolNova}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolOrbit}, {Symbol: SymbolOrbit}},
	}
	wins, total, err := EvaluateWays(grid, DemoConfig().Paytable, 1)
	if err != nil {
		t.Fatalf("EvaluateWays returned error: %v", err)
	}
	if len(wins) != 1 {
		t.Fatalf("len(wins) = %d, want 1", len(wins))
	}
	win := wins[0]
	if win.Symbol != SymbolOrbit || win.Ways != 6 {
		t.Fatalf("win = %+v, want ORBIT with 6 ways", win)
	}
	if win.AmountMinor != 180 || total != 180 {
		t.Fatalf("amount,total = %d,%d, want 180,180", win.AmountMinor, total)
	}
	if len(win.Cells) != 6 {
		t.Fatalf("len(cells) = %d, want 6", len(win.Cells))
	}
	if len(win.PathAwards) != win.Ways {
		t.Fatalf("len(path awards) = %d, want %d", len(win.PathAwards), win.Ways)
	}
	if got := win.PathAwards[0]; got.Multiplier != 1 || got.BaseAmountMinor != 30 || got.AmountMinor != 30 ||
		len(got.Cells) != 3 || got.Cells[0] != (Position{Reel: 0, Row: 0}) ||
		got.Cells[1] != (Position{Reel: 1, Row: 0}) || got.Cells[2] != (Position{Reel: 2, Row: 0}) {
		t.Fatalf("first path award = %+v, want ordered 0/0,1/0,2/0 for 30", got)
	}
}

func TestEvaluateWaysAppliesEachWildMultiplierToItsOwnPath(t *testing.T) {
	grid := Grid{
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{
			{Symbol: SymbolWild, Multiplier: 2},
			{Symbol: SymbolWild, Multiplier: 5},
			{Symbol: SymbolOrbit},
		},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolPulse}, {Symbol: SymbolPrism}},
	}
	wins, total, err := EvaluateWays(grid, DemoConfig().Paytable, 1)
	if err != nil {
		t.Fatalf("EvaluateWays returned error: %v", err)
	}
	if len(wins) != 1 || wins[0].Ways != 3 {
		t.Fatalf("wins = %+v, want one 3-way ORBIT win", wins)
	}
	// ORBIT 赔付为总投注的 30/100，直接按单位路径计算为 30*2 + 30*5 + 30*1。
	if total != 240 || wins[0].AmountMinor != 240 {
		t.Fatalf("wild award = %d, want 240", total)
	}
	paths := wins[0].PathAwards
	if len(paths) != 3 || paths[0].Multiplier != 2 || paths[0].BaseAmountMinor != 30 || paths[0].AmountMinor != 60 ||
		paths[1].Multiplier != 5 || paths[1].BaseAmountMinor != 30 || paths[1].AmountMinor != 150 ||
		paths[2].Multiplier != 1 || paths[2].BaseAmountMinor != 30 || paths[2].AmountMinor != 30 {
		t.Fatalf("path awards = %+v, want x2/60, x5/150, x1/30", paths)
	}
	if multiplier, uniform := wins[0].UniformPathMultiplier(); uniform {
		t.Fatalf("mixed Ways exposed aggregate multiplier %d", multiplier)
	}
}

func TestWinUniformPathMultiplierRequiresOneSharedPathValue(t *testing.T) {
	tests := []struct {
		name       string
		paths      []PathAward
		multiplier int64
		uniform    bool
	}{
		{name: "missing"},
		{name: "invalid", paths: []PathAward{{Multiplier: 0}}},
		{name: "one", paths: []PathAward{{Multiplier: 5}}, multiplier: 5, uniform: true},
		{name: "uniform", paths: []PathAward{{Multiplier: 2}, {Multiplier: 2}}, multiplier: 2, uniform: true},
		{name: "mixed", paths: []PathAward{{Multiplier: 2}, {Multiplier: 5}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := (Win{PathAwards: test.paths}).UniformPathMultiplier()
			if got != test.multiplier || ok != test.uniform {
				t.Fatalf("UniformPathMultiplier() = %d,%t; want %d,%t", got, ok, test.multiplier, test.uniform)
			}
		})
	}
}

func TestEvaluateWaysPaysTankAsAnIndependentHighSymbol(t *testing.T) {
	grid := Grid{
		{{Symbol: SymbolTank}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{{Symbol: SymbolTank}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
		{{Symbol: SymbolTank}, {Symbol: SymbolOrbit}, {Symbol: SymbolNova}},
	}
	wins, total, err := EvaluateWays(grid, DemoConfig().Paytable, 2)
	if err != nil {
		t.Fatalf("EvaluateWays returned error: %v", err)
	}
	if len(wins) != 1 || wins[0].Symbol != SymbolTank || wins[0].Ways != 1 {
		t.Fatalf("wins = %+v, want one 1-way TANK win", wins)
	}
	// TANK 赔付为总投注的 150/100；此直接求值器使用 2 单位投注。
	if wins[0].AmountMinor != 300 || total != 300 {
		t.Fatalf("TANK amount,total = %d,%d, want 300,300", wins[0].AmountMinor, total)
	}
}

func TestEvaluateWaysForBetScalesAroundReferenceWager(t *testing.T) {
	grid := Grid{
		{{Symbol: SymbolTank}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{{Symbol: SymbolTank}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
		{{Symbol: SymbolTank}, {Symbol: SymbolOrbit}, {Symbol: SymbolNova}},
	}
	_, referenceTotal, err := EvaluateWaysForBet(grid, DemoConfig().Paytable, 100, 100)
	if err != nil {
		t.Fatalf("reference wager: %v", err)
	}
	_, minimumTotal, err := EvaluateWaysForBet(grid, DemoConfig().Paytable, 10, 100)
	if err != nil {
		t.Fatalf("minimum wager: %v", err)
	}
	if referenceTotal != 150 || minimumTotal != 15 {
		t.Fatalf("scaled totals = %d,%d, want 150,15", referenceTotal, minimumTotal)
	}
}

func TestCapturedPaytablePaysEverySymbolRelativeToTotalBet(t *testing.T) {
	wantAtBet100 := map[Symbol]int64{
		SymbolPrism:   10,
		SymbolOrbit:   30,
		SymbolPulse:   80,
		SymbolNova:    100,
		SymbolTank:    150,
		SymbolCircuit: 200,
	}
	for symbol, want := range wantAtBet100 {
		t.Run(string(symbol), func(t *testing.T) {
			grid := Grid{
				{{Symbol: symbol}, {Symbol: SymbolSurge}, {Symbol: SymbolSurge}},
				{{Symbol: symbol}, {Symbol: SymbolSurge}, {Symbol: SymbolSurge}},
				{{Symbol: symbol}, {Symbol: SymbolSurge}, {Symbol: SymbolSurge}},
			}
			for _, wager := range []int64{100, 200} {
				wins, total, err := EvaluateWaysForBet(grid, DemoConfig().Paytable, wager, 100)
				if err != nil {
					t.Fatalf("bet %d: %v", wager, err)
				}
				wantTotal := want * wager / 100
				if len(wins) != 1 || wins[0].Ways != 1 || total != wantTotal {
					t.Fatalf("bet %d result = wins:%+v total:%d, want one Way paying %d", wager, wins, total, wantTotal)
				}
			}
		})
	}
}

func TestEvaluateWaysForBetDistributesAggregateRoundingDeterministically(t *testing.T) {
	grid := Grid{
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolOrbit}, {Symbol: SymbolOrbit}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolPulse}, {Symbol: SymbolPrism}},
	}
	paytable := DemoConfig().Paytable
	paytable[SymbolOrbit] = 1
	wins, total, err := EvaluateWaysForBet(grid, paytable, 50, 100)
	if err != nil {
		t.Fatalf("EvaluateWaysForBet returned error: %v", err)
	}
	if len(wins) != 1 || total != 2 || wins[0].AmountMinor != 2 {
		t.Fatalf("wins,total = %+v,%d, want one aggregate award of 2", wins, total)
	}
	paths := wins[0].PathAwards
	if len(paths) != 3 || paths[0].BaseAmountMinor != 1 || paths[0].AmountMinor != 1 ||
		paths[1].BaseAmountMinor != 1 || paths[1].AmountMinor != 1 ||
		paths[2].BaseAmountMinor != 0 || paths[2].AmountMinor != 0 {
		t.Fatalf("rounded path awards = %+v, want stable [1,1,0] allocation", paths)
	}
	var pathTotal int64
	for _, path := range paths {
		pathTotal += path.AmountMinor
	}
	if pathTotal != wins[0].AmountMinor {
		t.Fatalf("path total = %d, aggregate = %d", pathTotal, wins[0].AmountMinor)
	}
}

func TestEvaluateWaysForBetCarriesExplicitRoundedPreMultiplierAmount(t *testing.T) {
	grid := Grid{
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{{Symbol: SymbolWild, Multiplier: 5}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolPulse}, {Symbol: SymbolPrism}},
	}
	paytable := DemoConfig().Paytable
	paytable[SymbolOrbit] = 1
	wins, total, err := EvaluateWaysForBet(grid, paytable, 10, 100)
	if err != nil {
		t.Fatalf("EvaluateWaysForBet returned error: %v", err)
	}
	if len(wins) != 1 || len(wins[0].PathAwards) != 1 || total != 1 {
		t.Fatalf("wins,total = %+v,%d, want one 1-minor award", wins, total)
	}
	path := wins[0].PathAwards[0]
	if path.Multiplier != 5 || path.BaseAmountMinor != 1 || path.AmountMinor != 1 {
		t.Fatalf("rounded path = %+v, want explicit base 1 and settled 1 at x5", path)
	}
	if path.AmountMinor/path.Multiplier == path.BaseAmountMinor {
		t.Fatal("test no longer proves that clients cannot recover baseAmountMinor by division")
	}
}

func TestEvaluateWaysForBetCarriesAll512ExpansionPaths(t *testing.T) {
	grid := make(Grid, 3)
	for reel := range grid {
		grid[reel] = make([]Cell, 8)
		for row := range grid[reel] {
			grid[reel][row] = Cell{Symbol: SymbolOrbit}
		}
	}
	wins, total, err := EvaluateWaysForBet(grid, DemoConfig().Paytable, 10, 100)
	if err != nil {
		t.Fatalf("EvaluateWaysForBet returned error: %v", err)
	}
	if len(wins) != 1 || wins[0].Ways != 512 || len(wins[0].PathAwards) != 512 {
		t.Fatalf("wins = %+v, want one complete 512-path award", wins)
	}
	var pathTotal int64
	for _, path := range wins[0].PathAwards {
		pathTotal += path.AmountMinor
	}
	if pathTotal != wins[0].AmountMinor || total != wins[0].AmountMinor {
		t.Fatalf("path/aggregate/total = %d/%d/%d", pathTotal, wins[0].AmountMinor, total)
	}
	last := wins[0].PathAwards[511]
	if last.Cells[0].Row != 7 || last.Cells[1].Row != 7 || last.Cells[2].Row != 7 {
		t.Fatalf("last path = %+v, want rows 7/7/7", last)
	}
}

func TestEvaluateWaysRejectsInvalidWildAndOverflow(t *testing.T) {
	invalidWild := Grid{
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{{Symbol: SymbolWild, Multiplier: -1}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
	}
	if _, _, err := EvaluateWays(invalidWild, DemoConfig().Paytable, 1); err == nil {
		t.Fatal("negative-multiplier WILD unexpectedly accepted")
	}

	overflow := Grid{
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
		{{Symbol: SymbolOrbit}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
	}
	if _, _, err := EvaluateWays(overflow, DemoConfig().Paytable, math.MaxInt64); err == nil {
		t.Fatal("overflowing award unexpectedly accepted")
	}
}
