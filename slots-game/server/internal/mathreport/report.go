package mathreport

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strings"

	"slots-game/server/internal/game"
)

const (
	ReportSchemaVersion             = "rgs-math-report-v2"
	EngineRulesSchemaVersion        = game.EngineRulesVersion
	TheoreticalMaximumMethodVersion = "authoritative-win-cap-upper-bound-v2"
)

var metadataNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var decimalRatioPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]+)?$`)

type Options struct {
	PaidSpins int64
	BetMinor  int64

	// RNGAlgorithm 与 RNGSeed 标识确定性的工程随机流。生产熵绝不能传入或暴露在本报告中。
	// English: RNGAlgorithm and RNGSeed identify deterministic engineering random streams. Production entropy must
	// never be passed on or exposed in this report.
	RNGAlgorithm string
	RNGSeed      string

	// RulesSchemaVersion 在引擎算法或随机数到结果的映射发生变化时更新，
	// 即使数学配置本身没有变化也必须如此。
	// English: RulesSchemaVersion must be updated when the engine algorithm or the mapping of random numbers to
	// results changes, even if the math configuration itself does not change.
	RulesSchemaVersion string

	// RTPMinimum 与 RTPMaximum 是包含边界的十进制比率，例如 0.96 表示 96%。
	// 两者均为必填项，防止持续集成调用方意外运行无边界的“仅供参考”模拟并将其作为验收门禁。
	// English: RTPMinimum and RTPMaximum are decimal ratios with bounds, for example 0.96 means 96%. Both are required
	// to prevent continuous integration callers from accidentally running an unbounded "for reference only" mock and
	// using it as an acceptance gate.
	RTPMinimum string
	RTPMaximum string
}

type RNGIdentity struct {
	Algorithm string `json:"algorithm"`
	Seed      string `json:"seed"`
}

type RTPAcceptance struct {
	Minimum string `json:"minimum"`
	Maximum string `json:"maximum"`
	Passed  bool   `json:"passed"`
}

type MaximumEvidence struct {
	SpinWinMinor       int64  `json:"spinWinMinor"`
	SpinWinMultiplier  string `json:"spinWinMultiplier"`
	CycleWinMinor      int64  `json:"cycleWinMinor"`
	CycleWinMultiplier string `json:"cycleWinMultiplier"`
}

type Report struct {
	SchemaVersion            string      `json:"schemaVersion"`
	EngineRulesSchemaVersion string      `json:"engineRulesSchemaVersion"`
	GameID                   string      `json:"gameId"`
	DefinitionVersion        string      `json:"definitionVersion"`
	ConfigurationSHA256      string      `json:"configurationSha256"`
	RNG                      RNGIdentity `json:"rng"`

	PaidSpins             int64           `json:"paidSpins"`
	BetMinor              int64           `json:"betMinor"`
	FreeSpins             int64           `json:"freeSpins"`
	TotalSpins            int64           `json:"totalSpins"`
	WinningSpins          int64           `json:"winningSpins"`
	TotalWagerMinor       int64           `json:"totalWagerMinor"`
	TotalPayoutMinor      int64           `json:"totalPayoutMinor"`
	RTP                   string          `json:"rtp"`
	RTPAcceptance         RTPAcceptance   `json:"rtpAcceptance"`
	HitRate               string          `json:"hitRate"`
	CycleStdDevMultiplier string          `json:"cycleStdDevMultiplier"`
	ObservedMaximum       MaximumEvidence `json:"observedMaximum"`

	// 此字段刻意命名为上界。它依据所有可达的正权重最大值计算，但可能组合相互排斥的网格布局。
	// 它适合用于失效安全的责任检查，不适合声明经过认证的精确最高中奖概率。
	// This field is deliberately named as an upper bound. It uses every reachable positive-weight maximum but may combine mutually exclusive grid layouts.
	// It is suitable for fail-safe liability checks, not for claiming a certified exact maximum-win probability.
	TheoreticalMaximumUpperBound MaximumEvidence `json:"theoreticalMaximumUpperBound"`
	TheoreticalMaximumMethod     string          `json:"theoreticalMaximumMethod"`

	Events     map[string]int64 `json:"events"`
	Rows       map[int]int64    `json:"rows"`
	Disclaimer string           `json:"disclaimer"`
}

func Run(ctx context.Context, config game.Config, spinner game.Spinner, options Options) (Report, error) {
	if options.PaidSpins <= 0 || options.PaidSpins > 1_000_000_000 {
		return Report{}, errors.New("paid spins must be between 1 and 1000000000")
	}
	if err := config.ValidateBet(options.BetMinor); err != nil {
		return Report{}, fmt.Errorf("simulation bet: %w", err)
	}
	if spinner == nil {
		return Report{}, errors.New("spinner is required")
	}
	if !metadataNamePattern.MatchString(options.RNGAlgorithm) {
		return Report{}, errors.New("RNG algorithm identity is required and must be a stable identifier")
	}
	if options.RNGSeed == "" || len(options.RNGSeed) > 128 {
		return Report{}, errors.New("RNG seed identity is required and must not exceed 128 bytes")
	}
	if !metadataNamePattern.MatchString(options.RulesSchemaVersion) {
		return Report{}, errors.New("engine rules schema version is required and must be a stable identifier")
	}
	if options.RulesSchemaVersion != config.EngineRulesVersion {
		return Report{}, errors.New("engine rules schema version must match the signed game definition")
	}
	minimumRTP, maximumRTP, acceptance, err := parseAcceptance(options.RTPMinimum, options.RTPMaximum)
	if err != nil {
		return Report{}, err
	}
	digest, err := game.DefinitionDigest(config)
	if err != nil {
		return Report{}, err
	}
	theoreticalMaximum, err := theoreticalMaximumUpperBound(config, options.BetMinor)
	if err != nil {
		return Report{}, fmt.Errorf("calculate theoretical maximum: %w", err)
	}
	report := Report{
		SchemaVersion:            ReportSchemaVersion,
		EngineRulesSchemaVersion: config.EngineRulesVersion,
		GameID:                   config.GameID, DefinitionVersion: config.DefinitionVersion,
		ConfigurationSHA256: digest,
		RNG:                 RNGIdentity{Algorithm: options.RNGAlgorithm, Seed: options.RNGSeed},
		PaidSpins:           options.PaidSpins, BetMinor: options.BetMinor, RTPAcceptance: acceptance,
		TheoreticalMaximumUpperBound: theoreticalMaximum,
		TheoreticalMaximumMethod:     TheoreticalMaximumMethodVersion,
		Events:                       make(map[string]int64), Rows: make(map[int]int64),
		Disclaimer: "Deterministic Monte Carlo engineering evidence; not a certification report. The theoretical maximum is a conservative liability upper bound constrained by the authoritative whole-game win cap.",
	}
	var cycleMean, cycleM2 float64
	state := game.EmptyFeatureState()
	for paid := int64(0); paid < options.PaidSpins; paid++ {
		cycleWin := int64(0)
		for {
			if err := ctx.Err(); err != nil {
				return Report{}, err
			}
			free := state.Active()
			outcome, err := spinner.Spin(ctx, game.SpinInput{BetMinor: options.BetMinor, Feature: state})
			if err != nil {
				return Report{}, fmt.Errorf("simulation spin %d: %w", report.TotalSpins+1, err)
			}
			if outcome.TotalWinMinor < 0 {
				return Report{}, errors.New("simulation spinner returned a negative payout")
			}
			if len(outcome.Grid) != 3 || len(outcome.Grid[0]) == 0 {
				return Report{}, errors.New("simulation spinner returned an invalid grid")
			}
			report.TotalSpins++
			if free {
				report.FreeSpins++
			}
			if outcome.TotalWinMinor > 0 {
				report.WinningSpins++
			}
			if outcome.TotalWinMinor > report.ObservedMaximum.SpinWinMinor {
				report.ObservedMaximum.SpinWinMinor = outcome.TotalWinMinor
			}
			if cycleWin > math.MaxInt64-outcome.TotalWinMinor || report.TotalPayoutMinor > math.MaxInt64-outcome.TotalWinMinor {
				return Report{}, errors.New("simulation payout overflow")
			}
			cycleWin += outcome.TotalWinMinor
			report.TotalPayoutMinor += outcome.TotalWinMinor
			rows := len(outcome.Grid[0])
			report.Rows[rows]++
			for _, event := range outcome.Events {
				report.Events[event.Type]++
			}
			state = outcome.NextFeature
			if !state.Active() {
				break
			}
			if report.TotalSpins > options.PaidSpins*64 {
				return Report{}, errors.New("simulation exceeded the feature spin safety bound")
			}
		}
		if cycleWin > report.ObservedMaximum.CycleWinMinor {
			report.ObservedMaximum.CycleWinMinor = cycleWin
		}
		cycleMultiplier := float64(cycleWin) / float64(options.BetMinor)
		delta := cycleMultiplier - cycleMean
		cycleMean += delta / float64(paid+1)
		cycleM2 += delta * (cycleMultiplier - cycleMean)
	}
	if options.BetMinor > math.MaxInt64/options.PaidSpins {
		return Report{}, errors.New("simulation wager overflow")
	}
	report.TotalWagerMinor = options.BetMinor * options.PaidSpins
	report.RTP = ratio(report.TotalPayoutMinor, report.TotalWagerMinor, 8)
	report.HitRate = ratio(report.WinningSpins, report.TotalSpins, 8)
	report.ObservedMaximum.SpinWinMultiplier = ratio(report.ObservedMaximum.SpinWinMinor, options.BetMinor, 8)
	report.ObservedMaximum.CycleWinMultiplier = ratio(report.ObservedMaximum.CycleWinMinor, options.BetMinor, 8)
	observedRTP := new(big.Rat).SetFrac(big.NewInt(report.TotalPayoutMinor), big.NewInt(report.TotalWagerMinor))
	report.RTPAcceptance.Passed = observedRTP.Cmp(minimumRTP) >= 0 && observedRTP.Cmp(maximumRTP) <= 0
	variance := cycleM2 / float64(options.PaidSpins)
	report.CycleStdDevMultiplier = fmt.Sprintf("%.8f", math.Sqrt(math.Max(0, variance)))
	return report, nil
}

func parseAcceptance(minimum, maximum string) (*big.Rat, *big.Rat, RTPAcceptance, error) {
	minimum = strings.TrimSpace(minimum)
	maximum = strings.TrimSpace(maximum)
	if !decimalRatioPattern.MatchString(minimum) || !decimalRatioPattern.MatchString(maximum) {
		return nil, nil, RTPAcceptance{}, errors.New("RTP minimum and maximum are required non-negative decimal ratios")
	}
	minimumRTP, ok := new(big.Rat).SetString(minimum)
	if !ok {
		return nil, nil, RTPAcceptance{}, errors.New("invalid RTP minimum")
	}
	maximumRTP, ok := new(big.Rat).SetString(maximum)
	if !ok {
		return nil, nil, RTPAcceptance{}, errors.New("invalid RTP maximum")
	}
	if minimumRTP.Cmp(maximumRTP) > 0 {
		return nil, nil, RTPAcceptance{}, errors.New("RTP minimum cannot exceed maximum")
	}
	return minimumRTP, maximumRTP, RTPAcceptance{Minimum: minimum, Maximum: maximum}, nil
}

func theoreticalMaximumUpperBound(config game.Config, betMinor int64) (MaximumEvidence, error) {
	capMinor, err := checkedMultiply(betMinor, config.MaxWinMultiplier)
	if err != nil {
		return MaximumEvidence{}, err
	}
	baseMaximum, err := fixedSpinMaximum(config, betMinor, 3, false)
	if err != nil {
		return MaximumEvidence{}, err
	}
	spinMaximum := baseMaximum
	cycleMaximum := baseMaximum
	if !reelContains(config.Reels[0], game.SymbolSurge) &&
		!reelContains(config.Reels[1], game.SymbolSurge) &&
		!reelContains(config.Reels[2], game.SymbolSurge) {
		return maximumEvidence(minInt64(spinMaximum, capMinor), minInt64(cycleMaximum, capMinor), betMinor), nil
	}

	for _, wheel := range config.Feature.Wheel {
		switch wheel.Kind {
		case game.WheelInstant:
			instant, err := checkedMultiply(betMinor, wheel.Multiplier)
			if err != nil {
				return MaximumEvidence{}, err
			}
			instantSpin, err := checkedAdd(baseMaximum, instant)
			if err != nil {
				return MaximumEvidence{}, err
			}
			spinMaximum = maxInt64(spinMaximum, instantSpin)
			cycleMaximum = maxInt64(cycleMaximum, instantSpin)
		case game.WheelExpansion:
			expansionSpin, err := fixedSpinMaximum(config, betMinor, 8, false)
			if err != nil {
				return MaximumEvidence{}, err
			}
			spins := config.Feature.InitialFreeSpins
			if config.Feature.VaultFreeSpinWeight > 0 && reelContains(config.Reels[1], game.SymbolVault) {
				spins = config.Feature.MaxExpansionSpins
			}
			featureMaximum, err := checkedMultiply(expansionSpin, int64(spins))
			if err != nil {
				return MaximumEvidence{}, err
			}
			featureCycle, err := checkedAdd(baseMaximum, featureMaximum)
			if err != nil {
				return MaximumEvidence{}, err
			}
			spinMaximum = maxInt64(spinMaximum, expansionSpin)
			cycleMaximum = maxInt64(cycleMaximum, featureCycle)
		case game.WheelOverdrive:
			overdriveSpin, err := fixedSpinMaximum(config, betMinor, 3, true)
			if err != nil {
				return MaximumEvidence{}, err
			}
			featureMaximum, err := checkedMultiply(overdriveSpin, int64(config.Feature.InitialFreeSpins))
			if err != nil {
				return MaximumEvidence{}, err
			}
			featureCycle, err := checkedAdd(baseMaximum, featureMaximum)
			if err != nil {
				return MaximumEvidence{}, err
			}
			spinMaximum = maxInt64(spinMaximum, overdriveSpin)
			cycleMaximum = maxInt64(cycleMaximum, featureCycle)
		}
	}
	return maximumEvidence(minInt64(spinMaximum, capMinor), minInt64(cycleMaximum, capMinor), betMinor), nil
}

func fixedSpinMaximum(config game.Config, betMinor int64, rows int, overdrive bool) (int64, error) {
	maxPairPay := int64(0)
	maxTriplePay := int64(0)
	for _, symbol := range game.PayingSymbols {
		payout := config.Paytable[symbol]
		if reelContains(config.Reels[0], symbol) && reelContains(config.Reels[2], symbol) {
			maxPairPay = maxInt64(maxPairPay, payout)
			if reelContains(config.Reels[1], symbol) {
				maxTriplePay = maxInt64(maxTriplePay, payout)
			}
		}
	}
	rowCount := int64(rows)
	pathsPerMiddleCell, err := checkedMultiply(rowCount, rowCount)
	if err != nil {
		return 0, err
	}
	bestMiddleCell := int64(0)
	if maxTriplePay > 0 {
		regular, err := checkedScaleAwardCeil(
			config.Bet.PayUnitMinor,
			pathsPerMiddleCell,
			maxTriplePay,
			betMinor,
		)
		if err != nil {
			return 0, err
		}
		bestMiddleCell = maxInt64(bestMiddleCell, regular)
	}
	if reelContains(config.Reels[1], game.SymbolWild) && maxPairPay > 0 {
		maxWild := maximumWeightedInt(config.WildMultipliers)
		wild, err := checkedScaleAwardCeil(
			config.Bet.PayUnitMinor,
			pathsPerMiddleCell,
			maxPairPay,
			betMinor,
			maxWild,
		)
		if err != nil {
			return 0, err
		}
		bestMiddleCell = maxInt64(bestMiddleCell, wild)
	}
	if reelContains(config.Reels[1], game.SymbolVault) {
		maxVault := maximumWeightedInt(config.VaultMultipliers)
		if overdrive {
			maxVault = maxInt64(maxVault, maximumWeightedInt(config.OverdriveMultipliers))
			if config.Feature.OverdriveDoubleChanceBP > 0 {
				for _, multiplier := range []int64{10, 30, 75, 250} {
					if weightedIntContains(config.OverdriveMultipliers, multiplier) {
						doubled, err := checkedMultiply(multiplier, 2)
						if err != nil {
							return 0, err
						}
						maxVault = maxInt64(maxVault, doubled)
					}
				}
			}
		}
		vault, err := checkedMultiply(betMinor, maxVault)
		if err != nil {
			return 0, err
		}
		bestMiddleCell = maxInt64(bestMiddleCell, vault)
	}
	return checkedMultiply(rowCount, bestMiddleCell)
}

func maximumEvidence(spinWinMinor, cycleWinMinor, betMinor int64) MaximumEvidence {
	return MaximumEvidence{
		SpinWinMinor: spinWinMinor, SpinWinMultiplier: ratio(spinWinMinor, betMinor, 8),
		CycleWinMinor: cycleWinMinor, CycleWinMultiplier: ratio(cycleWinMinor, betMinor, 8),
	}
}

func maximumWeightedInt(items []game.WeightedInt) int64 {
	maximum := int64(0)
	for _, item := range items {
		maximum = maxInt64(maximum, item.Value)
	}
	return maximum
}

func weightedIntContains(items []game.WeightedInt, value int64) bool {
	for _, item := range items {
		if item.Value == value && item.Weight > 0 {
			return true
		}
	}
	return false
}

func reelContains(reel []game.WeightedSymbol, symbol game.Symbol) bool {
	for _, item := range reel {
		if item.Value == symbol && item.Weight > 0 {
			return true
		}
	}
	return false
}

func checkedAdd(values ...int64) (int64, error) {
	result := int64(0)
	for _, value := range values {
		if value < 0 || result > math.MaxInt64-value {
			return 0, errors.New("theoretical maximum exceeds int64")
		}
		result += value
	}
	return result, nil
}

func checkedMultiply(values ...int64) (int64, error) {
	result := int64(1)
	for _, value := range values {
		if value < 0 || (result != 0 && value > math.MaxInt64/result) {
			return 0, errors.New("theoretical maximum exceeds int64")
		}
		result *= value
	}
	return result, nil
}

// 责任上界必须向上取整不足一个最小货币单位的风险敞口，即使运行时展示会将单项奖励取整到最近值。
// The liability upper bound must round sub-minor-unit exposure upward even when runtime presentation rounds each award to the nearest value.
func checkedScaleAwardCeil(payUnitMinor int64, factors ...int64) (int64, error) {
	if payUnitMinor <= 0 {
		return 0, errors.New("theoretical maximum requires a positive pay unit")
	}
	numerator, err := checkedMultiply(factors...)
	if err != nil {
		return 0, err
	}
	result := numerator / payUnitMinor
	if numerator%payUnitMinor != 0 {
		return checkedAdd(result, 1)
	}
	return result, nil
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func ratio(numerator, denominator int64, precision int) string {
	if denominator == 0 {
		return "0"
	}
	value := new(big.Rat).SetFrac(big.NewInt(numerator), big.NewInt(denominator))
	return value.FloatString(precision)
}
