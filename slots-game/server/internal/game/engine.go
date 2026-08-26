package game

import (
	"context"
	"errors"
	"fmt"
	"math"

	"slots-game/server/internal/rng"
)

type Engine struct {
	config Config
	random rng.Source
}

func NewEngine(config Config, random rng.Source) (*Engine, error) {
	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("game config: %w", err)
	}
	if random == nil {
		return nil, errors.New("game engine requires a random source")
	}
	return &Engine{config: cloneConfig(config), random: random}, nil
}

func (e *Engine) Config() Config {
	return cloneConfig(e.config)
}

func (e *Engine) Spin(ctx context.Context, input SpinInput) (SpinOutcome, error) {
	if err := ctx.Err(); err != nil {
		return SpinOutcome{}, err
	}
	if err := e.config.ValidateBet(input.BetMinor); err != nil {
		return SpinOutcome{}, err
	}
	if err := validateFeatureState(input.Feature, input.BetMinor, e.config); err != nil {
		return SpinOutcome{}, err
	}

	input.Feature = canonicalFeatureState(input.Feature)
	rows := 3
	events := make([]Event, 0, 24)
	next := input.Feature
	if input.Feature.Active() {
		next.Remaining--
		if input.Feature.Mode == FeatureExpansion {
			picked, err := e.pickWeightedInt(e.config.Feature.ExpansionRows)
			if err != nil {
				return SpinOutcome{}, err
			}
			rows = int(picked)
			events = append(events, Event{Type: "grid.expanded", Rows: rows, Ways: rows * rows * rows})
		}
	} else {
		next = input.Feature.WithoutFreeSpins()
	}

	grid, err := e.generateGrid(rows, input.Feature.Mode)
	if err != nil {
		return SpinOutcome{}, err
	}
	wins, waysAward, err := EvaluateWaysForBet(
		grid,
		e.config.Paytable,
		input.BetMinor,
		e.config.Bet.PayUnitMinor,
	)
	if err != nil {
		return SpinOutcome{}, err
	}
	total := waysAward

	vaultEvents, vaultAward, updatedFeature, err := e.resolveVaults(grid, input, next)
	if err != nil {
		return SpinOutcome{}, err
	}
	events = append(events, vaultEvents...)
	next = updatedFeature
	total, err = safeAdd(total, vaultAward)
	if err != nil {
		return SpinOutcome{}, err
	}

	if !input.Feature.Active() {
		surgeCells := positionsForSymbol(grid, SymbolSurge)
		surgeCount := len(surgeCells)
		triggered, err := e.surgeTriggers(surgeCount)
		if err != nil {
			return SpinOutcome{}, err
		}
		if surgeCount > 0 {
			// 权威 PPS 计量器只累计已结算的一个或两个怒气符号结果。恰好三个怒气符号会直接
			// 保证触发转盘，并报告未变化的持久计量值。
			if surgeCount < 3 {
				if next.RageCollected > MaxRageCollected-surgeCount {
					return SpinOutcome{}, errors.New("Rage meter count exceeds the protocol limit")
				}
				next.RageCollected += surgeCount
				next.RageLevel = e.rageLevel(next.RageCollected)
			}
			eventLevel := next.RageLevel
			eventTotal := next.RageCollected
			if triggered && surgeCount < 3 {
				// 概率触发转盘时，权威的 21 子类型 PPS 同步状态为重置，以 1/0 表示。
				eventLevel = DefaultRageLevel
				eventTotal = 0
			}
			events = append(events, Event{
				Type: "surge.collected", Count: surgeCount,
				Cells: surgeCells, Triggered: triggered, Guaranteed: surgeCount == 3,
				Level: eventLevel, Total: eventTotal,
			})
		}
		if triggered {
			if surgeCount < 3 {
				transformed, err := e.pickRageTransformCells(grid, 3-surgeCount)
				if err != nil {
					return SpinOutcome{}, err
				}
				events = append(events, Event{
					Type: "rage.transformed", Count: len(transformed), Cells: transformed,
					Level: DefaultRageLevel, Total: 0,
				})
				// 由一个或两个怒气符号概率触发的转盘会消耗 PPS 会话；21 子类型事件快照与最终状态
				// 均重置为 1/0。
				next.RageLevel = DefaultRageLevel
				next.RageCollected = 0
			}
			events = append(events, Event{Type: "wheel.started"})
			wheel, err := e.pickWheel()
			if err != nil {
				return SpinOutcome{}, err
			}
			switch wheel.Kind {
			case WheelInstant:
				award, err := safeMul(input.BetMinor, wheel.Multiplier)
				if err != nil {
					return SpinOutcome{}, err
				}
				total, err = safeAdd(total, award)
				if err != nil {
					return SpinOutcome{}, err
				}
				events = append(events, Event{
					Type: "wheel.awarded", Outcome: string(WheelInstant),
					Prize:      vaultPrizeName(wheel.Multiplier, false),
					Multiplier: wheel.Multiplier, AmountMinor: award,
				})
			case WheelExpansion, WheelOverdrive:
				mode := FeatureMode(wheel.Kind)
				next = FeatureState{
					Mode: mode, Remaining: e.config.Feature.InitialFreeSpins,
					Awarded: e.config.Feature.InitialFreeSpins, BetMinor: input.BetMinor,
					RageLevel: next.RageLevel, RageCollected: next.RageCollected,
				}
				events = append(events,
					Event{Type: "wheel.awarded", Outcome: string(wheel.Kind)},
					Event{Type: "free_spins.started", Mode: mode, Awarded: e.config.Feature.InitialFreeSpins},
				)
			default:
				return SpinOutcome{}, fmt.Errorf("unsupported wheel result %q", wheel.Kind)
			}
		}
	}

	outcome := SpinOutcome{
		Grid: grid, Wins: wins, Events: events,
		TotalWinMinor: total, NextFeature: next,
	}
	if err := applyWinCap(e.config, input, &outcome); err != nil {
		return SpinOutcome{}, err
	}
	if err := validateOutcomeAgainstValidatedConfig(e.config, input, outcome); err != nil {
		return SpinOutcome{}, fmt.Errorf("game engine produced an invalid outcome: %w", err)
	}
	return outcome, nil
}

