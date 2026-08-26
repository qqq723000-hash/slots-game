package game

import (
	"context"
	"testing"
)

func TestValidateOutcomeStructureRejectsHiddenOrMalformedAwards(t *testing.T) {
	valid := SpinOutcome{
		Grid: Grid{
			{{Symbol: SymbolOrbit}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
			{{Symbol: SymbolOrbit}, {Symbol: SymbolWild, Multiplier: 2}, {Symbol: SymbolPulse}},
			{{Symbol: SymbolOrbit}, {Symbol: SymbolPrism}, {Symbol: SymbolNova}},
		},
		Wins: []Win{{
			ID: "orbit-3", Symbol: SymbolOrbit, Ways: 1, AmountMinor: 50, PaidAmountMinor: 50,
			Cells: []Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
			PathAwards: []PathAward{{
				Cells:      []Position{{Reel: 0, Row: 0}, {Reel: 1, Row: 0}, {Reel: 2, Row: 0}},
				Multiplier: 1, BaseAmountMinor: 50, AmountMinor: 50, PaidAmountMinor: 50,
			}},
		}},
		TotalWinMinor: 50,
		NextFeature:   EmptyFeatureState(),
	}
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, valid); err != nil {
		t.Fatalf("valid outcome rejected: %v", err)
	}
	hidden := valid
	hidden.TotalWinMinor++
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, hidden); err == nil {
		t.Fatal("hidden award unexpectedly accepted")
	}
	malformed := valid
	malformed.Grid = append(Grid(nil), valid.Grid...)
	malformed.Grid[0] = malformed.Grid[0][:2]
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, malformed); err == nil {
		t.Fatal("malformed grid unexpectedly accepted")
	}
	missingPaths := valid
	missingPaths.Wins = append([]Win(nil), valid.Wins...)
	missingPaths.Wins[0].PathAwards = nil
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, missingPaths); err == nil {
		t.Fatal("win without its authoritative path awards unexpectedly accepted")
	}
	wrongPathAmount := valid
	wrongPathAmount.Wins = append([]Win(nil), valid.Wins...)
	wrongPathAmount.Wins[0].PathAwards = append([]PathAward(nil), valid.Wins[0].PathAwards...)
	wrongPathAmount.Wins[0].PathAwards[0].AmountMinor--
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, wrongPathAmount); err == nil {
		t.Fatal("path amount drift unexpectedly accepted")
	}
	wrongBaseAmount := valid
	wrongBaseAmount.Wins = append([]Win(nil), valid.Wins...)
	wrongBaseAmount.Wins[0].PathAwards = append([]PathAward(nil), valid.Wins[0].PathAwards...)
	wrongBaseAmount.Wins[0].PathAwards[0].BaseAmountMinor--
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, wrongBaseAmount); err == nil {
		t.Fatal("path base amount drift unexpectedly accepted")
	}
	wrongPathMultiplier := valid
	wrongPathMultiplier.Wins = append([]Win(nil), valid.Wins...)
	wrongPathMultiplier.Wins[0].PathAwards = append([]PathAward(nil), valid.Wins[0].PathAwards...)
	wrongPathMultiplier.Wins[0].PathAwards[0].Multiplier = 2
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, wrongPathMultiplier); err == nil {
		t.Fatal("path WILD multiplier drift unexpectedly accepted")
	}
	fabricatedEventAward := valid
	fabricatedEventAward.Events = []Event{{Type: "test.marker", AmountMinor: 100}}
	fabricatedEventAward.TotalWinMinor = 150
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, fabricatedEventAward); err == nil {
		t.Fatal("non-monetary event award unexpectedly accepted")
	}
}

