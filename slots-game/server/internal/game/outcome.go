package game

import (
	"errors"
	"fmt"
	"math"
	"regexp"
)

var outcomeNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// ValidateOutcomeStructure 是结果可持久化并发送给钱包前的表示层信任边界。它验证不变式，
// 并证明 TotalWinMinor 等于全部可见中奖及事件奖励之和。使用不可变数学定义的引擎还会调用
// ValidateOutcomeAgainstConfig 重新计算完整连线结果。
func ValidateOutcomeStructure(input SpinInput, outcome SpinOutcome) error {
	input.Feature = canonicalFeatureState(input.Feature)
	rows, err := validateOutcomeGrid(outcome.Grid)
	if err != nil {
		return err
	}
	var accounted int64
	for index, win := range outcome.Wins {
		if !outcomeNamePattern.MatchString(win.ID) || !isPayingSymbol(win.Symbol) ||
			win.Ways < 1 || win.AmountMinor <= 0 || len(win.Cells) == 0 {
			return fmt.Errorf("outcome: invalid win %d", index)
		}
		if err := validatePositions(win.Cells, rows); err != nil {
			return fmt.Errorf("outcome: win %d: %w", index, err)
		}
		if err := validatePathAwards(win, outcome.Grid); err != nil {
			return fmt.Errorf("outcome: win %d path awards: %w", index, err)
		}
		accounted, err = addOutcomeMoney(accounted, win.AmountMinor)
		if err != nil {
			return err
		}
	}
	for index, event := range outcome.Events {
		if !outcomeNamePattern.MatchString(event.Type) ||
			event.Count < 0 || event.Multiplier < 0 || event.AmountMinor < 0 ||
			event.CumulativeWinMinor < 0 ||
			event.Awarded < 0 || event.Rows < 0 || event.Ways < 0 ||
			event.Level < 0 || event.Total < 0 || event.Step < 0 ||
			event.FromMultiplier < 0 || event.ToMultiplier < 0 {
			return fmt.Errorf("outcome: invalid event %d", index)
		}
		if event.AmountMinor != 0 && !isMonetaryAwardEvent(event.Type) {
			return fmt.Errorf("outcome: event %d cannot carry a monetary award", index)
		}
		if event.Outcome != "" && !outcomeNamePattern.MatchString(event.Outcome) {
			return fmt.Errorf("outcome: invalid event %d outcome", index)
		}
		if event.Prize != "" && !outcomeNamePattern.MatchString(event.Prize) {
			return fmt.Errorf("outcome: invalid event %d prize", index)
		}
		if err := validatePositions(event.Cells, rows); err != nil {
			return fmt.Errorf("outcome: event %d: %w", index, err)
		}
		if isVaultCellEvent(event.Type) &&
			(event.Reel != 1 || event.Row < 0 || event.Row >= rows) {
			return fmt.Errorf("outcome: event %d has an invalid Vault coordinate", index)
		}
		accounted, err = addOutcomeMoney(accounted, event.AmountMinor)
		if err != nil {
			return err
		}
	}
	if outcome.TotalWinMinor < 0 || accounted != outcome.TotalWinMinor {
		return errors.New("outcome: total win does not match visible awards")
	}
	if err := validateOutcomeFeature(outcome.NextFeature, input.BetMinor); err != nil {
		return err
	}
	if err := validateFeatureEventOrder(input, outcome); err != nil {
		return err
	}
	return nil
}

func isMonetaryAwardEvent(eventType string) bool {
	return eventType == "wheel.awarded" || eventType == "vault.awarded"
}

// ValidateOutcomeAgainstConfig 闭合内置引擎的数学信任链。每项聚合连线奖励均依据确切格子
// 修正值及不可变赔付表重新计算；浏览器提供的任何倍数或金额都不会参与结算。
func ValidateOutcomeAgainstConfig(config Config, input SpinInput, outcome SpinOutcome) error {
	if err := config.Validate(); err != nil {
		return fmt.Errorf("outcome: invalid game definition: %w", err)
	}
	if err := config.ValidateBet(input.BetMinor); err != nil {
		return fmt.Errorf("outcome: invalid bet: %w", err)
	}
	if err := ValidateOutcomeStructure(input, outcome); err != nil {
		return err
	}
	wins, _, err := EvaluateWaysForBet(
		outcome.Grid,
		config.Paytable,
		input.BetMinor,
		config.Bet.PayUnitMinor,
	)
	if err != nil {
		return fmt.Errorf("outcome: recompute Ways: %w", err)
	}
	if !sameWins(wins, outcome.Wins) {
		return errors.New("outcome: Ways wins do not match the authoritative grid and definition")
	}
	return nil
}