type resolvedVault struct {
	row        int
	multiplier int64
}

func (e *Engine) resolveVaults(
	grid Grid,
	input SpinInput,
	next FeatureState,
) ([]Event, int64, FeatureState, error) {
	positions := positionsForSymbol(grid, SymbolVault)
	if len(positions) == 0 {
		return nil, 0, next, nil
	}
	events := []Event{{Type: "vaults.landed", Count: len(positions), Cells: positions}}
	if input.Feature.Mode == FeatureOverdrive {
		kingEvents, amount, err := e.resolveKingSpinVaults(grid, positions, input.BetMinor)
		if err != nil {
			return nil, 0, next, err
		}
		return append(events, kingEvents...), amount, next, nil
	}

	unlocked, err := e.chance(e.config.Feature.VaultUnlockChanceBP)
	if err != nil {
		return nil, 0, next, err
	}
	if !unlocked {
		events = append(events, Event{Type: "vaults.locked", Count: len(positions), Cells: positions})
		return events, 0, next, nil
	}

	events = append(events, Event{Type: "vaults.unlock.started", Count: len(positions), Cells: positions})
	var total int64
	for _, position := range positions {
		allowFreeSpin := input.Feature.Mode == FeatureExpansion
		multiplier, freeSpin, err := e.pickVaultReward(allowFreeSpin)
		if err != nil {
			return nil, 0, next, err
		}
		if freeSpin {
			grid[position.Reel][position.Row].Prize = "FREE_SPIN"
			events = append(events, Event{
				Type: "vault.unlocked", Reel: position.Reel, Row: position.Row,
				Prize: "FREE_SPIN",
			})
			if next.Awarded < e.config.Feature.MaxExpansionSpins {
				next.Remaining++
				next.Awarded++
				events = append(events, Event{
					Type: "free_spin.awarded", Count: 1, Reel: position.Reel, Row: position.Row,
				})
			} else {
				events = append(events, Event{
					Type: "free_spin.cap_reached", Reel: position.Reel, Row: position.Row,
				})
			}
			continue
		}

		prize := vaultPrizeName(multiplier, false)
		grid[position.Reel][position.Row].Multiplier = multiplier
		grid[position.Reel][position.Row].Prize = prize
		events = append(events, Event{
			Type: "vault.unlocked", Reel: position.Reel, Row: position.Row,
			Prize: prize, Multiplier: multiplier,
		})
		award, err := safeMul(input.BetMinor, multiplier)
		if err != nil {
			return nil, 0, next, err
		}
		total, err = safeAdd(total, award)
		if err != nil {
			return nil, 0, next, err
		}
		events = append(events, Event{
			Type: "vault.awarded", Reel: position.Reel, Row: position.Row,
			Prize: prize, Multiplier: multiplier, AmountMinor: award,
		})
	}
	events = append(events, Event{Type: "vaults.unlock.completed", Count: len(positions), Cells: positions})
	return events, total, next, nil
}

