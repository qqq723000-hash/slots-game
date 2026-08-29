package game

import (
	"errors"
	"fmt"
	"math"
)

type WeightedSymbol struct {
	Value  Symbol `json:"symbol"`
	Weight int    `json:"weight"`
}

type WeightedInt struct {
	Value  int64 `json:"value"`
	Weight int   `json:"weight"`
}

type WheelKind string

const (
	WheelInstant   WheelKind = "INSTANT"
	WheelExpansion WheelKind = "EXPANSION"
	WheelOverdrive WheelKind = "OVERDRIVE"
)

type WeightedWheel struct {
	Kind       WheelKind `json:"kind"`
	Multiplier int64     `json:"multiplier,omitempty"`
	Weight     int       `json:"weight"`
}

type BetConfig struct {
	MinMinor     int64   `json:"minMinor"`
	MaxMinor     int64   `json:"maxMinor"`
	StepMinor    int64   `json:"stepMinor"`
	PayUnitMinor int64   `json:"payUnitMinor"`
	DefaultMinor int64   `json:"defaultMinor"`
	OptionsMinor []int64 `json:"optionsMinor"`
}

type FeatureConfig struct {
	SurgeOneChanceBP  int `json:"surgeOneChanceBP"`
	SurgeTwoChanceBP  int `json:"surgeTwoChanceBP"`
	InitialFreeSpins  int `json:"initialFreeSpins"`
	MaxExpansionSpins int `json:"maxExpansionSpins"`
	// VaultUnlockChanceBP 会在基础游戏或金刚任务结果中为全部锁定保险库统一判定一次。
	// 王者旋转始终解锁全部保险库。
	// English: VaultUnlockChanceBP will be determined once for all locked vaults in the base game or King Kong mission
	// results. King Spin always unlocks the entire vault.
	VaultUnlockChanceBP int `json:"vaultUnlockChanceBP"`
	// VaultFreeSpinWeight 仅在金刚任务期间向普通保险库奖励表加入免费旋转奖励。
	// English: VaultFreeSpinWeight adds a free spins bonus to the normal vault reward table only during King Kong
	// missions.
	VaultFreeSpinWeight      int             `json:"vaultFreeSpinWeight"`
	KingSpinUpgradeChanceBP  int             `json:"kingSpinUpgradeChanceBP"`
	KingSpinMaxUpgradeRounds int             `json:"kingSpinMaxUpgradeRounds"`
	OverdriveDoubleChanceBP  int             `json:"overdriveDoubleChanceBP"`
	ExpansionRows            []WeightedInt   `json:"expansionRows"`
	RageLevelThresholds      []int           `json:"rageLevelThresholds"`
	Wheel                    []WeightedWheel `json:"wheel"`
}

type Config struct {
	GameID             string `json:"gameId"`
	DefinitionVersion  string `json:"definitionVersion"`
	EngineRulesVersion string `json:"engineRulesVersion"`
	// MaxWinMultiplier 是以触发时总投注为基准表示的权威整场最高赢取上限。
	// 一次基础旋转及其触发的所有免费旋转共享同一预算；所有结算运算均使用整数最小货币单位。
	// English: MaxWinMultiplier is the authoritative maximum winning limit for the entire game based on the total bet
	// at the time of triggering. A base spin and all free spins it triggers share the same budget; all settlement
	// calculations use integer minimum currency units.
	MaxWinMultiplier     int64               `json:"maxWinMultiplier"`
	Bet                  BetConfig           `json:"bet"`
	Reels                [3][]WeightedSymbol `json:"reels"`
	Paytable             map[Symbol]int64    `json:"paytable"`
	WildMultipliers      []WeightedInt       `json:"wildMultipliers"`
	VaultMultipliers     []WeightedInt       `json:"vaultMultipliers"`
	OverdriveMultipliers []WeightedInt       `json:"overdriveMultipliers"`
	Feature              FeatureConfig       `json:"feature"`
}