func sameWins(left, right []Win) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].ID != right[index].ID || left[index].Symbol != right[index].Symbol ||
			left[index].Ways != right[index].Ways || left[index].AmountMinor != right[index].AmountMinor ||
			!samePositions(left[index].Cells, right[index].Cells) ||
			!samePathAwards(left[index].PathAwards, right[index].PathAwards) {
			return false
		}
	}
	return true
}

func samePathAwards(left, right []PathAward) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].Multiplier != right[index].Multiplier ||
			left[index].BaseAmountMinor != right[index].BaseAmountMinor ||
			left[index].AmountMinor != right[index].AmountMinor ||
			!samePositions(left[index].Cells, right[index].Cells) {
			return false
		}
	}
	return true
}

func validatePathAwards(win Win, grid Grid) error {
	if len(win.PathAwards) != win.Ways {
		return errors.New("path count must equal ways")
	}
	aggregateCells := make(map[Position]struct{}, len(win.Cells))
	for _, position := range win.Cells {
		aggregateCells[position] = struct{}{}
	}
	pathCells := make(map[Position]struct{}, len(win.Cells))
	seenPaths := make(map[[3]int]struct{}, len(win.PathAwards))
	var pathTotal int64
	for pathIndex, award := range win.PathAwards {
		if len(award.Cells) != 3 || award.Multiplier < 1 ||
			award.BaseAmountMinor < 0 || award.AmountMinor < 0 ||
			award.BaseAmountMinor > award.AmountMinor ||
			(award.AmountMinor == 0 && award.BaseAmountMinor != 0) ||
			(award.AmountMinor > 0 && award.BaseAmountMinor == 0) ||
			(award.Multiplier == 1 && award.BaseAmountMinor != award.AmountMinor) {
			return fmt.Errorf("invalid path %d", pathIndex)
		}
		rows := [3]int{}
		expectedMultiplier := int64(1)
		for reel, position := range award.Cells {
			if position.Reel != reel || position.Row < 0 || position.Row >= len(grid[reel]) {
				return fmt.Errorf("path %d must contain one ordered cell per reel", pathIndex)
			}
			cell := grid[reel][position.Row]
			if cell.Symbol != win.Symbol && cell.Symbol != SymbolWild {
				return fmt.Errorf("path %d cell %d is incompatible with %s", pathIndex, reel, win.Symbol)
			}
			if cell.Symbol == SymbolWild {
				wildMultiplier := cell.Multiplier
				if wildMultiplier == 0 {
					wildMultiplier = 1
				}
				var err error
				expectedMultiplier, err = safeMul(expectedMultiplier, wildMultiplier)
				if err != nil {
					return fmt.Errorf("path %d multiplier: %w", pathIndex, err)
				}
			}
			rows[reel] = position.Row
			pathCells[position] = struct{}{}
		}
		if _, duplicate := seenPaths[rows]; duplicate {
			return fmt.Errorf("path %d duplicates an earlier path", pathIndex)
		}
		seenPaths[rows] = struct{}{}
		if award.Multiplier != expectedMultiplier {
			return fmt.Errorf("path %d multiplier does not match its WILD cells", pathIndex)
		}
		var err error
		pathTotal, err = addOutcomeMoney(pathTotal, award.AmountMinor)
		if err != nil {
			return err
		}
	}
	if pathTotal != win.AmountMinor {
		return errors.New("path amounts do not sum to the aggregate award")
	}
	if len(pathCells) != len(aggregateCells) {
		return errors.New("aggregate cells do not match path cells")
	}
	for position := range aggregateCells {
		if _, exists := pathCells[position]; !exists {
			return errors.New("aggregate cells do not match path cells")
		}
	}
	return nil
}

