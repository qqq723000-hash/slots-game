package game

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestBaseWaysThenInstantWheelShareOne2500xBudget(t *testing.T) {
	tests := []struct {
		name      string
		orbitPay  int64
		wantWays  int64
		wantWheel int64
	}{
		{name: "exact boundary", orbitPay: 18_750, wantWays: 150_000, wantWheel: 100_000},
		{name: "wheel clipped after Ways", orbitPay: 20_000, wantWays: 160_000, wantWheel: 90_000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := probabilisticSurgeConfig()
			config.Paytable[SymbolOrbit] = test.orbitPay
			config.Feature.Wheel = []WeightedWheel{{Kind: WheelInstant, Multiplier: 1000, Weight: 1}}
			engine := mustEngine(t, config, exactlyThreeSurgeSequence(48)...)

			outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
			if err != nil {
				t.Fatal(err)
			}
			if outcome.TotalWinMinor != 250_000 || len(outcome.Wins) != 1 ||
				outcome.Wins[0].AmountMinor != test.wantWays {
				t.Fatalf("capped base result = total:%d wins:%+v", outcome.TotalWinMinor, outcome.Wins)
			}
			wheel := requireEvent(t, outcome.Events, "wheel.awarded")
			if wheel.Multiplier != 1000 || wheel.AmountMinor != test.wantWheel {
				t.Fatalf("capped Wheel award = %+v", wheel)
			}
			capEvent := requireEvent(t, outcome.Events, "win_cap.reached")
			if capEvent.Multiplier != 2_500 || capEvent.CumulativeWinMinor != 250_000 {
				t.Fatalf("max-win event = %+v", capEvent)
			}
			if err := ValidateOutcomeAgainstConfig(config, SpinInput{BetMinor: 100}, outcome); err != nil {
				t.Fatalf("authoritative capped result rejected: %v", err)
			}
		})
	}
}

func TestBaseWaysProjectionCannotExceed2500x(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolOrbit, SymbolOrbit)
	config.Paytable[SymbolOrbit] = 9_999
	engine := mustEngine(t, config, repeatedSequence(24, 0)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.TotalWinMinor != 250_000 || len(outcome.Wins) != 1 ||
		outcome.Wins[0].AmountMinor != 269_973 || outcome.Wins[0].PaidAmountMinor != 250_000 ||
		outcome.Wins[0].Ways != 27 || len(outcome.Wins[0].PathAwards) != 27 {
		t.Fatalf("capped Ways projection = %+v", outcome)
	}
	for index, path := range outcome.Wins[0].PathAwards {
		wantPaid := int64(9_999)
		if index == 25 {
			wantPaid = 25
		} else if index == 26 {
			wantPaid = 0
		}
		if path.AmountMinor != 9_999 || path.BaseAmountMinor != 9_999 ||
			path.PaidAmountMinor != wantPaid {
			t.Fatalf("capped path = %+v", path)
		}
	}
	requireEvent(t, outcome.Events, "win_cap.reached")
	if err := ValidateOutcomeAgainstConfig(config, SpinInput{BetMinor: 100}, outcome); err != nil {
		t.Fatalf("capped Ways projection rejected: %v", err)
	}
}

func TestBaseVaultAwardsAreSequentiallyClippedAt2500x(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1000, Weight: 1}}
	config.Feature.VaultUnlockChanceBP = 10_000
	engine := mustEngine(t, config, repeatedSequence(32, 0)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.TotalWinMinor != 250_000 {
		t.Fatalf("base Vault total = %d, want 250000", outcome.TotalWinMinor)
	}
	if got := eventAmounts(outcome.Events, "vault.awarded"); !reflect.DeepEqual(got, []int64{100_000, 100_000, 50_000}) {
		t.Fatalf("base Vault payments = %v", got)
	}
	requireEvent(t, outcome.Events, "win_cap.reached")

	// 即使在不依赖定义的持久化边界，当上限事件不再与已支付的整场总额匹配时，
	// 也会拒绝表面自洽但多支付一个单位的结果；感知定义的边界同样会拒绝。
	tampered := outcome
	tampered.Events = append([]Event(nil), outcome.Events...)
	lastAward := -1
	for index := range tampered.Events {
		if tampered.Events[index].Type == "vault.awarded" {
			lastAward = index
		}
	}
	tampered.Events[lastAward].AmountMinor++
	tampered.TotalWinMinor++
	if err := ValidateOutcomeStructure(SpinInput{BetMinor: 100}, tampered); err == nil {
		t.Fatal("structure validation accepted a one-unit max-win overpayment")
	}
	if err := ValidateOutcomeAgainstConfig(config, SpinInput{BetMinor: 100}, tampered); err == nil {
		t.Fatal("definition validation accepted a one-unit max-win overpayment")
	}
}