// DemoConfig 是为净室演示实现原创且刻意未经认证的数学配置，并非复制自任何商业游戏。
// English: DemoConfig is an original and intentionally uncertified mathematical configuration implemented for
// clean room demonstrations and is not copied from any commercial game.
func DemoConfig() Config {
	return Config{
		GameID:             "iron-colossus-demo",
		DefinitionVersion:  "demo-2026-07-29.5",
		EngineRulesVersion: EngineRulesVersion,
		MaxWinMultiplier:   PrimalMaxWinMultiplier,
		Bet: BetConfig{
			MinMinor:     10,
			MaxMinor:     10_000,
			StepMinor:    10,
			PayUnitMinor: 100,
			DefaultMinor: 100,
			OptionsMinor: []int64{10, 20, 50, 100, 200, 300, 400, 600, 1_000, 2_000, 5_000, 10_000},
		},
		// 每列权重总和为 100。TANK 是稀有高价值符号，其 6/5/6 权重由
		// CIRCUIT 的 9/9/10 权重平衡，而不是通过增加总停靠权重实现。
		// English: Each column weight sums to 100. TANK is a rare high-value symbol whose 6/5/6 weight is balanced by
		// CIRCUIT's 9/9/10 weight, rather than by increasing the total dock weight.
		Reels: [3][]WeightedSymbol{
			{
				{SymbolOrbit, 22}, {SymbolPrism, 21}, {SymbolPulse, 19},
				{SymbolNova, 17}, {SymbolCircuit, 9}, {SymbolTank, 6}, {SymbolSurge, 6},
			},
			{
				{SymbolOrbit, 19}, {SymbolPrism, 18}, {SymbolPulse, 17},
				{SymbolNova, 15}, {SymbolCircuit, 9}, {SymbolTank, 5}, {SymbolWild, 7},
				{SymbolVault, 5}, {SymbolSurge, 5},
			},
			{
				{SymbolOrbit, 22}, {SymbolPrism, 20}, {SymbolPulse, 19},
				{SymbolNova, 17}, {SymbolCircuit, 10}, {SymbolTank, 6}, {SymbolSurge, 6},
			},
		},
		Paytable: map[Symbol]int64{
			// 已采集资源中每条具体连线相对于 100 最小货币单位参考投注的赔付为：
			// Q 为 0.1 倍、K 为 0.3 倍、头盔为 0.8 倍、无线电为 1 倍、
			// 坦克为 1.5 倍、喷气机为 2 倍。
			// In the captured resources, each concrete way pays against a 100-minor-unit reference bet as follows:
			// Q pays 0.1x, K 0.3x, helmet 0.8x, radio 1x, tank 1.5x, and jet 2x.
			SymbolPrism: 10, SymbolOrbit: 30, SymbolPulse: 80,
			SymbolNova: 100, SymbolTank: 150, SymbolCircuit: 200,
		},
		WildMultipliers: []WeightedInt{
			// 已采集资源区分普通 WILD（值为 0，实际按 1 倍计算）与明确的 X1 图案。
			// 这些权重仍为净室实现数值。
			// English: Collected resources differentiate between normal WILD (value 0, actually calculated as 1x) and explicit
			// X1 patterns. These weights are still cleanroom realization values.
			{0, 30}, {1, 25}, {2, 24}, {3, 10}, {5, 6}, {10, 3}, {25, 1}, {50, 1}, {100, 1},
		},
		VaultMultipliers: []WeightedInt{
			{1, 22}, {2, 18}, {3, 15}, {4, 12}, {5, 9}, {6, 7}, {7, 5},
			{8, 4}, {9, 3}, {10, 3}, {30, 1}, {75, 1}, {250, 1}, {1000, 1},
		},
		OverdriveMultipliers: []WeightedInt{
			{2, 18}, {3, 16}, {4, 14}, {5, 12}, {6, 10}, {7, 8}, {8, 7},
			{9, 6}, {10, 5}, {20, 3}, {30, 4}, {60, 2}, {75, 3},
			{150, 2}, {250, 2}, {500, 1}, {1000, 1},
		},
		Feature: FeatureConfig{
			SurgeOneChanceBP:  800,
			SurgeTwoChanceBP:  2_400,
			InitialFreeSpins:  8,
			MaxExpansionSpins: 30,
			// 采集结果证明保险库组并非必然解锁，但十四次旋转不足以还原商业概率。
			// 在已审批数学定义提供真实数值前，保留一个明显非必然的净室实现数值。
			// Captured outcomes prove that a Vault group is not guaranteed to unlock, but fourteen spins are insufficient to recover commercial probabilities.
			// Keep an explicitly non-guaranteed clean-room value until an approved mathematics definition supplies the real value.
			VaultUnlockChanceBP:      2_500,
			VaultFreeSpinWeight:      8,
			KingSpinUpgradeChanceBP:  2_800,
			KingSpinMaxUpgradeRounds: 3,
			OverdriveDoubleChanceBP:  1_500,
			ExpansionRows: []WeightedInt{
				{3, 1}, {4, 1}, {5, 1}, {6, 1}, {7, 1}, {8, 1},
			},
			// 已采集到累计 12 时进入第 2 级。客户端包含六个已制作的视觉等级；
			// 更高阈值仍是明确的净室实现占位值，不代表商业数学规则。
			// The captured client enters level two at a cumulative value of 12 and contains six authored visual levels;
			// higher thresholds remain explicit clean-room placeholders and do not represent commercial mathematics rules.
			RageLevelThresholds: []int{0, 12, 24, 36, 48, 60},
			Wheel: []WeightedWheel{
				{Kind: WheelInstant, Multiplier: 10, Weight: 35},
				{Kind: WheelInstant, Multiplier: 30, Weight: 25},
				{Kind: WheelInstant, Multiplier: 75, Weight: 15},
				{Kind: WheelInstant, Multiplier: 250, Weight: 8},
				{Kind: WheelInstant, Multiplier: 1000, Weight: 2},
				{Kind: WheelExpansion, Weight: 9},
				{Kind: WheelOverdrive, Weight: 6},
			},
		},
	}
}

