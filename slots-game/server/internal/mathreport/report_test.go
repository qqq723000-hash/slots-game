package mathreport

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"slots-game/server/internal/game"
)

type fixedSpinner struct {
	calls int
}

func (s *fixedSpinner) Spin(_ context.Context, input game.SpinInput) (game.SpinOutcome, error) {
	s.calls++
	if !input.Feature.Active() && s.calls == 1 {
		return game.SpinOutcome{
			Grid: game.Grid{{{}}, {{}}, {{}}}, TotalWinMinor: input.BetMinor,
			Events:      []game.Event{{Type: "free_spins.started"}},
			NextFeature: game.FeatureState{Mode: game.FeatureExpansion, Remaining: 1, Awarded: 1, BetMinor: input.BetMinor},
		}, nil
	}
	return game.SpinOutcome{
		Grid: game.Grid{{{}}, {{}}, {{}}}, TotalWinMinor: input.BetMinor * 2,
		NextFeature: game.EmptyFeatureState(),
	}, nil
}

func TestReportGroupsFeatureSpinsIntoPaidCycles(t *testing.T) {
	config := game.DemoConfig()
	spinner := &fixedSpinner{}
	report, err := Run(context.Background(), config, spinner, reportOptions(2, 100))
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	if report.PaidSpins != 2 || report.FreeSpins != 1 || report.TotalSpins != 3 || report.TotalWagerMinor != 200 || report.TotalPayoutMinor != 500 {
		t.Fatalf("unexpected report: %+v", report)
	}
	if report.RTP != "2.50000000" || report.Events["free_spins.started"] != 1 {
		t.Fatalf("unexpected ratios/events: %+v", report)
	}
	if !report.RTPAcceptance.Passed || report.RTPAcceptance.Minimum != "2.5" || report.RTPAcceptance.Maximum != "2.5" {
		t.Fatalf("unexpected RTP acceptance: %+v", report.RTPAcceptance)
	}
	if report.SchemaVersion != ReportSchemaVersion ||
		report.EngineRulesSchemaVersion != EngineRulesSchemaVersion ||
		report.RNG.Algorithm != "fixed-spinner-v1" || report.RNG.Seed != "fixture-seed-1" {
		t.Fatalf("missing reproducibility metadata: %+v", report)
	}
	digest, err := game.DefinitionDigest(config)
	if err != nil {
		t.Fatal(err)
	}
	if report.ConfigurationSHA256 != digest {
		t.Fatalf("configuration digest = %q, want %q", report.ConfigurationSHA256, digest)
	}
}

func TestReportIsDeterministicForDeterministicSpinner(t *testing.T) {
	config := game.DemoConfig()
	first, err := Run(context.Background(), config, &fixedSpinner{}, reportOptions(2, 100))
	if err != nil {
		t.Fatal(err)
	}
	second, err := Run(context.Background(), config, &fixedSpinner{}, reportOptions(2, 100))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("reports differ:\n%+v\n%+v", first, second)
	}
}

func TestReportRejectsObservedRTPOutsideConfiguredRange(t *testing.T) {
	options := reportOptions(2, 100)
	options.RTPMinimum = "0.94"
	options.RTPMaximum = "0.98"
	report, err := Run(context.Background(), game.DemoConfig(), &fixedSpinner{}, options)
	if err != nil {
		t.Fatal(err)
	}
	if report.RTP != "2.50000000" || report.RTPAcceptance.Passed {
		t.Fatalf("RTP acceptance = %+v at %s, want rejected", report.RTPAcceptance, report.RTP)
	}
}

func TestReportRequiresValidExplicitAcceptanceAndMetadata(t *testing.T) {
	tests := []struct {
		name        string
		mutate      func(*Options)
		wantMessage string
	}{
		{
			name: "missing range",
			mutate: func(options *Options) {
				options.RTPMinimum = ""
			},
			wantMessage: "RTP minimum and maximum",
		},
		{
			name: "reversed range",
			mutate: func(options *Options) {
				options.RTPMinimum, options.RTPMaximum = "0.99", "0.95"
			},
			wantMessage: "cannot exceed",
		},
		{
			name: "invalid algorithm",
			mutate: func(options *Options) {
				options.RNGAlgorithm = ""
			},
			wantMessage: "RNG algorithm",
		},
		{
			name: "missing seed",
			mutate: func(options *Options) {
				options.RNGSeed = ""
			},
			wantMessage: "RNG seed",
		},
		{
			name: "invalid rules schema",
			mutate: func(options *Options) {
				options.RulesSchemaVersion = "rules schema with spaces"
			},
			wantMessage: "rules schema",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := reportOptions(1, 100)
			test.mutate(&options)
			_, err := Run(context.Background(), game.DemoConfig(), &fixedSpinner{}, options)
			if err == nil || !strings.Contains(err.Error(), test.wantMessage) {
				t.Fatalf("Run error = %v, want substring %q", err, test.wantMessage)
			}
		})
	}
}

func TestTheoreticalMaximumIsExplicitConservativeLiabilityBound(t *testing.T) {
	report, err := Run(
		context.Background(), game.DemoConfig(), &fixedSpinner{}, reportOptions(1, 100),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := MaximumEvidence{
		SpinWinMinor: 10_240_000, SpinWinMultiplier: "102400.00000000",
		CycleWinMinor: 307_740_000, CycleWinMultiplier: "3077400.00000000",
	}
	if !reflect.DeepEqual(report.TheoreticalMaximumUpperBound, want) {
		t.Fatalf("theoretical maximum = %+v, want %+v", report.TheoreticalMaximumUpperBound, want)
	}
	if report.TheoreticalMaximumMethod != TheoreticalMaximumMethodVersion {
		t.Fatalf("theoretical maximum method = %q", report.TheoreticalMaximumMethod)
	}
	if report.ObservedMaximum.SpinWinMinor != 200 ||
		report.ObservedMaximum.CycleWinMinor != 300 ||
		report.ObservedMaximum.SpinWinMultiplier != "2.00000000" ||
		report.ObservedMaximum.CycleWinMultiplier != "3.00000000" {
		t.Fatalf("observed maximum = %+v", report.ObservedMaximum)
	}
}

func TestTheoreticalMaximumFailsClosedOnInt64ExposureOverflow(t *testing.T) {
	config := game.DemoConfig()
	// 将所有视觉倍数限制在随附资源目录内。极大的赔付表数值仍能证明，责任计算器会在报告
	// 无法表示的风险敞口前失效即关闭。
	config.Paytable[game.SymbolOrbit] = int64(^uint64(0) >> 1)
	options := reportOptions(1, config.Bet.MaxMinor)
	_, err := Run(context.Background(), config, &fixedSpinner{}, options)
	if err == nil || !strings.Contains(err.Error(), "theoretical maximum exceeds int64") {
		t.Fatalf("Run error = %v, want theoretical maximum overflow", err)
	}
}

func reportOptions(paidSpins, betMinor int64) Options {
	return Options{
		PaidSpins: paidSpins, BetMinor: betMinor,
		RNGAlgorithm: "fixed-spinner-v1", RNGSeed: "fixture-seed-1",
		RulesSchemaVersion: EngineRulesSchemaVersion,
		RTPMinimum:         "2.5", RTPMaximum: "2.5",
	}
}
