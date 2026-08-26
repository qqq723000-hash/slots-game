package game

import (
	"context"
	"reflect"
	"testing"
)

func TestPublishedPrimalWheelCatalogIsComplete(t *testing.T) {
	config := DemoConfig()
	instant := map[int64]bool{}
	var kongQuest, kingSpin bool
	for _, outcome := range config.Feature.Wheel {
		switch outcome.Kind {
		case WheelInstant:
			instant[outcome.Multiplier] = true
		case WheelExpansion:
			kongQuest = true
		case WheelOverdrive:
			kingSpin = true
		}
	}
	want := map[int64]bool{10: true, 30: true, 75: true, 250: true, 1000: true}
	if !reflect.DeepEqual(instant, want) || !kongQuest || !kingSpin {
		t.Fatalf("wheel catalog = instant:%v KQ:%v KS:%v, want five fixed jackpots and both Free Spins", instant, kongQuest, kingSpin)
	}
}

func TestPublishedWildAndVaultCataloguesAreComplete(t *testing.T) {
	config := DemoConfig()
	values := func(items []WeightedInt) map[int64]bool {
		result := make(map[int64]bool, len(items))
		for _, item := range items {
			result[item.Value] = true
		}
		return result
	}
	wantWild := map[int64]bool{0: true, 1: true, 2: true, 3: true, 5: true, 10: true, 25: true, 50: true, 100: true}
	wantVault := map[int64]bool{
		1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true, 9: true,
		10: true, 30: true, 75: true, 250: true, 1000: true,
	}
	if !reflect.DeepEqual(values(config.WildMultipliers), wantWild) {
		t.Fatalf("Wild catalogue = %v, want %v", values(config.WildMultipliers), wantWild)
	}
	if !reflect.DeepEqual(values(config.VaultMultipliers), wantVault) {
		t.Fatalf("Vault catalogue = %v, want %v", values(config.VaultMultipliers), wantVault)
	}
	kingValues := values(config.OverdriveMultipliers)
	for _, doubled := range []int64{20, 60, 150, 500} {
		if !kingValues[doubled] || vaultPrizeName(doubled, true) == vaultPrizeName(doubled, false) {
			t.Fatalf("King Spin catalogue is missing a named 2X jackpot at x%d", doubled)
		}
	}
	if isBaseJackpotMultiplier(1000) {
		t.Fatal("GRAND must not have a King Spin 2X variant")
	}
}

func TestPlainWildAndExplicitX1RemainDistinctAuthoritativeFaces(t *testing.T) {
	plainConfig := deterministicConfig(SymbolOrbit, SymbolWild, SymbolOrbit)
	plainConfig.WildMultipliers = []WeightedInt{{Value: 0, Weight: 1}}
	plain := mustEngine(t, plainConfig, repeatedSequence(24, 0)...)
	plainOutcome, err := plain.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}

	x1Config := plainConfig
	x1Config.WildMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
	x1 := mustEngine(t, x1Config, repeatedSequence(24, 0)...)
	x1Outcome, err := x1.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	for row := range plainOutcome.Grid[1] {
		if plainOutcome.Grid[1][row].Multiplier != 0 || x1Outcome.Grid[1][row].Multiplier != 1 {
			t.Fatalf("row %d faces = plain:%+v x1:%+v", row, plainOutcome.Grid[1][row], x1Outcome.Grid[1][row])
		}
	}
	if plainOutcome.TotalWinMinor != x1Outcome.TotalWinMinor || plainOutcome.TotalWinMinor != 810 {
		t.Fatalf("effective x1 totals = plain:%d explicit:%d, want 810", plainOutcome.TotalWinMinor, x1Outcome.TotalWinMinor)
	}
}

func TestWildCellCarriesServerSampledMultiplierUsedByWays(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolWild, SymbolOrbit)
	config.WildMultipliers = []WeightedInt{{Value: 5, Weight: 1}}
	engine := mustEngine(t, config, repeatedSequence(24, 0)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	for row, cell := range outcome.Grid[1] {
		if cell.Symbol != SymbolWild || cell.Multiplier != 5 || cell.Prize != "" {
			t.Fatalf("grid[1][%d] = %+v, want authoritative WILD x5", row, cell)
		}
	}
	// 左侧 3 个 ORBIT × 中间 3 个 5 倍 WILD × 右侧 3 个 ORBIT × 已采集赔付 0.3 倍。
	if outcome.TotalWinMinor != 4_050 || len(outcome.Wins) != 1 || outcome.Wins[0].AmountMinor != 4_050 {
		t.Fatalf("WILD result = total:%d wins:%+v, want 4050", outcome.TotalWinMinor, outcome.Wins)
	}
}