func TestValidateOutcomeStructureRejectsFeatureSequenceDrift(t *testing.T) {
	t.Run("Vault order", func(t *testing.T) {
		config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
		config.Feature.VaultUnlockChanceBP = 0
		engine := mustEngine(t, config, repeatedSequence(24, 0)...)
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
		if err != nil {
			t.Fatal(err)
		}
		outcome.Events[0], outcome.Events[1] = outcome.Events[1], outcome.Events[0]
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, outcome); err == nil {
			t.Fatal("reordered Vault sequence unexpectedly accepted")
		}
	})

	t.Run("wheel boundary", func(t *testing.T) {
		config := DemoConfig()
		for reel := range config.Reels {
			config.Reels[reel] = []WeightedSymbol{
				{Value: SymbolOrbit, Weight: 1}, {Value: SymbolSurge, Weight: 1},
			}
		}
		config.Feature.Wheel = []WeightedWheel{{Kind: WheelInstant, Multiplier: 10, Weight: 1}}
		engine := mustEngine(t, config, exactlyThreeSurgeSequence(32)...)
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
		if err != nil {
			t.Fatal(err)
		}
		started := eventIndex(outcome.Events, "wheel.started")
		outcome.Events = append(outcome.Events[:started], outcome.Events[started+1:]...)
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, outcome); err == nil {
			t.Fatal("wheel award without wheel.started unexpectedly accepted")
		}
	})

	t.Run("three settled Rage must trigger", func(t *testing.T) {
		config := DemoConfig()
		for reel := range config.Reels {
			config.Reels[reel] = []WeightedSymbol{
				{Value: SymbolOrbit, Weight: 1}, {Value: SymbolSurge, Weight: 1},
			}
		}
		config.Feature.Wheel = []WeightedWheel{{Kind: WheelInstant, Multiplier: 10, Weight: 1}}
		engine := mustEngine(t, config, exactlyThreeSurgeSequence(48)...)
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
		if err != nil {
			t.Fatal(err)
		}
		collection := eventIndex(outcome.Events, "surge.collected")
		award := eventIndex(outcome.Events, "wheel.awarded")
		if collection < 0 || award < 0 || outcome.Events[collection].Count != 3 {
			t.Fatal("fixture did not produce the intended guaranteed Rage trigger")
		}

		tampered := outcome
		tampered.Events = append([]Event(nil), outcome.Events...)
		tampered.Events[collection].Triggered = false
		tampered.TotalWinMinor -= tampered.Events[award].AmountMinor
		filtered := tampered.Events[:0]
		for _, event := range tampered.Events {
			if event.Type != "wheel.started" && event.Type != "wheel.awarded" {
				filtered = append(filtered, event)
			}
		}
		tampered.Events = filtered
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err == nil {
			t.Fatal("three settled Rage symbols without a Wheel unexpectedly accepted")
		}
	})

	t.Run("more than three settled Rage are rejected", func(t *testing.T) {
		outcome := SpinOutcome{
			Grid: Grid{
				{{Symbol: SymbolSurge}, {Symbol: SymbolSurge}, {Symbol: SymbolOrbit}},
				{{Symbol: SymbolSurge}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
				{{Symbol: SymbolSurge}, {Symbol: SymbolNova}, {Symbol: SymbolCircuit}},
			},
			NextFeature: EmptyFeatureState(),
		}
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, outcome); err == nil {
			t.Fatal("more than three settled Rage symbols unexpectedly accepted")
		}
	})

	t.Run("Free Spins start counters", func(t *testing.T) {
		config := DemoConfig()
		for reel := range config.Reels {
			config.Reels[reel] = []WeightedSymbol{
				{Value: SymbolOrbit, Weight: 1}, {Value: SymbolSurge, Weight: 1},
			}
		}
		config.Feature.Wheel = []WeightedWheel{{Kind: WheelExpansion, Weight: 1}}
		engine := mustEngine(t, config, exactlyThreeSurgeSequence(48)...)
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
		if err != nil {
			t.Fatal(err)
		}
		counterDrift := outcome
		counterDrift.NextFeature.Remaining--
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, counterDrift); err == nil {
			t.Fatal("Free Spins start with mismatched remaining/awarded unexpectedly accepted")
		}
		wrongInitial := outcome
		wrongInitial.Events = append([]Event(nil), outcome.Events...)
		started := eventIndex(wrongInitial.Events, "free_spins.started")
		wrongInitial.Events[started].Awarded = 7
		wrongInitial.NextFeature.Remaining = 7
		wrongInitial.NextFeature.Awarded = 7
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, wrongInitial); err == nil {
			t.Fatal("non-eight initial Free Spins award unexpectedly accepted")
		}
	})

	t.Run("recovered Free Spins win", func(t *testing.T) {
		config := deterministicConfig(SymbolOrbit, SymbolOrbit, SymbolOrbit)
		engine := mustEngine(t, config, repeatedSequence(32, 0)...)
		state := FeatureState{
			Mode: FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100,
			WinMinor: 500, RageLevel: DefaultRageLevel,
		}
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
		if err != nil {
			t.Fatal(err)
		}
		completed := eventIndex(outcome.Events, "free_spins.completed")
		outcome.Events[completed].CumulativeWinMinor++
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100, Feature: state}, outcome); err == nil {
			t.Fatal("incorrect cumulative Free Spins win unexpectedly accepted")
		}
	})

	t.Run("active Free Spins counters", func(t *testing.T) {
		config := deterministicConfig(SymbolOrbit, SymbolOrbit, SymbolOrbit)
		engine := mustEngine(t, config, repeatedSequence(32, 0)...)
		state := FeatureState{
			Mode: FeatureExpansion, Remaining: 3, Awarded: 8, BetMinor: 100,
			RageLevel: DefaultRageLevel,
		}
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
		if err != nil {
			t.Fatal(err)
		}
		remainingDrift := outcome
		remainingDrift.NextFeature.Remaining++
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100, Feature: state}, remainingDrift); err == nil {
			t.Fatal("incorrect active remaining counter unexpectedly accepted")
		}
		awardedDrift := outcome
		awardedDrift.NextFeature.Awarded++
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100, Feature: state}, awardedDrift); err == nil {
			t.Fatal("incorrect active awarded counter unexpectedly accepted")
		}
	})

	t.Run("Kong retrigger counters", func(t *testing.T) {
		config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
		config.VaultMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
		config.Feature.VaultFreeSpinWeight = 1
		config.Feature.VaultUnlockChanceBP = 10_000
		engine := mustEngine(t, config, repeatedSequence(96, 1)...)
		state := FeatureState{
			Mode: FeatureExpansion, Remaining: 2, Awarded: 8, BetMinor: 100,
			RageLevel: DefaultRageLevel,
		}
		outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
		if err != nil {
			t.Fatal(err)
		}
		if countEvents(outcome.Events, "free_spin.awarded") == 0 {
			t.Fatal("fixture did not produce the intended retrigger")
		}
		remainingDrift := outcome
		remainingDrift.NextFeature.Remaining--
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100, Feature: state}, remainingDrift); err == nil {
			t.Fatal("retrigger remaining drift unexpectedly accepted")
		}
		awardedDrift := outcome
		awardedDrift.NextFeature.Awarded--
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100, Feature: state}, awardedDrift); err == nil {
			t.Fatal("retrigger awarded drift unexpectedly accepted")
		}
	})
}