func (c Config) Validate() error {
	if !gameIdentifierPattern.MatchString(c.GameID) {
		return errors.New("invalid game id")
	}
	if !definitionVersionPattern.MatchString(c.DefinitionVersion) {
		return errors.New("invalid game definition version")
	}
	if c.EngineRulesVersion != EngineRulesVersion {
		return errors.New("game definition engine rules version does not match this binary")
	}
	if c.Bet.MinMinor <= 0 || c.Bet.MaxMinor < c.Bet.MinMinor ||
		c.Bet.StepMinor <= 0 || c.Bet.PayUnitMinor <= 0 {
		return errors.New("invalid bet limits")
	}
	if c.MaxWinMultiplier != PrimalMaxWinMultiplier {
		return fmt.Errorf("max win multiplier must equal %d for engine rules %s", PrimalMaxWinMultiplier, EngineRulesVersion)
	}
	if c.Bet.MaxMinor > math.MaxInt64/c.MaxWinMultiplier {
		return errors.New("invalid max win multiplier")
	}
	if len(c.Bet.OptionsMinor) == 0 {
		return errors.New("at least one bet option is required")
	}
	seenBetOptions := make(map[int64]struct{}, len(c.Bet.OptionsMinor))
	for index, option := range c.Bet.OptionsMinor {
		if err := c.validateBetBounds(option); err != nil {
			return fmt.Errorf("bet option %d: %w", option, err)
		}
		if _, exists := seenBetOptions[option]; exists {
			return fmt.Errorf("duplicate bet option %d", option)
		}
		if index > 0 && option <= c.Bet.OptionsMinor[index-1] {
			return errors.New("bet options must be in strictly ascending order")
		}
		seenBetOptions[option] = struct{}{}
	}
	if _, exists := seenBetOptions[c.Bet.DefaultMinor]; !exists {
		return errors.New("default bet must be a configured bet option")
	}
	for i, reel := range c.Reels {
		if len(reel) == 0 {
			return fmt.Errorf("reel %d has no symbols", i)
		}
		seenSymbols := make(map[Symbol]struct{}, len(reel))
		totalWeight := 0
		nonSurgeWeight := 0
		for _, item := range reel {
			if item.Weight <= 0 || !IsKnownSymbol(item.Value) {
				return fmt.Errorf("reel %d has invalid weighted symbol", i)
			}
			if _, duplicate := seenSymbols[item.Value]; duplicate {
				return fmt.Errorf("reel %d has duplicate symbol %s", i, item.Value)
			}
			seenSymbols[item.Value] = struct{}{}
			if item.Weight > math.MaxInt-totalWeight {
				return fmt.Errorf("reel %d weights overflow", i)
			}
			totalWeight += item.Weight
			if item.Value != SymbolSurge {
				nonSurgeWeight += item.Weight
			}
			if i != 1 && (item.Value == SymbolWild || item.Value == SymbolVault) {
				return fmt.Errorf("%s may only appear on middle reel", item.Value)
			}
		}
		if nonSurgeWeight == 0 {
			return fmt.Errorf("reel %d must contain a non-Rage symbol for Free Spins", i)
		}
	}
	for _, symbol := range PayingSymbols {
		if c.Paytable[symbol] <= 0 {
			return fmt.Errorf("missing positive paytable value for %s", symbol)
		}
	}
	if len(c.Paytable) != len(PayingSymbols) {
		return errors.New("paytable must contain exactly the paying symbols")
	}
	if err := validateWildMultipliers(c.WildMultipliers); err != nil {
		return err
	}
	for _, item := range c.WildMultipliers {
		if !isSupportedWildMultiplier(item.Value) {
			return fmt.Errorf("unsupported wild multiplier %d", item.Value)
		}
	}
	if err := validateWeightedInts("vault multipliers", c.VaultMultipliers); err != nil {
		return err
	}
	for _, item := range c.VaultMultipliers {
		if !isSupportedBaseVaultMultiplier(item.Value) {
			return fmt.Errorf("unsupported base Vault multiplier %d", item.Value)
		}
	}
	if err := validateWeightedInts("overdrive multipliers", c.OverdriveMultipliers); err != nil {
		return err
	}
	for _, item := range c.OverdriveMultipliers {
		if !isSupportedKingVaultMultiplier(item.Value) {
			return fmt.Errorf("unsupported King Spin Vault multiplier %d", item.Value)
		}
	}
	if len(c.Feature.Wheel) == 0 || c.Feature.InitialFreeSpins != 8 || c.Feature.MaxExpansionSpins < c.Feature.InitialFreeSpins ||
		c.Feature.MaxExpansionSpins > MaxFeatureSpins ||
		c.Feature.VaultFreeSpinWeight < 0 || c.Feature.KingSpinMaxUpgradeRounds < 0 ||
		c.Feature.KingSpinMaxUpgradeRounds > 16 {
		return errors.New("invalid feature configuration")
	}
	for _, chance := range []int{
		c.Feature.SurgeOneChanceBP,
		c.Feature.SurgeTwoChanceBP,
		c.Feature.VaultUnlockChanceBP,
		c.Feature.KingSpinUpgradeChanceBP,
		c.Feature.OverdriveDoubleChanceBP,
	} {
		if chance < 0 || chance > 10_000 {
			return errors.New("feature chance must be in [0,10000]")
		}
	}
	if err := validateWeightedInts("expansion rows", c.Feature.ExpansionRows); err != nil {
		return err
	}
	seenRows := make(map[int64]struct{}, len(c.Feature.ExpansionRows))
	for _, row := range c.Feature.ExpansionRows {
		if row.Value < 3 || row.Value > 8 {
			return errors.New("expansion row values must be in [3,8]")
		}
		seenRows[row.Value] = struct{}{}
	}
	if len(seenRows) != 6 {
		return errors.New("expansion rows must define every height from 3 through 8")
	}
	if len(c.Feature.RageLevelThresholds) == 0 || len(c.Feature.RageLevelThresholds) > MaxRageCollected ||
		c.Feature.RageLevelThresholds[0] != 0 {
		return errors.New("rage level thresholds must start at zero")
	}
	for index, threshold := range c.Feature.RageLevelThresholds {
		if threshold < 0 || threshold > MaxRageCollected ||
			(index > 0 && threshold <= c.Feature.RageLevelThresholds[index-1]) {
			return errors.New("rage level thresholds must be non-negative and strictly ascending")
		}
	}
	seenWheel := make(map[string]struct{}, len(c.Feature.Wheel))
	totalWheelWeight := 0
	for _, item := range c.Feature.Wheel {
		if item.Weight <= 0 {
			return errors.New("wheel weight must be positive")
		}
		if item.Weight > math.MaxInt-totalWheelWeight {
			return errors.New("wheel weights overflow")
		}
		totalWheelWeight += item.Weight
		if item.Kind != WheelInstant && item.Kind != WheelExpansion && item.Kind != WheelOverdrive {
			return fmt.Errorf("unknown wheel kind %q", item.Kind)
		}
		if item.Kind == WheelInstant && item.Multiplier <= 0 {
			return errors.New("instant wheel multiplier must be positive")
		}
		if item.Kind == WheelInstant && !isSupportedWheelMultiplier(item.Multiplier) {
			return fmt.Errorf("unsupported instant wheel multiplier %d", item.Multiplier)
		}
		if item.Kind != WheelInstant && item.Multiplier != 0 {
			return errors.New("feature wheel outcomes cannot have a multiplier")
		}
		key := fmt.Sprintf("%s:%d", item.Kind, item.Multiplier)
		if _, duplicate := seenWheel[key]; duplicate {
			return fmt.Errorf("duplicate wheel outcome %s", key)
		}
		seenWheel[key] = struct{}{}
	}
	if err := c.validateSpinArithmeticBounds(); err != nil {
		return err
	}
	return nil
}