func TestUnlockedVaultCellMatchesRevealAwardAndPayment(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 30, Weight: 1}}
	config.Feature.VaultUnlockChanceBP = 10_000
	engine := mustEngine(t, config, repeatedSequence(24, 0)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.TotalWinMinor != 9_000 {
		t.Fatalf("Vault total = %d, want three MINOR x30 awards", outcome.TotalWinMinor)
	}
	for row, cell := range outcome.Grid[1] {
		if cell != (Cell{Symbol: SymbolVault, Multiplier: 30, Prize: "MINOR"}) {
			t.Fatalf("grid[1][%d] = %+v, want final MINOR x30 Vault", row, cell)
		}
	}
	for _, event := range outcome.Events {
		if event.Type == "vault.awarded" &&
			(event.Multiplier != 30 || event.Prize != "MINOR" || event.AmountMinor != 3_000) {
			t.Fatalf("Vault award = %+v, want matching MINOR x30 payment", event)
		}
	}
}

func TestBaseGameVaultsCanRemainLockedWithoutHiddenAward(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.Feature.VaultUnlockChanceBP = 0
	engine := mustEngine(t, config, repeatedSequence(16, 0)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.TotalWinMinor != 0 || countEvents(outcome.Events, "vault.awarded") != 0 {
		t.Fatalf("locked Vault outcome = win:%d events:%+v", outcome.TotalWinMinor, outcome.Events)
	}
	if eventIndex(outcome.Events, "vaults.landed") != 0 || eventIndex(outcome.Events, "vaults.locked") != 1 {
		t.Fatalf("Vault event order = %+v, want landed then locked", outcome.Events)
	}
	for row, cell := range outcome.Grid[1] {
		if cell.Multiplier != 0 || cell.Prize != "" {
			t.Fatalf("locked grid[1][%d] exposed hidden reward: %+v", row, cell)
		}
	}
}

func TestKongQuestFreeSpinVaultRewardRetriggersAndNoChanceBasedRetriggerExists(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
	config.Feature.VaultFreeSpinWeight = 1
	values := repeatedSequence(48, 1)
	values[0] = 0 // Three-row Kong Quest result.
	engine := mustEngine(t, config, values...)
	state := FeatureState{Mode: FeatureExpansion, Remaining: 1, Awarded: 8, BetMinor: 100, WinMinor: 250}

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatal(err)
	}
	if got := outcome.NextFeature; got.Mode != FeatureExpansion || got.Remaining != 3 || got.Awarded != 11 {
		t.Fatalf("next feature = %+v, want three FREE_SPIN Vault rewards", got)
	}
	if outcome.NextFeature.WinMinor != 250 {
		t.Fatalf("running Free Spins win = %d, want recovered prior total 250", outcome.NextFeature.WinMinor)
	}
	if countEvents(outcome.Events, "free_spin.awarded") != 3 {
		t.Fatalf("events = %+v, want one retrigger per FREE_SPIN Vault", outcome.Events)
	}
	for _, event := range outcome.Events {
		if event.Type == "vault.unlocked" && event.Prize != "FREE_SPIN" {
			t.Fatalf("Vault reward = %+v, want FREE_SPIN", event)
		}
	}
	for row, cell := range outcome.Grid[1] {
		if cell.Multiplier != 0 || cell.Prize != "FREE_SPIN" {
			t.Fatalf("FREE_SPIN grid[1][%d] = %+v, want prize-only Vault", row, cell)
		}
	}
}

func TestKongQuestFreeSpinCapIsExplicit(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
	config.Feature.VaultFreeSpinWeight = 1
	values := repeatedSequence(48, 1)
	values[0] = 0
	engine := mustEngine(t, config, values...)
	state := FeatureState{
		Mode: FeatureExpansion, Remaining: 1, Awarded: config.Feature.MaxExpansionSpins, BetMinor: 100,
	}

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.NextFeature.Active() || countEvents(outcome.Events, "free_spin.cap_reached") != 3 ||
		countEvents(outcome.Events, "free_spins.completed") != 1 {
		t.Fatalf("capped Kong Quest outcome = state:%+v events:%+v", outcome.NextFeature, outcome.Events)
	}
}