func (e *Engine) resolveKingSpinVaults(grid Grid, positions []Position, betMinor int64) ([]Event, int64, error) {
	events := []Event{{Type: "vaults.unlock.started", Count: len(positions), Cells: positions}}
	resolved := make([]resolvedVault, len(positions))
	for index, position := range positions {
		multiplier, err := e.pickWeightedInt(e.config.VaultMultipliers)
		if err != nil {
			return nil, 0, err
		}
		resolved[index] = resolvedVault{row: position.Row, multiplier: multiplier}
		events = append(events, Event{
			Type: "vault.unlocked", Reel: position.Reel, Row: position.Row,
			Prize: vaultPrizeName(multiplier, true), Multiplier: multiplier,
		})
	}
	events = append(events, Event{Type: "vaults.unlock.completed", Count: len(positions), Cells: positions})

	for step := 1; step <= e.config.Feature.KingSpinMaxUpgradeRounds; step++ {
		upgrade, err := e.chance(e.config.Feature.KingSpinUpgradeChanceBP)
		if err != nil {
			return nil, 0, err
		}
		if !upgrade {
			break
		}
		stepEvents := make([]Event, 0, len(resolved)+1)
		for index := range resolved {
			from := resolved[index].multiplier
			to, ok, err := e.pickGreaterWeightedInt(e.config.OverdriveMultipliers, from)
			if err != nil {
				return nil, 0, err
			}
			if !ok {
				continue
			}
			if isBaseJackpotMultiplier(to) {
				doubled, err := e.chance(e.config.Feature.OverdriveDoubleChanceBP)
				if err != nil {
					return nil, 0, err
				}
				if doubled {
					to, err = safeMul(to, 2)
					if err != nil {
						return nil, 0, err
					}
				}
			}
			resolved[index].multiplier = to
			stepEvents = append(stepEvents, Event{
				Type: "vault.upgraded", Reel: 1, Row: resolved[index].row, Step: step,
				Prize: vaultPrizeName(to, true), FromMultiplier: from, ToMultiplier: to,
			})
		}
		if len(stepEvents) == 0 {
			break
		}
		events = append(events, Event{Type: "vaults.upgrade.started", Count: len(stepEvents), Step: step})
		events = append(events, stepEvents...)
	}

	var total int64
	for _, vault := range resolved {
		prize := vaultPrizeName(vault.multiplier, true)
		grid[1][vault.row].Multiplier = vault.multiplier
		grid[1][vault.row].Prize = prize
		award, err := safeMul(betMinor, vault.multiplier)
		if err != nil {
			return nil, 0, err
		}
		total, err = safeAdd(total, award)
		if err != nil {
			return nil, 0, err
		}
		events = append(events, Event{
			Type: "vault.awarded", Reel: 1, Row: vault.row,
			Prize:      prize,
			Multiplier: vault.multiplier, AmountMinor: award,
		})
	}
	return events, total, nil
}

