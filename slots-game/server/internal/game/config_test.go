package game

import (
	"strings"
	"testing"
)

func TestDemoConfigUsesCapturedPaytableAndExplicitCleanRoomWeights(t *testing.T) {
	config := DemoConfig()
	if config.Bet.DefaultMinor != 100 {
		t.Fatalf("default bet = %d minor, want captured 1.00", config.Bet.DefaultMinor)
	}
	if config.Bet.PayUnitMinor != 100 {
		t.Fatalf("pay unit = %d minor, want 1.00 reference wager", config.Bet.PayUnitMinor)
	}
	for reelIndex, reel := range config.Reels {
		totalWeight := 0
		for _, item := range reel {
			totalWeight += item.Weight
		}
		if totalWeight != 100 {
			t.Fatalf("reel %d total weight = %d, want 100", reelIndex, totalWeight)
		}
	}
	wantPaytable := map[Symbol]int64{
		SymbolPrism:   10,
		SymbolOrbit:   30,
		SymbolPulse:   80,
		SymbolNova:    100,
		SymbolTank:    150,
		SymbolCircuit: 200,
	}
	if len(config.Paytable) != len(wantPaytable) {
		t.Fatalf("paytable has %d symbols, want %d", len(config.Paytable), len(wantPaytable))
	}
	for symbol, want := range wantPaytable {
		if got := config.Paytable[symbol]; got != want {
			t.Fatalf("%s pay = %d, want captured %d/100 total bet", symbol, got, want)
		}
	}
	if config.Feature.VaultUnlockChanceBP <= 0 || config.Feature.VaultUnlockChanceBP >= 10_000 {
		t.Fatalf("clean-room Vault unlock chance = %d, want a non-certain group decision", config.Feature.VaultUnlockChanceBP)
	}
	wantRageThresholds := []int{0, 12, 24, 36, 48, 60}
	if len(config.Feature.RageLevelThresholds) != len(wantRageThresholds) {
		t.Fatalf("Rage levels = %v, want six authored projections", config.Feature.RageLevelThresholds)
	}
	for index, want := range wantRageThresholds {
		if got := config.Feature.RageLevelThresholds[index]; got != want {
			t.Fatalf("Rage threshold %d = %d, want %d", index+1, got, want)
		}
	}
	if !IsKnownSymbol(SymbolTank) {
		t.Fatal("TANK is not recognized as a protocol/game symbol")
	}
}

func TestValidateBetUsesConfiguredOptionsAsAllowlist(t *testing.T) {
	config := DemoConfig()
	if err := config.ValidateBet(200); err != nil {
		t.Fatalf("configured bet 200 was rejected: %v", err)
	}
	if err := config.ValidateBet(250); err == nil {
		t.Fatal("unlisted bet 250 unexpectedly accepted")
	}
}

func TestConfigValidateRejectsInvalidBetOptions(t *testing.T) {
	tests := []struct {
		name        string
		mutate      func(*Config)
		wantMessage string
	}{
		{
			name: "game id is not a protocol identifier",
			mutate: func(config *Config) {
				config.GameID = "游戏/secret"
			},
			wantMessage: "invalid game id",
		},
		{
			name: "game id exceeds protocol identifier limit",
			mutate: func(config *Config) {
				config.GameID = strings.Repeat("g", 129)
			},
			wantMessage: "invalid game id",
		},
		{
			name: "missing pay unit",
			mutate: func(config *Config) {
				config.Bet.PayUnitMinor = 0
			},
			wantMessage: "invalid bet limits",
		},
		{
			name: "missing options",
			mutate: func(config *Config) {
				config.Bet.OptionsMinor = nil
			},
			wantMessage: "at least one bet option",
		},
		{
			name: "option violates step",
			mutate: func(config *Config) {
				config.Bet.OptionsMinor = []int64{10, 155, 200}
				config.Bet.DefaultMinor = 100
			},
			wantMessage: "multiple of 10",
		},
		{
			name: "duplicate option",
			mutate: func(config *Config) {
				config.Bet.OptionsMinor = []int64{100, 200, 200, 500}
				config.Bet.DefaultMinor = 100
			},
			wantMessage: "duplicate bet option",
		},
		{
			name: "options not ascending",
			mutate: func(config *Config) {
				config.Bet.OptionsMinor = []int64{100, 500, 200}
				config.Bet.DefaultMinor = 100
			},
			wantMessage: "strictly ascending",
		},
		{
			name: "default absent",
			mutate: func(config *Config) {
				config.Bet.OptionsMinor = []int64{10, 20, 50}
				config.Bet.DefaultMinor = 1_000
			},
			wantMessage: "default bet must be a configured bet option",
		},
		{
			name: "tank payout absent",
			mutate: func(config *Config) {
				delete(config.Paytable, SymbolTank)
			},
			wantMessage: "missing positive paytable value for TANK",
		},
		{
			name: "feature reel contains only Rage",
			mutate: func(config *Config) {
				config.Reels[0] = []WeightedSymbol{{Value: SymbolSurge, Weight: 1}}
			},
			wantMessage: "non-Rage symbol",
		},
		{
			name: "feature spin cap exceeds protocol",
			mutate: func(config *Config) {
				config.Feature.MaxExpansionSpins = MaxFeatureSpins + 1
			},
			wantMessage: "invalid feature configuration",
		},
		{
			name: "Rage threshold exceeds protocol",
			mutate: func(config *Config) {
				config.Feature.RageLevelThresholds = []int{0, MaxRageCollected + 1}
			},
			wantMessage: "rage level thresholds",
		},
		{
			name: "Wild multiplier has no authored face",
			mutate: func(config *Config) {
				config.WildMultipliers = []WeightedInt{{Value: 4, Weight: 1}}
			},
			wantMessage: "unsupported wild multiplier 4",
		},
		{
			name: "Wild multiplier cannot be negative",
			mutate: func(config *Config) {
				config.WildMultipliers = []WeightedInt{{Value: -1, Weight: 1}}
			},
			wantMessage: "non-negative values",
		},
		{
			name: "base Vault multiplier has no authored face",
			mutate: func(config *Config) {
				config.VaultMultipliers = []WeightedInt{{Value: 11, Weight: 1}}
			},
			wantMessage: "unsupported base Vault multiplier 11",
		},
		{
			name: "King Spin Vault multiplier has no authored face",
			mutate: func(config *Config) {
				config.OverdriveMultipliers = []WeightedInt{{Value: 40, Weight: 1}}
			},
			wantMessage: "unsupported King Spin Vault multiplier 40",
		},
		{
			name: "wheel multiplier has no authored slice",
			mutate: func(config *Config) {
				config.Feature.Wheel = []WeightedWheel{{Kind: WheelInstant, Multiplier: 20, Weight: 1}}
			},
			wantMessage: "unsupported instant wheel multiplier 20",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := DemoConfig()
			test.mutate(&config)
			err := config.Validate()
			if err == nil {
				t.Fatal("invalid config unexpectedly validated")
			}
			if !strings.Contains(err.Error(), test.wantMessage) {
				t.Fatalf("Validate error = %q, want substring %q", err, test.wantMessage)
			}
		})
	}
}