func validateOutcomeGrid(grid Grid) (int, error) {
	if len(grid) != 3 {
		return 0, errors.New("outcome: grid must contain exactly three reels")
	}
	rows := len(grid[0])
	if rows < 3 || rows > 8 {
		return 0, errors.New("outcome: grid row count must be in [3,8]")
	}
	for reel, cells := range grid {
		if len(cells) != rows {
			return 0, errors.New("outcome: every reel must have the same row count")
		}
		for row, cell := range cells {
			if !IsKnownSymbol(cell.Symbol) {
				return 0, errors.New("outcome: grid contains an unknown symbol")
			}
			if reel != 1 && (cell.Symbol == SymbolWild || cell.Symbol == SymbolVault) {
				return 0, errors.New("outcome: wild and vault symbols are restricted to the middle reel")
			}
			if err := validateCellModifier(cell); err != nil {
				return 0, fmt.Errorf("outcome: grid cell %d,%d: %w", reel, row, err)
			}
		}
	}
	return rows, nil
}

// validateCellModifier 定义完全由服务器控制的修正值范围。浏览器可以渲染这些字段，
// 但绝不能自行生成或修改它们。
func validateCellModifier(cell Cell) error {
	switch cell.Symbol {
	case SymbolWild:
		if !isSupportedWildMultiplier(cell.Multiplier) || cell.Prize != "" {
			return errors.New("WILD has an unsupported multiplier or prize")
		}
	case SymbolVault:
		switch {
		case cell.Prize == "":
			if cell.Multiplier != 0 {
				return errors.New("unresolved VAULT cannot expose a multiplier")
			}
		case cell.Prize == "FREE_SPIN":
			if cell.Multiplier != 0 {
				return errors.New("FREE_SPIN VAULT cannot carry a money multiplier")
			}
		case cell.Multiplier <= 0:
			return errors.New("payable VAULT requires a positive multiplier")
		case !validVaultCellPrize(cell.Multiplier, cell.Prize):
			return errors.New("VAULT prize does not name its multiplier")
		}
	default:
		if cell.Multiplier != 0 || cell.Prize != "" {
			return errors.New("ordinary symbol cannot carry a modifier")
		}
	}
	return nil
}

func validVaultCellPrize(multiplier int64, prize string) bool {
	return (isSupportedBaseVaultMultiplier(multiplier) && prize == vaultPrizeName(multiplier, false)) ||
		(isSupportedKingVaultMultiplier(multiplier) && prize == vaultPrizeName(multiplier, true))
}

func validatePositions(positions []Position, rows int) error {
	seen := make(map[Position]struct{}, len(positions))
	for _, position := range positions {
		if position.Reel < 0 || position.Reel >= 3 ||
			position.Row < 0 || position.Row >= rows {
			return errors.New("position is outside the grid")
		}
		if _, duplicate := seen[position]; duplicate {
			return errors.New("position is duplicated")
		}
		seen[position] = struct{}{}
	}
	return nil
}

func validateOutcomeFeature(state FeatureState, betMinor int64) error {
	state = canonicalFeatureState(state)
	if state.RageLevel < DefaultRageLevel || state.RageLevel > MaxRageCollected ||
		state.RageCollected < 0 || state.RageCollected > MaxRageCollected ||
		(state.RageCollected == 0 && state.RageLevel != DefaultRageLevel) {
		return errors.New("outcome: Rage meter state is invalid")
	}
	if !state.Active() {
		if state.Mode != FeatureNone || state.Remaining != 0 || state.Awarded != 0 ||
			state.BetMinor != 0 || state.WinMinor != 0 {
			return errors.New("outcome: inactive feature state is not canonical")
		}
		return nil
	}
	if state.Mode != FeatureExpansion && state.Mode != FeatureOverdrive {
		return errors.New("outcome: active feature mode is invalid")
	}
	if state.Remaining < 1 || state.Awarded < state.Remaining ||
		state.Remaining > MaxFeatureSpins || state.Awarded > MaxFeatureSpins ||
		state.BetMinor != betMinor || betMinor <= 0 || state.WinMinor < 0 {
		return errors.New("outcome: active feature counters or bet are invalid")
	}
	return nil
}

func isVaultCellEvent(eventType string) bool {
	switch eventType {
	case "vault.unlocked", "vault.awarded", "vault.upgraded", "free_spin.awarded", "free_spin.cap_reached":
		return true
	default:
		return false
	}
}