func (e *Engine) pickVaultReward(allowFreeSpin bool) (int64, bool, error) {
	total := 0
	for _, item := range e.config.VaultMultipliers {
		if item.Weight > math.MaxInt-total {
			return 0, false, errors.New("Vault reward weights overflow")
		}
		total += item.Weight
	}
	if allowFreeSpin {
		if e.config.Feature.VaultFreeSpinWeight > math.MaxInt-total {
			return 0, false, errors.New("Vault FREE SPIN weight overflows")
		}
		total += e.config.Feature.VaultFreeSpinWeight
	}
	pick, err := e.random.Intn(total)
	if err != nil {
		return 0, false, err
	}
	for _, item := range e.config.VaultMultipliers {
		if pick < item.Weight {
			return item.Value, false, nil
		}
		pick -= item.Weight
	}
	if allowFreeSpin && e.config.Feature.VaultFreeSpinWeight > 0 {
		return 0, true, nil
	}
	return 0, false, errors.New("weighted Vault reward selection failed")
}

func (e *Engine) pickGreaterWeightedInt(items []WeightedInt, current int64) (int64, bool, error) {
	total := 0
	for _, item := range items {
		if item.Value <= current {
			continue
		}
		if item.Weight > math.MaxInt-total {
			return 0, false, errors.New("upgrade weights overflow")
		}
		total += item.Weight
	}
	if total == 0 {
		return 0, false, nil
	}
	pick, err := e.random.Intn(total)
	if err != nil {
		return 0, false, err
	}
	for _, item := range items {
		if item.Value <= current {
			continue
		}
		if pick < item.Weight {
			return item.Value, true, nil
		}
		pick -= item.Weight
	}
	return 0, false, errors.New("weighted upgrade selection failed")
}

func vaultPrizeName(multiplier int64, kingSpin bool) string {
	if kingSpin {
		switch multiplier {
		case 20:
			return "MINI_2X"
		case 60:
			return "MINOR_2X"
		case 150:
			return "MAJOR_2X"
		case 500:
			return "MEGA_2X"
		}
	}
	if multiplier >= 1 && multiplier <= 9 {
		return fmt.Sprintf("X%d", multiplier)
	}
	switch multiplier {
	case 10:
		return "MINI"
	case 30:
		return "MINOR"
	case 75:
		return "MAJOR"
	case 250:
		return "MEGA"
	case 1000:
		return "GRAND"
	default:
		return ""
	}
}

func isBaseJackpotMultiplier(multiplier int64) bool {
	return multiplier == 10 || multiplier == 30 || multiplier == 75 || multiplier == 250
}

func canonicalFeatureState(state FeatureState) FeatureState {
	if state.Mode == "" {
		state.Mode = FeatureNone
	}
	// 在引入 PPS 前，零表示空计量器。应在引擎边界将其规范化，使旧版内存调用方收敛到
	// 已采集游戏的一级空闲状态。
	if state.RageCollected == 0 && state.RageLevel == 0 {
		state.RageLevel = DefaultRageLevel
	}
	return state
}

func (e *Engine) rageLevel(collected int) int {
	return rageLevelFor(collected, e.config.Feature.RageLevelThresholds)
}

func rageLevelFor(collected int, thresholds []int) int {
	if collected <= 0 {
		return DefaultRageLevel
	}
	level := 1
	for index, threshold := range thresholds {
		if collected >= threshold {
			level = index + 1
		}
	}
	return level
}

func positionsExceptSymbol(grid Grid, excluded Symbol) []Position {
	positions := make([]Position, 0, len(grid)*len(grid[0]))
	for reel, cells := range grid {
		for row, cell := range cells {
			if cell.Symbol != excluded {
				positions = append(positions, Position{Reel: reel, Row: row})
			}
		}
	}
	return positions
}

func (e *Engine) pickRageTransformCells(grid Grid, count int) ([]Position, error) {
	candidates := positionsExceptSymbol(grid, SymbolSurge)
	if count < 0 || count > len(candidates) {
		return nil, errors.New("invalid Rage transformation count")
	}
	for index := 0; index < count; index++ {
		picked, err := e.random.Intn(len(candidates) - index)
		if err != nil {
			return nil, err
		}
		picked += index
		candidates[index], candidates[picked] = candidates[picked], candidates[index]
	}
	return append([]Position(nil), candidates[:count]...), nil
}

