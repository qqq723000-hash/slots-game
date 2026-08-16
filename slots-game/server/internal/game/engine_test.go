package game

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"slots-game/server/internal/rng"
)

func TestExactlyThreeSurgesGuaranteeWheelAndStartExpansion(t *testing.T) {
	config := DemoConfig()
	for reel := range config.Reels {
		config.Reels[reel] = []WeightedSymbol{
			{Value: SymbolOrbit, Weight: 1}, {Value: SymbolSurge, Weight: 1},
		}
	}
	config.Feature.SurgeOneChanceBP = 0
	config.Feature.SurgeTwoChanceBP = 0
	config.Feature.Wheel = []WeightedWheel{{Kind: WheelExpansion, Weight: 1}}
	engine := mustEngine(t, config, exactlyThreeSurgeSequence(32)...)

	priorRage := FeatureState{Mode: FeatureNone, RageLevel: 4, RageCollected: 36}
	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: priorRage})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	if outcome.NextFeature.Mode != FeatureExpansion || outcome.NextFeature.Remaining != 8 || outcome.NextFeature.Awarded != 8 {
		t.Fatalf("next feature = %+v, want EXPANSION 8/8", outcome.NextFeature)
	}
	surge := requireEvent(t, outcome.Events, "surge.collected")
	wantCells := []Position{
		{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0},
	}
	if surge.Count != len(wantCells) || !reflect.DeepEqual(surge.Cells, wantCells) {
		t.Fatalf("surge event = %+v, want all reel-major SURGE cells", surge)
	}
	if !surge.Triggered || !surge.Guaranteed {
		t.Fatalf("surge trigger flags = triggered:%v guaranteed:%v, want true/true", surge.Triggered, surge.Guaranteed)
	}
	if surge.Total != 36 || surge.Level != 4 ||
		outcome.NextFeature.RageCollected != 36 || outcome.NextFeature.RageLevel != 4 {
		t.Fatalf("guaranteed Wheel PPS state = event:%+v next:%+v, want unchanged 4/36", surge, outcome.NextFeature)
	}
	assertEvent(t, outcome.Events, "wheel.awarded")
	assertEvent(t, outcome.Events, "free_spins.started")
	if eventIndex(outcome.Events, "surge.collected") >= eventIndex(outcome.Events, "wheel.awarded") {
		t.Fatalf("events = %+v, want surge.collected before wheel.awarded", outcome.Events)
	}
}

func TestMoreThanThreeSurgesAreRejected(t *testing.T) {
	engine := mustEngine(t, probabilisticSurgeConfig(), 0)
	_, err := engine.surgeTriggers(4)
	if err == nil || !strings.Contains(err.Error(), "more than three settled Rage symbols") {
		t.Fatalf("surgeTriggers error = %v, want exact-three Rage rejection", err)
	}
}

func TestBaseGridCannotAuthorMoreThanThreeSurges(t *testing.T) {
	engine := mustEngine(t, probabilisticSurgeConfig(), repeatedSequence(32, 1)...)
	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	if positions := positionsForSymbol(outcome.Grid, SymbolSurge); len(positions) != 3 {
		t.Fatalf("settled Rage positions = %v, want exactly three", positions)
	}
}

func TestOneSurgeUsesConfiguredChanceAndReportsFalseTrigger(t *testing.T) {
	config := probabilisticSurgeConfig()
	config.Feature.SurgeOneChanceBP = 5_000
	engine := mustEngine(t, config,
		1, 0, 0,
		0, 0, 0,
		0, 0, 0,
		9_999,
	)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	surge := requireEvent(t, outcome.Events, "surge.collected")
	if surge.Count != 1 || !reflect.DeepEqual(surge.Cells, []Position{{Reel: 0, Row: 0}}) {
		t.Fatalf("surge event = %+v, want one settled coordinate", surge)
	}
	if surge.Triggered || surge.Guaranteed {
		t.Fatalf("surge trigger flags = triggered:%v guaranteed:%v, want false/false", surge.Triggered, surge.Guaranteed)
	}
	if surge.Total != 1 || surge.Level != DefaultRageLevel ||
		outcome.NextFeature.RageCollected != 1 || outcome.NextFeature.RageLevel != DefaultRageLevel {
		t.Fatalf("failed one-Rage PPS state = event:%+v next:%+v, want credited 1/1", surge, outcome.NextFeature)
	}
	if countEvents(outcome.Events, "wheel.awarded") != 0 {
		t.Fatalf("events = %+v, wheel must not be awarded after failed chance", outcome.Events)
	}
}