func validateFeatureEventOrder(input SpinInput, outcome SpinOutcome) error {
	input.Feature = canonicalFeatureState(input.Feature)
	if err := validateExpansionEvents(input, outcome); err != nil {
		return err
	}
	if err := validateVaultEvents(input, outcome); err != nil {
		return err
	}
	if err := validateRageAndWheelEvents(input, outcome); err != nil {
		return err
	}
	return validateFeatureCompletion(input, outcome)
}

func validateExpansionEvents(input SpinInput, outcome SpinOutcome) error {
	expanded := eventIndexes(outcome.Events, "grid.expanded")
	if input.Feature.Mode != FeatureExpansion {
		if len(expanded) != 0 || len(outcome.Grid[0]) != 3 {
			return errors.New("outcome: only Kong Quest may use an expanded grid")
		}
		return nil
	}
	if len(expanded) != 1 || expanded[0] != 0 {
		return errors.New("outcome: Kong Quest requires one leading grid.expanded event")
	}
	event := outcome.Events[expanded[0]]
	if event.Rows != len(outcome.Grid[0]) || event.Ways != event.Rows*event.Rows*event.Rows {
		return errors.New("outcome: expanded-grid event does not match the result grid")
	}
	return nil
}

func validateVaultEvents(input SpinInput, outcome SpinOutcome) error {
	positions := positionsForSymbol(outcome.Grid, SymbolVault)
	var vaultEventCount int
	for _, event := range outcome.Events {
		if isVaultSemanticEvent(event.Type) {
			vaultEventCount++
		}
	}
	if len(positions) == 0 {
		if vaultEventCount != 0 {
			return errors.New("outcome: Vault event exists without a settled Vault")
		}
		return nil
	}

	landed := eventIndexes(outcome.Events, "vaults.landed")
	if len(landed) != 1 {
		return errors.New("outcome: settled Vaults require exactly one vaults.landed event")
	}
	wantStart := 0
	if input.Feature.Mode == FeatureExpansion {
		wantStart = 1
	}
	if landed[0] != wantStart || !validVaultGroupEvent(outcome.Events[landed[0]], positions) {
		return errors.New("outcome: vaults.landed does not match the settled Vault set")
	}

	locked := eventIndexes(outcome.Events, "vaults.locked")
	unlockStarted := eventIndexes(outcome.Events, "vaults.unlock.started")
	unlockCompleted := eventIndexes(outcome.Events, "vaults.unlock.completed")
	if len(locked) == 1 {
		if input.Feature.Mode == FeatureOverdrive || locked[0] != landed[0]+1 ||
			!validVaultGroupEvent(outcome.Events[locked[0]], positions) ||
			len(unlockStarted) != 0 || len(unlockCompleted) != 0 || vaultEventCount != 2 {
			return errors.New("outcome: invalid locked Vault branch")
		}
		for _, position := range positions {
			cell := outcome.Grid[position.Reel][position.Row]
			if cell.Multiplier != 0 || cell.Prize != "" {
				return errors.New("outcome: locked Vault exposes a hidden reward")
			}
		}
		return nil
	}
	if len(locked) != 0 || len(unlockStarted) != 1 || len(unlockCompleted) != 1 ||
		unlockStarted[0] != landed[0]+1 || unlockCompleted[0] <= unlockStarted[0] ||
		!validVaultGroupEvent(outcome.Events[unlockStarted[0]], positions) ||
		!validVaultGroupEvent(outcome.Events[unlockCompleted[0]], positions) {
		return errors.New("outcome: invalid Vault unlock boundaries")
	}

	reveals := make(map[Position]Event, len(positions))
	awards := make(map[Position]Event, len(positions))
	freeResults := make(map[Position]Event, len(positions))
	for index, event := range outcome.Events {
		position := Position{Reel: event.Reel, Row: event.Row}
		switch event.Type {
		case "vault.unlocked":
			if index <= unlockStarted[0] || index >= unlockCompleted[0] ||
				!containsPosition(positions, position) || event.Prize == "" {
				return errors.New("outcome: invalid vault.unlocked event")
			}
			if _, duplicate := reveals[position]; duplicate {
				return errors.New("outcome: duplicate Vault reveal")
			}
			reveals[position] = event
		case "vault.awarded":
			if !containsPosition(positions, position) || event.Multiplier <= 0 ||
				event.AmountMinor <= 0 || event.Prize == "" ||
				(input.Feature.Mode != FeatureOverdrive &&
					(index <= unlockStarted[0] || index >= unlockCompleted[0])) ||
				(input.Feature.Mode == FeatureOverdrive && index <= unlockCompleted[0]) {
				return errors.New("outcome: invalid vault.awarded event")
			}
			if _, duplicate := awards[position]; duplicate {
				return errors.New("outcome: duplicate Vault award")
			}
			awards[position] = event
		case "free_spin.awarded", "free_spin.cap_reached":
			if input.Feature.Mode != FeatureExpansion || !containsPosition(positions, position) ||
				index <= unlockStarted[0] || index >= unlockCompleted[0] {
				return errors.New("outcome: Vault Free Spin result is outside Kong Quest")
			}
			if event.Type == "free_spin.awarded" && event.Count != 1 {
				return errors.New("outcome: Vault Free Spin award count must be one")
			}
			if _, duplicate := freeResults[position]; duplicate {
				return errors.New("outcome: duplicate Vault Free Spin result")
			}
			freeResults[position] = event
		case "vault.upgraded", "vaults.upgrade.started":
			if input.Feature.Mode != FeatureOverdrive || index <= unlockCompleted[0] {
				return errors.New("outcome: Vault upgrade is outside King Spin")
			}
		}
	}
	if len(reveals) != len(positions) {
		return errors.New("outcome: every unlocked Vault must have one reveal")
	}

	if input.Feature.Mode == FeatureOverdrive {
		if err := validateKingSpinVaultEvents(
			outcome.Grid, outcome.Events, unlockCompleted[0], positions, reveals, awards, input.BetMinor,
		); err != nil {
			return err
		}
		return nil
	}
	for _, position := range positions {
		reveal := reveals[position]
		award, paid := awards[position]
		free, extended := freeResults[position]
		cell := outcome.Grid[position.Reel][position.Row]
		if paid == extended {
			return errors.New("outcome: every revealed Vault needs exactly one final result")
		}
		if paid {
			wantAmount, err := safeMul(input.BetMinor, award.Multiplier)
			if err != nil {
				return err
			}
			if reveal.Prize != award.Prize || reveal.Multiplier != award.Multiplier ||
				reveal.Multiplier <= 0 || award.Prize != vaultPrizeName(award.Multiplier, false) ||
				award.AmountMinor != wantAmount || cell.Multiplier != award.Multiplier ||
				cell.Prize != award.Prize {
				return errors.New("outcome: Vault reveal and payable award disagree")
			}
		} else if reveal.Prize != "FREE_SPIN" || reveal.Multiplier != 0 ||
			(free.Type != "free_spin.awarded" && free.Type != "free_spin.cap_reached") ||
			cell.Prize != "FREE_SPIN" || cell.Multiplier != 0 {
			return errors.New("outcome: invalid FREE_SPIN Vault reveal")
		}
	}
	for index := unlockStarted[0] + 1; index < unlockCompleted[0]; index++ {
		switch outcome.Events[index].Type {
		case "vault.unlocked", "vault.awarded", "free_spin.awarded", "free_spin.cap_reached":
		default:
			return errors.New("outcome: unrelated event interrupts Vault unlock sequence")
		}
	}
	return nil
}