func TestKingSpinUnlocksEveryVaultThenAppliesOrderedUpgradeRounds(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
	config.OverdriveMultipliers = []WeightedInt{
		{Value: 2, Weight: 1}, {Value: 10, Weight: 1}, {Value: 30, Weight: 1},
	}
	config.Feature.KingSpinUpgradeChanceBP = 10_000
	config.Feature.KingSpinMaxUpgradeRounds = 2
	config.Feature.OverdriveDoubleChanceBP = 0
	engine := mustEngine(t, config, repeatedSequence(64, 0)...)
	state := FeatureState{Mode: FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100, WinMinor: 250}

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatal(err)
	}
	if countEvents(outcome.Events, "vault.unlocked") != 3 ||
		countEvents(outcome.Events, "vaults.upgrade.started") != 2 ||
		countEvents(outcome.Events, "vault.upgraded") != 6 ||
		countEvents(outcome.Events, "vault.awarded") != 3 {
		t.Fatalf("King Spin events = %+v", outcome.Events)
	}
	if outcome.TotalWinMinor != 3_000 {
		t.Fatalf("King Spin win = %d, want three x10 Vaults", outcome.TotalWinMinor)
	}
	for row, cell := range outcome.Grid[1] {
		if cell.Multiplier != 10 || cell.Prize != "MINI" {
			t.Fatalf("final King Spin grid[1][%d] = %+v, want upgraded MINI x10", row, cell)
		}
	}
	firstUnlock := eventIndex(outcome.Events, "vault.unlocked")
	firstUpgrade := eventIndex(outcome.Events, "vaults.upgrade.started")
	firstAward := eventIndex(outcome.Events, "vault.awarded")
	completed := eventIndex(outcome.Events, "free_spins.completed")
	if !(firstUnlock < firstUpgrade && firstUpgrade < firstAward && firstAward < completed) {
		t.Fatalf("King Spin event order = %+v", outcome.Events)
	}
	if event := requireEvent(t, outcome.Events, "free_spins.completed"); event.CumulativeWinMinor != 3_250 {
		t.Fatalf("completed Free Spins win = %d, want prior 250 plus spin win 3000", event.CumulativeWinMinor)
	}
}

func TestKingSpinUpgradeCatalogCanReachGrand(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1, Weight: 1}}
	config.OverdriveMultipliers = []WeightedInt{{Value: 1000, Weight: 1}}
	config.Feature.KingSpinUpgradeChanceBP = 10_000
	config.Feature.KingSpinMaxUpgradeRounds = 3
	config.Feature.OverdriveDoubleChanceBP = 0
	engine := mustEngine(t, config, repeatedSequence(64, 0)...)
	state := FeatureState{
		Mode: FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100,
		WinMinor: 40_000, RageLevel: DefaultRageLevel,
	}

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatal(err)
	}
	if countEvents(outcome.Events, "vaults.upgrade.started") != 1 ||
		countEvents(outcome.Events, "vault.upgraded") != 3 {
		t.Fatalf("King Spin GRAND upgrade events = %+v", outcome.Events)
	}
	for row, cell := range outcome.Grid[1] {
		if cell.Multiplier != 1000 || cell.Prize != "GRAND" {
			t.Fatalf("final King Spin grid[1][%d] = %+v, want GRAND x1000", row, cell)
		}
	}
	for _, event := range outcome.Events {
		if (event.Type == "vault.upgraded" || event.Type == "vault.awarded") &&
			event.Prize != "GRAND" {
			t.Fatalf("final King Spin GRAND event = %+v", event)
		}
	}
	if outcome.TotalWinMinor != 210_000 {
		t.Fatalf("King Spin GRAND win = %d, want only the remaining 210000 cap budget", outcome.TotalWinMinor)
	}
	if event := requireEvent(t, outcome.Events, "win_cap.reached"); event.Multiplier != 2_500 || event.CumulativeWinMinor != 250_000 {
		t.Fatalf("King Spin max-win event = %+v", event)
	}
	amounts := []int64{}
	for _, event := range outcome.Events {
		if event.Type == "vault.awarded" {
			amounts = append(amounts, event.AmountMinor)
		}
	}
	if !reflect.DeepEqual(amounts, []int64{100_000, 100_000, 10_000}) {
		t.Fatalf("capped King Spin Vault awards = %v", amounts)
	}
	if completed := requireEvent(t, outcome.Events, "free_spins.completed"); completed.CumulativeWinMinor != 250_000 {
		t.Fatalf("capped King Spin completion = %+v", completed)
	}
}