func TestFailedTwoSurgesPreserveTheCreditedPPSMeter(t *testing.T) {
	config := probabilisticSurgeConfig()
	config.Feature.SurgeTwoChanceBP = 0
	engine := mustEngine(t, config,
		1, 1, 0,
		0, 0, 0,
		0, 0, 0,
	)
	input := SpinInput{
		BetMinor: 100,
		Feature:  FeatureState{Mode: FeatureNone, RageLevel: 1, RageCollected: 11},
	}

	outcome, err := engine.Spin(context.Background(), input)
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	surge := requireEvent(t, outcome.Events, "surge.collected")
	if surge.Triggered || surge.Guaranteed || surge.Count != 2 ||
		surge.Total != 13 || surge.Level != 2 ||
		outcome.NextFeature.RageCollected != 13 || outcome.NextFeature.RageLevel != 2 {
		t.Fatalf("failed two-Rage PPS state = event:%+v next:%+v, want credited 2/13", surge, outcome.NextFeature)
	}
	if countEvents(outcome.Events, "rage.transformed") != 0 || countEvents(outcome.Events, "wheel.awarded") != 0 {
		t.Fatalf("failed two-Rage events = %+v, want no transformation or Wheel", outcome.Events)
	}
}

func TestTwoSurgesUseConfiguredChanceAndPrecedeWheel(t *testing.T) {
	config := probabilisticSurgeConfig()
	config.Feature.SurgeTwoChanceBP = 5_000
	engine := mustEngine(t, config,
		1, 1, 0,
		0, 0, 0,
		0, 0, 0,
		0, // Chance succeeds.
		0, // One authoritative Rage placement.
		0, // Deterministic wheel selection.
	)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	surge := requireEvent(t, outcome.Events, "surge.collected")
	if surge.Count != 2 || !reflect.DeepEqual(surge.Cells, []Position{{Reel: 0, Row: 0}, {Reel: 0, Row: 1}}) {
		t.Fatalf("surge event = %+v, want two settled coordinates", surge)
	}
	if !surge.Triggered || surge.Guaranteed {
		t.Fatalf("surge trigger flags = triggered:%v guaranteed:%v, want true/false", surge.Triggered, surge.Guaranteed)
	}
	if surge.Total != 0 || surge.Level != DefaultRageLevel {
		t.Fatalf("triggering collection sample = %+v, want reset snapshot 1/0", surge)
	}
	if outcome.NextFeature.RageCollected != 0 || outcome.NextFeature.RageLevel != DefaultRageLevel {
		t.Fatalf("triggered Wheel feature state = %+v, want reset 1/0", outcome.NextFeature)
	}
	transformed := requireEvent(t, outcome.Events, "rage.transformed")
	if transformed.Total != surge.Total || transformed.Level != surge.Level {
		t.Fatalf("transformation sample = %+v, want reset snapshot from %+v", transformed, surge)
	}
	if eventIndex(outcome.Events, "surge.collected") >= eventIndex(outcome.Events, "wheel.awarded") {
		t.Fatalf("events = %+v, want surge.collected before wheel.awarded", outcome.Events)
	}
}

func TestTankStopsAndWaysWinComeFromAuthoritativeEngine(t *testing.T) {
	config := deterministicConfig(SymbolTank, SymbolTank, SymbolTank)
	engine := mustEngine(t, config, repeatedSequence(16, 0)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	for reel, cells := range outcome.Grid {
		for row, cell := range cells {
			if cell.Symbol != SymbolTank {
				t.Fatalf("grid[%d][%d] = %s, want TANK", reel, row, cell.Symbol)
			}
		}
	}
	if len(outcome.Wins) != 1 || outcome.Wins[0].Symbol != SymbolTank || outcome.Wins[0].Ways != 27 {
		t.Fatalf("wins = %+v, want one 27-way TANK win", outcome.Wins)
	}
	if outcome.TotalWinMinor != 4_050 {
		t.Fatalf("total win = %d, want 4050", outcome.TotalWinMinor)
	}
}

func TestExpansionChoosesUpToEightRowsAndVaultsExtendToCap(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
	config.Feature.VaultFreeSpinWeight = 1
	values := repeatedSequence(80, 1)
	values[0] = 5 // uniform row selection: 5 + 3 = 8 rows.
	engine := mustEngine(t, config, values...)
	state := FeatureState{Mode: FeatureExpansion, Remaining: 1, Awarded: 8, BetMinor: 100}

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	if len(outcome.Grid[0]) != 8 {
		t.Fatalf("rows = %d, want 8", len(outcome.Grid[0]))
	}
	if outcome.NextFeature.Mode != FeatureExpansion || outcome.NextFeature.Remaining != 8 || outcome.NextFeature.Awarded != 16 {
		t.Fatalf("next feature = %+v, want EXPANSION remaining=8 awarded=16", outcome.NextFeature)
	}
	if countEvents(outcome.Events, "free_spin.awarded") != 8 {
		t.Fatalf("free_spin.awarded events = %d, want 8", countEvents(outcome.Events, "free_spin.awarded"))
	}
}

func TestOverdriveVaultUpgradesAndDoesNotExtend(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.Feature.OverdriveDoubleChanceBP = 10_000
	engine := mustEngine(t, config, repeatedSequence(64, 0)...)
	state := FeatureState{Mode: FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100}

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatalf("Spin returned error: %v", err)
	}
	if outcome.NextFeature.Mode != FeatureNone || outcome.NextFeature.Remaining != 0 {
		t.Fatalf("next feature = %+v, want completed state", outcome.NextFeature)
	}
	if countEvents(outcome.Events, "vault.upgraded") != 3 {
		t.Fatalf("vault.upgraded events = %d, want 3", countEvents(outcome.Events, "vault.upgraded"))
	}
	for _, event := range outcome.Events {
		if event.Type == "vault.upgraded" && event.ToMultiplier != 7 {
			t.Fatalf("upgraded multiplier = %d, want next tier 7", event.ToMultiplier)
		}
	}
}