func validateKingSpinVaultEvents(
	grid Grid,
	events []Event,
	unlockCompleted int,
	positions []Position,
	reveals map[Position]Event,
	awards map[Position]Event,
	betMinor int64,
) error {
	if len(awards) != len(positions) {
		return errors.New("outcome: every King Spin Vault requires one final award")
	}
	currentMultiplier := make(map[Position]int64, len(positions))
	currentPrize := make(map[Position]string, len(positions))
	for _, position := range positions {
		reveal := reveals[position]
		if reveal.Multiplier <= 0 || reveal.Prize != vaultPrizeName(reveal.Multiplier, true) {
			return errors.New("outcome: invalid initial King Spin Vault reveal")
		}
		currentMultiplier[position] = reveal.Multiplier
		currentPrize[position] = reveal.Prize
	}
	firstAward := len(events)
	for index, event := range events {
		if event.Type == "vault.awarded" && index < firstAward {
			firstAward = index
		}
	}
	if firstAward <= unlockCompleted {
		return errors.New("outcome: King Spin Vault awards must follow unlock and upgrades")
	}
	for index := firstAward; index < len(events); index++ {
		if events[index].Type != "vault.awarded" && events[index].Type != "free_spins.completed" {
			return errors.New("outcome: King Spin final awards are not contiguous")
		}
	}

	expectedStep := 1
	activeStep := 0
	activeCount := 0
	seenInStep := make(map[Position]struct{})
	finishStep := func() error {
		if activeStep != 0 && activeCount != len(seenInStep) {
			return errors.New("outcome: King Spin upgrade group count is incorrect")
		}
		return nil
	}
	for index := unlockCompleted + 1; index < firstAward; index++ {
		event := events[index]
		switch event.Type {
		case "vaults.upgrade.started":
			if err := finishStep(); err != nil {
				return err
			}
			if event.Step != expectedStep || event.Count <= 0 {
				return errors.New("outcome: King Spin upgrade steps are not contiguous")
			}
			activeStep, activeCount = event.Step, event.Count
			expectedStep++
			seenInStep = make(map[Position]struct{}, event.Count)
		case "vault.upgraded":
			position := Position{Reel: event.Reel, Row: event.Row}
			if activeStep == 0 || event.Step != activeStep || !containsPosition(positions, position) ||
				event.FromMultiplier != currentMultiplier[position] ||
				event.ToMultiplier <= event.FromMultiplier ||
				event.Prize != vaultPrizeName(event.ToMultiplier, true) {
				return errors.New("outcome: invalid King Spin Vault upgrade")
			}
			if _, duplicate := seenInStep[position]; duplicate {
				return errors.New("outcome: duplicate Vault in one King Spin upgrade step")
			}
			seenInStep[position] = struct{}{}
			currentMultiplier[position] = event.ToMultiplier
			currentPrize[position] = event.Prize
		default:
			return errors.New("outcome: unrelated event interrupts King Spin upgrades")
		}
	}
	if err := finishStep(); err != nil {
		return err
	}
	for _, position := range positions {
		award := awards[position]
		cell := grid[position.Reel][position.Row]
		wantAmount, err := safeMul(betMinor, award.Multiplier)
		if err != nil {
			return err
		}
		if award.Multiplier != currentMultiplier[position] || award.Prize != currentPrize[position] ||
			award.AmountMinor != wantAmount || cell.Multiplier != award.Multiplier ||
			cell.Prize != award.Prize {
			return errors.New("outcome: final King Spin Vault award does not match its upgrade chain")
		}
	}
	return nil
}