func TestValidateOutcomeStructureEnforcesRageResetOwnership(t *testing.T) {
	t.Run("triggered one/two Rage cannot retain credited meter", func(t *testing.T) {
		config := probabilisticSurgeConfig()
		config.Feature.SurgeTwoChanceBP = 10_000
		config.Feature.Wheel = []WeightedWheel{{Kind: WheelExpansion, Weight: 1}}
		engine := mustEngine(t, config,
			1, 1, 0,
			0, 0, 0,
			0, 0, 0,
			0, // One transformed Rage placement.
			0, // Wheel result.
		)
		input := SpinInput{
			BetMinor: 100,
			Feature:  FeatureState{Mode: FeatureNone, RageLevel: 1, RageCollected: 11},
		}
		outcome, err := engine.Spin(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		collection := requireEvent(t, outcome.Events, "surge.collected")
		if collection.Total != 0 || collection.Level != 1 ||
			outcome.NextFeature.RageCollected != 0 || outcome.NextFeature.RageLevel != 1 {
			t.Fatalf("trigger fixture = collection:%+v next:%+v, want reset snapshot and final state 1/0", collection, outcome.NextFeature)
		}
		retained := outcome
		retained.NextFeature.RageLevel = 2
		retained.NextFeature.RageCollected = 13
		if err := ValidateOutcomeStructure(input, retained); err == nil {
			t.Fatal("triggered one/two-Rage result retaining its credited meter unexpectedly accepted")
		}
		staleSnapshot := outcome
		staleSnapshot.Events = append([]Event(nil), outcome.Events...)
		for _, eventType := range []string{"surge.collected", "rage.transformed"} {
			index := eventIndex(staleSnapshot.Events, eventType)
			staleSnapshot.Events[index].Level = 2
			staleSnapshot.Events[index].Total = 13
		}
		if err := ValidateOutcomeStructure(input, staleSnapshot); err == nil {
			t.Fatal("triggered one/two-Rage credited pre-reset event snapshot unexpectedly accepted")
		}
	})

	t.Run("failed one/two Rage cannot reset meter", func(t *testing.T) {
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
			t.Fatal(err)
		}
		reset := outcome
		reset.NextFeature.RageLevel = DefaultRageLevel
		reset.NextFeature.RageCollected = 0
		if err := ValidateOutcomeStructure(input, reset); err == nil {
			t.Fatal("failed one/two-Rage result resetting its credited meter unexpectedly accepted")
		}
		resetSnapshot := outcome
		resetSnapshot.Events = append([]Event(nil), outcome.Events...)
		collection := eventIndex(resetSnapshot.Events, "surge.collected")
		resetSnapshot.Events[collection].Level = DefaultRageLevel
		resetSnapshot.Events[collection].Total = 0
		if err := ValidateOutcomeStructure(input, resetSnapshot); err == nil {
			t.Fatal("failed one/two-Rage reset event snapshot unexpectedly accepted")
		}
	})

	t.Run("direct three Rage cannot reset request-origin meter", func(t *testing.T) {
		config := probabilisticSurgeConfig()
		config.Feature.Wheel = []WeightedWheel{{Kind: WheelExpansion, Weight: 1}}
		engine := mustEngine(t, config, exactlyThreeSurgeSequence(32)...)
		input := SpinInput{
			BetMinor: 100,
			Feature:  FeatureState{Mode: FeatureNone, RageLevel: 4, RageCollected: 36},
		}
		outcome, err := engine.Spin(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		if outcome.NextFeature.RageLevel != 4 || outcome.NextFeature.RageCollected != 36 ||
			countEvents(outcome.Events, "rage.transformed") != 0 {
			t.Fatalf("direct-three fixture = next:%+v events:%+v, want retained 4/36 without transform", outcome.NextFeature, outcome.Events)
		}
		reset := outcome
		reset.NextFeature.RageLevel = DefaultRageLevel
		reset.NextFeature.RageCollected = 0
		if err := ValidateOutcomeStructure(input, reset); err == nil {
			t.Fatal("direct-three result resetting its request-origin meter unexpectedly accepted")
		}
		resetSnapshot := outcome
		resetSnapshot.Events = append([]Event(nil), outcome.Events...)
		collection := eventIndex(resetSnapshot.Events, "surge.collected")
		resetSnapshot.Events[collection].Level = DefaultRageLevel
		resetSnapshot.Events[collection].Total = 0
		if err := ValidateOutcomeStructure(input, resetSnapshot); err == nil {
			t.Fatal("direct-three reset event snapshot unexpectedly accepted")
		}
	})
}

func TestValidateOutcomeStructureRejectsCellModifierEventDrift(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 30, Weight: 1}}
	config.Feature.VaultUnlockChanceBP = 10_000
	engine := mustEngine(t, config, repeatedSequence(24, 0)...)
	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("Vault multiplier", func(t *testing.T) {
		tampered := cloneOutcomeGrid(outcome)
		tampered.Grid[1][0].Multiplier = 75
		tampered.Grid[1][0].Prize = "MAJOR"
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err == nil {
			t.Fatal("Vault cell/event multiplier disagreement unexpectedly accepted")
		}
	})

	t.Run("Vault prize", func(t *testing.T) {
		tampered := cloneOutcomeGrid(outcome)
		tampered.Grid[1][0].Prize = "X30"
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err == nil {
			t.Fatal("Vault cell/event prize disagreement unexpectedly accepted")
		}
	})

	t.Run("WILD prize", func(t *testing.T) {
		invalid := SpinOutcome{
			Grid: Grid{
				{{Symbol: SymbolOrbit}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
				{{Symbol: SymbolWild, Multiplier: 2, Prize: "X2"}, {Symbol: SymbolPrism}, {Symbol: SymbolPulse}},
				{{Symbol: SymbolOrbit}, {Symbol: SymbolPrism}, {Symbol: SymbolNova}},
			},
			NextFeature: EmptyFeatureState(),
		}
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, invalid); err == nil {
			t.Fatal("client-style WILD prize decoration unexpectedly accepted")
		}
	})
}