func TestEngineOwnsAnImmutableDefinitionSnapshot(t *testing.T) {
	config := DemoConfig()
	engine, err := NewEngine(config, rng.NewSequenceSource())
	if err != nil {
		t.Fatal(err)
	}
	wantPayout := config.Paytable[SymbolOrbit]
	wantWeight := config.Reels[0][0].Weight
	wantBet := config.Bet.OptionsMinor[0]
	config.Paytable[SymbolOrbit] = 999_999
	config.Reels[0][0].Weight = 999_999
	config.Bet.OptionsMinor[0] = 999_999

	first := engine.Config()
	if first.Paytable[SymbolOrbit] != wantPayout ||
		first.Reels[0][0].Weight != wantWeight ||
		first.Bet.OptionsMinor[0] != wantBet {
		t.Fatalf("engine definition was mutated through constructor input: %+v", first)
	}
	first.Paytable[SymbolOrbit] = 777_777
	first.Reels[0][0].Weight = 777_777
	second := engine.Config()
	if second.Paytable[SymbolOrbit] != wantPayout ||
		second.Reels[0][0].Weight != wantWeight {
		t.Fatalf("engine definition was mutated through Config result: %+v", second)
	}
}

func deterministicConfig(left, middle, right Symbol) Config {
	config := DemoConfig()
	config.Reels = [3][]WeightedSymbol{
		{{Value: left, Weight: 1}},
		{{Value: middle, Weight: 1}},
		{{Value: right, Weight: 1}},
	}
	config.VaultMultipliers = []WeightedInt{{Value: 3, Weight: 1}}
	config.OverdriveMultipliers = []WeightedInt{{Value: 7, Weight: 1}}
	return config
}

func probabilisticSurgeConfig() Config {
	config := DemoConfig()
	for reel := range config.Reels {
		config.Reels[reel] = []WeightedSymbol{
			{Value: SymbolOrbit, Weight: 1},
			{Value: SymbolSurge, Weight: 1},
		}
	}
	config.Feature.Wheel = []WeightedWheel{{Kind: WheelExpansion, Weight: 1}}
	return config
}

func mustEngine(t *testing.T, config Config, values ...uint64) *Engine {
	t.Helper()
	engine, err := NewEngine(config, rng.NewSequenceSource(values...))
	if err != nil {
		t.Fatalf("NewEngine returned error: %v", err)
	}
	return engine
}

func repeatedSequence(count int, value uint64) []uint64 {
	values := make([]uint64, count)
	for i := range values {
		values[i] = value
	}
	return values
}

func exactlyThreeSurgeSequence(count int) []uint64 {
	values := repeatedSequence(count, 0)
	for _, index := range []int{0, 3, 6} {
		values[index] = 1
	}
	return values
}

func assertEvent(t *testing.T, events []Event, eventType string) {
	t.Helper()
	if countEvents(events, eventType) == 0 {
		t.Fatalf("event %q not found in %+v", eventType, events)
	}
}

func requireEvent(t *testing.T, events []Event, eventType string) Event {
	t.Helper()
	for _, event := range events {
		if event.Type == eventType {
			return event
		}
	}
	t.Fatalf("event %q not found in %+v", eventType, events)
	return Event{}
}

func eventIndex(events []Event, eventType string) int {
	for index, event := range events {
		if event.Type == eventType {
			return index
		}
	}
	return -1
}

func countEvents(events []Event, eventType string) int {
	count := 0
	for _, event := range events {
		if event.Type == eventType {
			count++
		}
	}
	return count
}