func validateRageAndWheelEvents(input SpinInput, outcome SpinOutcome) error {
	surge := eventIndexes(outcome.Events, "surge.collected")
	transformed := eventIndexes(outcome.Events, "rage.transformed")
	wheelStarted := eventIndexes(outcome.Events, "wheel.started")
	wheelAwarded := eventIndexes(outcome.Events, "wheel.awarded")
	freeStarted := eventIndexes(outcome.Events, "free_spins.started")
	if input.Feature.Active() {
		if len(positionsForSymbol(outcome.Grid, SymbolSurge)) != 0 || len(surge)+len(transformed)+
			len(wheelStarted)+len(wheelAwarded)+len(freeStarted) != 0 {
			return errors.New("outcome: Rage and wheel events are base-game only")
		}
		return nil
	}

	positions := positionsForSymbol(outcome.Grid, SymbolSurge)
	if len(positions) == 0 {
		if len(surge)+len(transformed)+len(wheelStarted)+len(wheelAwarded)+len(freeStarted) != 0 {
			return errors.New("outcome: Rage or wheel event exists without settled Rage")
		}
		if outcome.NextFeature.RageCollected != input.Feature.RageCollected ||
			outcome.NextFeature.RageLevel != input.Feature.RageLevel {
			return errors.New("outcome: empty base spin changed the Rage meter")
		}
		return nil
	}
	if len(positions) > 3 {
		return errors.New("outcome: more than three settled Rage symbols")
	}
	if len(surge) != 1 {
		return errors.New("outcome: settled Rage requires exactly one surge.collected event")
	}
	collection := outcome.Events[surge[0]]
	creditedTotal := input.Feature.RageCollected
	if len(positions) < 3 {
		if input.Feature.RageCollected > MaxRageCollected-len(positions) {
			return errors.New("outcome: Rage meter exceeds the protocol limit")
		}
		creditedTotal += len(positions)
	}
	if collection.Count != len(positions) || !samePositions(collection.Cells, positions) ||
		collection.Guaranteed != (len(positions) == 3) ||
		collection.Level < DefaultRageLevel || (len(positions) == 3 && !collection.Triggered) {
		return errors.New("outcome: surge.collected does not match the settled Rage set")
	}
	if len(positions) == 3 &&
		(collection.Level != input.Feature.RageLevel || collection.Total != input.Feature.RageCollected) {
		return errors.New("outcome: guaranteed Rage trigger changed the request-origin PPS snapshot")
	}
	if len(positions) < 3 && collection.Triggered &&
		(collection.Level != DefaultRageLevel || collection.Total != 0) {
		return errors.New("outcome: triggered PPS collection did not carry the reset snapshot")
	}
	if len(positions) < 3 && !collection.Triggered && collection.Total != creditedTotal {
		return errors.New("outcome: failed Rage collection did not carry the credited PPS snapshot")
	}
	if !collection.Triggered {
		if len(transformed)+len(wheelStarted)+len(wheelAwarded)+len(freeStarted) != 0 {
			return errors.New("outcome: failed Rage collection changed the wheel or meter state")
		}
		if outcome.NextFeature.RageCollected != creditedTotal ||
			outcome.NextFeature.RageLevel != collection.Level {
			return errors.New("outcome: failed Rage collection did not preserve the credited PPS meter")
		}
		return nil
	}
	if len(wheelStarted) != 1 || len(wheelAwarded) != 1 ||
		wheelStarted[0] <= surge[0] || wheelAwarded[0] <= wheelStarted[0] {
		return errors.New("outcome: triggered Rage requires an ordered wheel start and award")
	}
	if len(positions) < 3 {
		if len(transformed) != 1 || transformed[0] <= surge[0] || transformed[0] >= wheelStarted[0] {
			return errors.New("outcome: one/two-Rage trigger requires a transformation before the wheel")
		}
		event := outcome.Events[transformed[0]]
		if event.Count != 3-len(positions) || len(event.Cells) != event.Count ||
			event.Level != collection.Level || event.Total != collection.Total {
			return errors.New("outcome: Rage transformation count is invalid")
		}
		for _, position := range event.Cells {
			if containsPosition(positions, position) {
				return errors.New("outcome: Rage transformation overlaps a settled Rage")
			}
		}
		if outcome.NextFeature.RageLevel != DefaultRageLevel ||
			outcome.NextFeature.RageCollected != 0 {
			return errors.New("outcome: triggered PPS Wheel did not reset the final Rage meter")
		}
	} else if len(transformed) != 0 {
		return errors.New("outcome: guaranteed Rage trigger must not add symbols")
	} else if outcome.NextFeature.RageLevel != input.Feature.RageLevel ||
		outcome.NextFeature.RageCollected != input.Feature.RageCollected {
		return errors.New("outcome: guaranteed Rage trigger changed the request-origin PPS meter")
	}
	award := outcome.Events[wheelAwarded[0]]
	switch award.Outcome {
	case string(WheelInstant):
		wantAmount, err := safeMul(input.BetMinor, award.Multiplier)
		if err != nil {
			return err
		}
		if outcome.NextFeature.Active() || len(freeStarted) != 0 || award.Prize == "" ||
			award.Prize != vaultPrizeName(award.Multiplier, false) ||
			award.Multiplier <= 0 || award.AmountMinor != wantAmount {
			return errors.New("outcome: invalid instant wheel award")
		}
	case string(WheelExpansion), string(WheelOverdrive):
		mode := FeatureMode(award.Outcome)
		if !outcome.NextFeature.Active() || outcome.NextFeature.Mode != mode ||
			award.Multiplier != 0 || award.AmountMinor != 0 || len(freeStarted) != 1 ||
			freeStarted[0] <= wheelAwarded[0] {
			return errors.New("outcome: invalid feature wheel award")
		}
		started := outcome.Events[freeStarted[0]]
		if started.Mode != mode || started.Awarded != 8 ||
			started.Awarded != outcome.NextFeature.Awarded ||
			outcome.NextFeature.Remaining != outcome.NextFeature.Awarded {
			return errors.New("outcome: Free Spins start does not match next feature state")
		}
	default:
		return errors.New("outcome: unknown wheel award kind")
	}
	return nil
}