// validateSpinArithmeticBounds 在定义加载时证明，所有支持的八行 Ways 中间值
// 以及应用上限前的完整旋转总额均不会超出 int64。
// 汇总边界会特意合并 Ways 最大结果、八个中轴 Vault 奖励和一次即时 Wheel 奖励。
// 这些最大值不可能同时出现在同一实际模式中，但已签名定义绝不能把溢出发现
// 推迟到罕见 RNG 路径或未来功能实现变更时。
// English: validateSpinArithmeticBounds proves at definition load time that all supported eight-line Ways
// intermediate values and the full spin total before applying a cap will not exceed int64. The rollup boundary
// intentionally incorporates Ways maximum results, eight Axis Vault rewards, and one Instant Wheel reward. These
// maximums are unlikely to occur simultaneously in the same actual schema, but signed definitions must not defer
// discovery of overflows to rare RNG paths or future feature implementation changes.
func (c Config) validateSpinArithmeticBounds() error {
	maxWildMultiplier := int64(1)
	for _, item := range c.WildMultipliers {
		value := item.Value
		if value == 0 {
			value = 1
		}
		if value > maxWildMultiplier {
			maxWildMultiplier = value
		}
	}
	const maximumWaysPerSymbol = int64(8 * 8 * 8)
	var rawTotal, scaledTotal int64
	for _, symbol := range PayingSymbols {
		raw, err := safeMul(c.Paytable[symbol], maxWildMultiplier)
		if err != nil {
			return errors.New("Ways liability overflows int64 before the win cap")
		}
		raw, err = safeMul(raw, maximumWaysPerSymbol)
		if err != nil {
			return errors.New("Ways liability overflows int64 before the win cap")
		}
		rawTotal, err = safeAdd(rawTotal, raw)
		if err != nil {
			return errors.New("Ways liability overflows int64 before the win cap")
		}
		scaled, err := scaleWaysAward(raw, c.Bet.MaxMinor, c.Bet.PayUnitMinor)
		if err != nil {
			return errors.New("scaled Ways liability overflows int64 before the win cap")
		}
		scaledTotal, err = safeAdd(scaledTotal, scaled)
		if err != nil {
			return errors.New("scaled Ways liability overflows int64 before the win cap")
		}
	}
	if rawTotal <= 0 || scaledTotal <= 0 {
		return errors.New("invalid Ways liability bound")
	}

	maxVaultMultiplier := int64(0)
	for _, item := range c.VaultMultipliers {
		if item.Value > maxVaultMultiplier {
			maxVaultMultiplier = item.Value
		}
	}
	for _, item := range c.OverdriveMultipliers {
		value := item.Value
		if isBaseJackpotMultiplier(value) {
			doubled, err := safeMul(value, 2)
			if err != nil {
				return errors.New("Vault liability overflows int64 before the win cap")
			}
			value = doubled
		}
		if value > maxVaultMultiplier {
			maxVaultMultiplier = value
		}
	}
	const maximumVaultsPerSpin = int64(8)
	vaultLiability, err := safeMul(c.Bet.MaxMinor, maxVaultMultiplier)
	if err == nil {
		vaultLiability, err = safeMul(vaultLiability, maximumVaultsPerSpin)
	}
	if err != nil {
		return errors.New("Vault liability overflows int64 before the win cap")
	}

	maxWheelMultiplier := int64(0)
	for _, item := range c.Feature.Wheel {
		if item.Kind == WheelInstant && item.Multiplier > maxWheelMultiplier {
			maxWheelMultiplier = item.Multiplier
		}
	}
	wheelLiability, err := safeMul(c.Bet.MaxMinor, maxWheelMultiplier)
	if err != nil {
		return errors.New("Wheel liability overflows int64 before the win cap")
	}
	combined, err := safeAdd(scaledTotal, vaultLiability)
	if err == nil {
		_, err = safeAdd(combined, wheelLiability)
	}
	if err != nil {
		return errors.New("combined raw spin liability overflows int64 before the win cap")
	}
	return nil
}