func TestFailedRageCollectionPersistsAndApeTriggerEmitsTransformationBeforeWheel(t *testing.T) {
	config := probabilisticSurgeConfig()
	config.Feature.SurgeOneChanceBP = 0
	first := mustEngine(t, config,
		1, 0, 0,
		0, 0, 0,
		0, 0, 0,
	)
	outcome, err := first.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.NextFeature.RageCollected != 1 || outcome.NextFeature.RageLevel != 1 {
		t.Fatalf("Rage state = %+v, want collected=1 level=1", outcome.NextFeature)
	}

	config.Feature.SurgeOneChanceBP = 10_000
	config.Feature.Wheel = []WeightedWheel{{Kind: WheelInstant, Multiplier: 10, Weight: 1}}
	second := mustEngine(t, config,
		1, 0, 0,
		0, 0, 0,
		0, 0, 0,
		0, 0, // Two authoritative Rage placements.
		0, // Wheel result.
	)
	triggered, err := second.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: outcome.NextFeature})
	if err != nil {
		t.Fatal(err)
	}
	if triggered.NextFeature.RageCollected != 0 || triggered.NextFeature.RageLevel != DefaultRageLevel {
		t.Fatalf("Rage state after wheel = %+v, want reset level 1 / total 0", triggered.NextFeature)
	}
	collected := eventIndex(triggered.Events, "surge.collected")
	transformed := eventIndex(triggered.Events, "rage.transformed")
	wheelStarted := eventIndex(triggered.Events, "wheel.started")
	wheelAwarded := eventIndex(triggered.Events, "wheel.awarded")
	if !(collected < transformed && transformed < wheelStarted && wheelStarted < wheelAwarded) {
		t.Fatalf("Rage/wheel event order = %+v", triggered.Events)
	}
	if event := requireEvent(t, triggered.Events, "rage.transformed"); event.Count != 2 || len(event.Cells) != 2 ||
		event.Level != triggered.Events[collected].Level || event.Total != triggered.Events[collected].Total {
		t.Fatalf("Rage transformation = %+v, want exactly two added symbols", event)
	}
	if event := triggered.Events[collected]; event.Level != DefaultRageLevel || event.Total != 0 {
		t.Fatalf("Rage collection = %+v, want reset snapshot level 1 / total 0", event)
	}
	award := requireEvent(t, triggered.Events, "wheel.awarded")
	if award.Prize != "MINI" || award.Multiplier != 10 || award.AmountMinor != 1_000 {
		t.Fatalf("wheel award = %+v, want MINI x10", award)
	}
	input := SpinInput{BetMinor: 100, Feature: outcome.NextFeature}
	for name, mutate := range map[string]func(*Event){
		"level": func(event *Event) { event.Level++ },
		"total": func(event *Event) { event.Total++ },
	} {
		t.Run("rejects transformed "+name+" drift", func(t *testing.T) {
			tampered := triggered
			tampered.Events = append([]Event(nil), triggered.Events...)
			mutate(&tampered.Events[transformed])
			if err := ValidateOutcomeStructure(input, tampered); err == nil {
				t.Fatalf("Rage transformation with mismatched %s unexpectedly accepted", name)
			}
		})
	}
}

func TestCapturedRageLevelTwoBoundaryAndSixAuthoredLevels(t *testing.T) {
	thresholds := DemoConfig().Feature.RageLevelThresholds
	if len(thresholds) != 6 {
		t.Fatalf("Rage thresholds = %v, want six authored visual levels", thresholds)
	}
	if got := rageLevelFor(11, thresholds); got != 1 {
		t.Fatalf("Rage level at total 11 = %d, want 1", got)
	}
	if got := rageLevelFor(12, thresholds); got != 2 {
		t.Fatalf("Rage level at captured total 12 = %d, want 2", got)
	}
}

func TestFreeSpinReelsExcludeRageSymbols(t *testing.T) {
	config := DemoConfig()
	for reel := range config.Reels {
		config.Reels[reel] = []WeightedSymbol{
			{Value: SymbolSurge, Weight: 1}, {Value: SymbolOrbit, Weight: 1},
		}
	}
	engine := mustEngine(t, config, repeatedSequence(64, 0)...)
	state := FeatureState{Mode: FeatureOverdrive, Remaining: 2, Awarded: 8, BetMinor: 100}
	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: state})
	if err != nil {
		t.Fatal(err)
	}
	if len(positionsForSymbol(outcome.Grid, SymbolSurge)) != 0 || countEvents(outcome.Events, "surge.collected") != 0 {
		t.Fatalf("Free Spins contained Rage: grid=%+v events=%+v", outcome.Grid, outcome.Events)
	}
}