func validateFeatureCompletion(input SpinInput, outcome SpinOutcome) error {
	completed := eventIndexes(outcome.Events, "free_spins.completed")
	if !input.Feature.Active() {
		if len(completed) != 0 {
			return errors.New("outcome: base spin cannot complete Free Spins")
		}
		if outcome.NextFeature.Active() && outcome.NextFeature.WinMinor != 0 {
			return errors.New("outcome: newly started Free Spins must have a zero running win")
		}
		return nil
	}
	wantWin, err := addOutcomeMoney(input.Feature.WinMinor, outcome.TotalWinMinor)
	if err != nil {
		return err
	}
	wantRemaining := input.Feature.Remaining - 1
	wantAwarded := input.Feature.Awarded
	for _, event := range outcome.Events {
		if event.Type != "free_spin.awarded" {
			continue
		}
		if event.Count <= 0 || wantRemaining > MaxFeatureSpins-event.Count ||
			wantAwarded > MaxFeatureSpins-event.Count {
			return errors.New("outcome: Free Spin award counters overflow")
		}
		wantRemaining += event.Count
		wantAwarded += event.Count
	}
	if outcome.NextFeature.RageLevel != input.Feature.RageLevel ||
		outcome.NextFeature.RageCollected != input.Feature.RageCollected {
		return errors.New("outcome: Free Spin changed the persistent Rage meter")
	}
	if outcome.NextFeature.Active() {
		if len(completed) != 0 || outcome.NextFeature.Mode != input.Feature.Mode ||
			outcome.NextFeature.BetMinor != input.Feature.BetMinor || outcome.NextFeature.WinMinor != wantWin ||
			wantRemaining < 1 || outcome.NextFeature.Remaining != wantRemaining ||
			outcome.NextFeature.Awarded != wantAwarded {
			return errors.New("outcome: active Free Spins recovery state is inconsistent")
		}
		return nil
	}
	if wantRemaining != 0 || len(completed) != 1 || completed[0] != len(outcome.Events)-1 {
		return errors.New("outcome: the last Free Spin requires one final completion event")
	}
	event := outcome.Events[completed[0]]
	if event.Mode != input.Feature.Mode || event.Awarded != wantAwarded ||
		event.CumulativeWinMinor != wantWin {
		return errors.New("outcome: Free Spins completion does not match recovered state")
	}
	return nil
}