func isSupportedWildMultiplier(multiplier int64) bool {
	switch multiplier {
	case 0, 1, 2, 3, 5, 10, 25, 50, 100:
		return true
	default:
		return false
	}
}

func isSupportedBaseVaultMultiplier(multiplier int64) bool {
	return (multiplier >= 1 && multiplier <= 10) || isSupportedWheelMultiplier(multiplier)
}

func isSupportedKingVaultMultiplier(multiplier int64) bool {
	if isSupportedBaseVaultMultiplier(multiplier) {
		return true
	}
	switch multiplier {
	case 20, 60, 150, 500:
		return true
	default:
		return false
	}
}

func isSupportedWheelMultiplier(multiplier int64) bool {
	switch multiplier {
	case 10, 30, 75, 250, 1000:
		return true
	default:
		return false
	}
}

func (c Config) ValidateBet(bet int64) error {
	if err := c.validateBetBounds(bet); err != nil {
		return err
	}
	for _, option := range c.Bet.OptionsMinor {
		if bet == option {
			return nil
		}
	}
	return fmt.Errorf("bet %d is not a configured bet option", bet)
}

func (c Config) validateBetBounds(bet int64) error {
	if bet < c.Bet.MinMinor || bet > c.Bet.MaxMinor {
		return fmt.Errorf("bet must be between %d and %d minor units", c.Bet.MinMinor, c.Bet.MaxMinor)
	}
	if bet%c.Bet.StepMinor != 0 {
		return fmt.Errorf("bet must be a multiple of %d minor units", c.Bet.StepMinor)
	}
	return nil
}