func TestValidateOutcomeAgainstConfigRecomputesWildWaysAwards(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolWild, SymbolOrbit)
	config.WildMultipliers = []WeightedInt{{Value: 5, Weight: 1}}
	engine := mustEngine(t, config, repeatedSequence(24, 0)...)
	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("cell multiplier", func(t *testing.T) {
		tampered := cloneOutcomeGrid(outcome)
		tampered.Grid[1][0].Multiplier = 2
		tampered.Wins = append([]Win(nil), outcome.Wins...)
		tampered.Wins[0].PathAwards = append([]PathAward(nil), outcome.Wins[0].PathAwards...)
		for index := range tampered.Wins[0].PathAwards {
			if tampered.Wins[0].PathAwards[index].Cells[1].Row == 0 {
				tampered.Wins[0].PathAwards[index].Multiplier = 2
			}
		}
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err != nil {
			t.Fatalf("structurally valid tamper should reach definition check: %v", err)
		}
		if err := ValidateOutcomeAgainstConfig(config, SpinInput{BetMinor: 100}, tampered); err == nil {
			t.Fatal("grid multiplier drift unexpectedly survived Ways recomputation")
		}
	})

	t.Run("aggregate amount", func(t *testing.T) {
		tampered := outcome
		tampered.Wins = append([]Win(nil), outcome.Wins...)
		tampered.Wins[0].PathAwards = append([]PathAward(nil), outcome.Wins[0].PathAwards...)
		tampered.Wins[0].AmountMinor++
		tampered.Wins[0].PaidAmountMinor++
		tampered.Wins[0].PathAwards[0].AmountMinor++
		tampered.Wins[0].PathAwards[0].PaidAmountMinor++
		tampered.TotalWinMinor++
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err != nil {
			t.Fatalf("balanced but false aggregate should reach definition check: %v", err)
		}
		if err := ValidateOutcomeAgainstConfig(config, SpinInput{BetMinor: 100}, tampered); err == nil {
			t.Fatal("fabricated aggregate Ways amount unexpectedly survived recomputation")
		}
	})

	t.Run("pre-multiplier amount", func(t *testing.T) {
		tampered := outcome
		tampered.Wins = append([]Win(nil), outcome.Wins...)
		tampered.Wins[0].PathAwards = append([]PathAward(nil), outcome.Wins[0].PathAwards...)
		tampered.Wins[0].PathAwards[0].BaseAmountMinor++
		if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err != nil {
			t.Fatalf("structurally valid base-amount tamper should reach definition check: %v", err)
		}
		if err := ValidateOutcomeAgainstConfig(config, SpinInput{BetMinor: 100}, tampered); err == nil {
			t.Fatal("fabricated pre-multiplier amount unexpectedly survived Ways recomputation")
		}
	})
}

func cloneOutcomeGrid(outcome SpinOutcome) SpinOutcome {
	cloned := outcome
	cloned.Grid = make(Grid, len(outcome.Grid))
	for reel := range outcome.Grid {
		cloned.Grid[reel] = append([]Cell(nil), outcome.Grid[reel]...)
	}
	return cloned
}