func eventIndexes(events []Event, eventType string) []int {
	indexes := make([]int, 0, 1)
	for index, event := range events {
		if event.Type == eventType {
			indexes = append(indexes, index)
		}
	}
	return indexes
}

func validVaultGroupEvent(event Event, positions []Position) bool {
	return event.Count == len(positions) && samePositions(event.Cells, positions)
}

func samePositions(left, right []Position) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func containsPosition(positions []Position, target Position) bool {
	for _, position := range positions {
		if position == target {
			return true
		}
	}
	return false
}

func isVaultSemanticEvent(eventType string) bool {
	switch eventType {
	case "vaults.landed", "vaults.locked", "vaults.unlock.started", "vaults.unlock.completed",
		"vault.unlocked", "vault.awarded", "vaults.upgrade.started", "vault.upgraded",
		"free_spin.awarded", "free_spin.cap_reached":
		return true
	default:
		return false
	}
}

func addOutcomeMoney(left, right int64) (int64, error) {
	if left < 0 || right < 0 || left > math.MaxInt64-right {
		return 0, errors.New("outcome: award total overflows int64")
	}
	return left + right, nil
}

func isPayingSymbol(symbol Symbol) bool {
	for _, candidate := range PayingSymbols {
		if symbol == candidate {
			return true
		}
	}
	return false
}