func validateWeightedInts(name string, items []WeightedInt) error {
	if len(items) == 0 {
		return fmt.Errorf("%s are required", name)
	}
	seen := make(map[int64]struct{}, len(items))
	totalWeight := 0
	for _, item := range items {
		if item.Value <= 0 || item.Weight <= 0 {
			return fmt.Errorf("%s must have positive values and weights", name)
		}
		if _, duplicate := seen[item.Value]; duplicate {
			return fmt.Errorf("%s contain duplicate value %d", name, item.Value)
		}
		seen[item.Value] = struct{}{}
		if item.Weight > math.MaxInt-totalWeight {
			return fmt.Errorf("%s weights overflow", name)
		}
		totalWeight += item.Weight
	}
	return nil
}

func validateWildMultipliers(items []WeightedInt) error {
	if len(items) == 0 {
		return errors.New("wild multipliers are required")
	}
	seen := make(map[int64]struct{}, len(items))
	totalWeight := 0
	for _, item := range items {
		if item.Value < 0 || item.Weight <= 0 {
			return errors.New("wild multipliers must have non-negative values and positive weights")
		}
		if _, duplicate := seen[item.Value]; duplicate {
			return fmt.Errorf("wild multipliers contain duplicate value %d", item.Value)
		}
		seen[item.Value] = struct{}{}
		if item.Weight > math.MaxInt-totalWeight {
			return errors.New("wild multipliers weights overflow")
		}
		totalWeight += item.Weight
	}
	return nil
}

func IsKnownSymbol(symbol Symbol) bool {
	switch symbol {
	case SymbolOrbit, SymbolPrism, SymbolPulse, SymbolNova, SymbolCircuit, SymbolTank, SymbolWild, SymbolVault, SymbolSurge:
		return true
	default:
		return false
	}
}