func withoutSymbol(items []WeightedSymbol, excluded Symbol) []WeightedSymbol {
	filtered := make([]WeightedSymbol, 0, len(items))
	for _, item := range items {
		if item.Value != excluded {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func cloneConfig(config Config) Config {
	cloned := config
	cloned.Bet.OptionsMinor = append([]int64(nil), config.Bet.OptionsMinor...)
	for reel := range config.Reels {
		cloned.Reels[reel] = append([]WeightedSymbol(nil), config.Reels[reel]...)
	}
	cloned.Paytable = make(map[Symbol]int64, len(config.Paytable))
	for symbol, payout := range config.Paytable {
		cloned.Paytable[symbol] = payout
	}
	cloned.WildMultipliers = append([]WeightedInt(nil), config.WildMultipliers...)
	cloned.VaultMultipliers = append([]WeightedInt(nil), config.VaultMultipliers...)
	cloned.OverdriveMultipliers = append([]WeightedInt(nil), config.OverdriveMultipliers...)
	cloned.Feature.ExpansionRows = append([]WeightedInt(nil), config.Feature.ExpansionRows...)
	cloned.Feature.RageLevelThresholds = append([]int(nil), config.Feature.RageLevelThresholds...)
	cloned.Feature.Wheel = append([]WeightedWheel(nil), config.Feature.Wheel...)
	return cloned
}

func validateFeatureState(state FeatureState, bet int64, config Config) error {
	state = canonicalFeatureState(state)
	featureConfig := config.Feature
	if state.RageCollected < 0 || state.RageCollected > MaxRageCollected ||
		state.RageLevel < DefaultRageLevel || state.RageLevel > len(featureConfig.RageLevelThresholds) {
		return errors.New("invalid Rage meter state")
	}
	if state.RageCollected == 0 && state.RageLevel != DefaultRageLevel {
		return errors.New("empty Rage meter must be at the default level")
	}
	if state.RageCollected > 0 && state.RageLevel != rageLevelFor(state.RageCollected, featureConfig.RageLevelThresholds) {
		return errors.New("Rage meter level does not match its collected count")
	}
	if !state.Active() {
		if state.Mode != "" && state.Mode != FeatureNone {
			return errors.New("inactive feature has invalid mode")
		}
		if state.Remaining != 0 || state.Awarded != 0 || state.BetMinor != 0 || state.WinMinor != 0 {
			return errors.New("inactive feature has non-zero free-spin counters")
		}
		return nil
	}
	if state.Mode != FeatureExpansion && state.Mode != FeatureOverdrive {
		return fmt.Errorf("unknown active feature mode %q", state.Mode)
	}
	if state.BetMinor != bet {
		return errors.New("feature bet does not match spin bet")
	}
	if state.WinMinor < 0 {
		return errors.New("feature win cannot be negative")
	}
	capMinor, err := safeMul(bet, config.MaxWinMultiplier)
	if err != nil || state.WinMinor > capMinor {
		return errors.New("feature win exceeds the definition max win")
	}
	if state.Awarded < state.Remaining || state.Awarded <= 0 {
		return errors.New("invalid feature counters")
	}
	if state.Remaining > MaxFeatureSpins || state.Awarded > MaxFeatureSpins {
		return errors.New("feature counters exceed the protocol limit")
	}
	if state.Mode == FeatureExpansion && state.Awarded > featureConfig.MaxExpansionSpins {
		return errors.New("expansion spin cap exceeded")
	}
	if state.Mode == FeatureOverdrive && state.Awarded != featureConfig.InitialFreeSpins {
		return errors.New("overdrive cannot be extended")
	}
	return nil
}

func (e *Engine) generateGrid(rows int, mode FeatureMode) (Grid, error) {
	if rows < 3 || rows > 8 {
		return nil, fmt.Errorf("row count %d is outside [3,8]", rows)
	}
	grid := make(Grid, 3)
	settledRage := 0
	for reel := range 3 {
		weighted := e.config.Reels[reel]
		if mode == FeatureExpansion || mode == FeatureOverdrive {
			weighted = withoutSymbol(weighted, SymbolSurge)
		}
		grid[reel] = make([]Cell, rows)
		for row := range rows {
			cellWeights := weighted
			// 权威的必定触发转盘语义要求恰好三个怒气符号。基础游戏网格确定三个怒气符号后，
			// 后续格必须从移除怒气符号的同一权重中抽取，避免引擎生成所有协议边界都必须拒绝的结果。
			if mode == FeatureNone && settledRage == 3 {
				cellWeights = withoutSymbol(weighted, SymbolSurge)
			}
			symbol, err := e.pickWeightedSymbol(cellWeights)
			if err != nil {
				return nil, err
			}
			if symbol == SymbolSurge {
				settledRage++
			}
			cell := Cell{Symbol: symbol}
			if symbol == SymbolWild {
				cell.Multiplier, err = e.pickWeightedInt(e.config.WildMultipliers)
				if err != nil {
					return nil, err
				}
			}
			grid[reel][row] = cell
		}
	}
	return grid, nil
}

func (e *Engine) pickWeightedSymbol(items []WeightedSymbol) (Symbol, error) {
	total := 0
	for _, item := range items {
		if item.Weight > math.MaxInt-total {
			return "", errors.New("symbol weights overflow")
		}
		total += item.Weight
	}
	pick, err := e.random.Intn(total)
	if err != nil {
		return "", err
	}
	for _, item := range items {
		if pick < item.Weight {
			return item.Value, nil
		}
		pick -= item.Weight
	}
	return "", errors.New("weighted symbol selection failed")
}

func (e *Engine) pickWeightedInt(items []WeightedInt) (int64, error) {
	total := 0
	for _, item := range items {
		if item.Weight > math.MaxInt-total {
			return 0, errors.New("integer weights overflow")
		}
		total += item.Weight
	}
	pick, err := e.random.Intn(total)
	if err != nil {
		return 0, err
	}
	for _, item := range items {
		if pick < item.Weight {
			return item.Value, nil
		}
		pick -= item.Weight
	}
	return 0, errors.New("weighted integer selection failed")
}

func (e *Engine) pickWheel() (WeightedWheel, error) {
	total := 0
	for _, item := range e.config.Feature.Wheel {
		if item.Weight > math.MaxInt-total {
			return WeightedWheel{}, errors.New("wheel weights overflow")
		}
		total += item.Weight
	}
	pick, err := e.random.Intn(total)
	if err != nil {
		return WeightedWheel{}, err
	}
	for _, item := range e.config.Feature.Wheel {
		if pick < item.Weight {
			return item, nil
		}
		pick -= item.Weight
	}
	return WeightedWheel{}, errors.New("wheel selection failed")
}

func (e *Engine) chance(basisPoints int) (bool, error) {
	if basisPoints <= 0 {
		return false, nil
	}
	if basisPoints >= 10_000 {
		return true, nil
	}
	pick, err := e.random.Intn(10_000)
	return pick < basisPoints, err
}

func (e *Engine) surgeTriggers(count int) (bool, error) {
	switch {
	case count > 3:
		return false, errors.New("more than three settled Rage symbols")
	case count == 3:
		return true, nil
	case count == 2:
		return e.chance(e.config.Feature.SurgeTwoChanceBP)
	case count == 1:
		return e.chance(e.config.Feature.SurgeOneChanceBP)
	default:
		return false, nil
	}
}

func positionsForSymbol(grid Grid, target Symbol) []Position {
	positions := make([]Position, 0)
	for reel, cells := range grid {
		for row, cell := range cells {
			if cell.Symbol == target {
				positions = append(positions, Position{Reel: reel, Row: row})
			}
		}
	}
	return positions
}

func nextLargerMultiplier(current int64, items []WeightedInt) int64 {
	best := int64(math.MaxInt64)
	maximum := current
	for _, item := range items {
		if item.Value > maximum {
			maximum = item.Value
		}
		if item.Value > current && item.Value < best {
			best = item.Value
		}
	}
	if best != math.MaxInt64 {
		return best
	}
	return maximum
}