func TestTriggeringBaseWinCarriesIntoFeatureCapState(t *testing.T) {
	config := probabilisticSurgeConfig()
	config.Feature.Wheel = []WeightedWheel{{Kind: WheelExpansion, Weight: 1}}
	engine := mustEngine(t, config, exactlyThreeSurgeSequence(48)...)

	outcome, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !outcome.NextFeature.Active() || outcome.TotalWinMinor != 240 ||
		outcome.NextFeature.WinMinor != outcome.TotalWinMinor {
		t.Fatalf("feature start did not carry triggering game win: outcome=%+v", outcome)
	}
}

func TestKongQuestUsesRecoveredWholeGameBudget(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolVault, SymbolOrbit)
	config.VaultMultipliers = []WeightedInt{{Value: 1000, Weight: 1}}
	config.Feature.VaultUnlockChanceBP = 10_000
	config.Feature.VaultFreeSpinWeight = 0
	values := repeatedSequence(64, 0)
	engine := mustEngine(t, config, values...)
	input := SpinInput{BetMinor: 100, Feature: FeatureState{
		Mode: FeatureExpansion, Remaining: 2, Awarded: 8, BetMinor: 100,
		WinMinor: 100_000, RageLevel: DefaultRageLevel,
	}}

	outcome, err := engine.Spin(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.TotalWinMinor != 150_000 || outcome.NextFeature.WinMinor != 250_000 ||
		outcome.NextFeature.Remaining != 1 {
		t.Fatalf("capped Kong recovery result = %+v", outcome)
	}
	if got := eventAmounts(outcome.Events, "vault.awarded"); !reflect.DeepEqual(got, []int64{100_000, 50_000, 0}) {
		t.Fatalf("Kong Vault payments = %v", got)
	}
	requireEvent(t, outcome.Events, "win_cap.reached")
	if err := ValidateOutcomeAgainstConfig(config, input, outcome); err != nil {
		t.Fatalf("recovered Kong max-win result rejected: %v", err)
	}

	afterCap, err := engine.Spin(context.Background(), SpinInput{
		BetMinor: 100, Feature: outcome.NextFeature,
	})
	if err != nil {
		t.Fatal(err)
	}
	if afterCap.TotalWinMinor != 0 || afterCap.NextFeature.Active() ||
		!reflect.DeepEqual(eventAmounts(afterCap.Events, "vault.awarded"), []int64{0, 0, 0}) {
		t.Fatalf("post-cap Kong result overpaid or remained active: %+v", afterCap)
	}
	if capEvent := requireEvent(t, afterCap.Events, "win_cap.reached"); capEvent.CumulativeWinMinor != 250_000 {
		t.Fatalf("post-cap boundary = %+v", capEvent)
	}
	if completed := requireEvent(t, afterCap.Events, "free_spins.completed"); completed.CumulativeWinMinor != 250_000 {
		t.Fatalf("post-cap completion = %+v", completed)
	}
}

func TestRecoveredFeatureStateCannotExceedDefinitionCap(t *testing.T) {
	config := deterministicConfig(SymbolOrbit, SymbolOrbit, SymbolOrbit)
	engine := mustEngine(t, config, repeatedSequence(16, 0)...)
	_, err := engine.Spin(context.Background(), SpinInput{BetMinor: 100, Feature: FeatureState{
		Mode: FeatureOverdrive, Remaining: 1, Awarded: 8, BetMinor: 100,
		WinMinor: 250_001, RageLevel: DefaultRageLevel,
	}})
	if err == nil || !strings.Contains(err.Error(), "exceeds the definition max win") {
		t.Fatalf("over-cap recovered state error = %v", err)
	}
}

func eventAmounts(events []Event, eventType string) []int64 {
	amounts := make([]int64, 0)
	for _, event := range events {
		if event.Type == eventType {
			amounts = append(amounts, event.AmountMinor)
		}
	}
	return amounts
}
