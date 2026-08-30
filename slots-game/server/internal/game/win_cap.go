package game

import (
	"errors"
	"fmt"
)

// applyWinCap 将原始数学结果投影到权威的整场赔付预算。
// 触发时的基础旋转及其启动的所有免费旋转共享 FeatureState.WinMinor，
// 因而恢复时无需参考浏览器状态即可继续使用精确的剩余预算。
// English: applyWinCap projects raw mathematical results to authoritative full-game payout budgets. The base spin
// when triggered and all the free spins it launched share FeatureState.WinMinor, so the exact remaining budget can
// continue to be used without reference to the browser state when resumed.
func applyWinCap(config Config, input SpinInput, outcome *SpinOutcome) error {
	if outcome == nil || outcome.TotalWinMinor < 0 {
		return errors.New("win cap: invalid outcome")
	}
	input.Feature = canonicalFeatureState(input.Feature)
	capMinor, err := safeMul(input.BetMinor, config.MaxWinMultiplier)
	if err != nil {
		return fmt.Errorf("win cap: calculate cap: %w", err)
	}
	priorWin := int64(0)
	if input.Feature.Active() {
		priorWin = input.Feature.WinMinor
	}
	if priorWin < 0 || priorWin > capMinor {
		return errors.New("win cap: recovered game win exceeds the definition cap")
	}

	rawTotal := outcome.TotalWinMinor
	remaining := capMinor - priorWin
	projectedWins, waysPaid := projectWinsToBudget(outcome.Wins, remaining)
	outcome.Wins = projectedWins
	remaining -= waysPaid
	totalPaid := waysPaid

	for index := range outcome.Events {
		if !isMonetaryAwardEvent(outcome.Events[index].Type) {
			continue
		}
		rawAmount := outcome.Events[index].AmountMinor
		paid := minInt64(rawAmount, remaining)
		outcome.Events[index].AmountMinor = paid
		remaining -= paid
		totalPaid, err = safeAdd(totalPaid, paid)
		if err != nil {
			return fmt.Errorf("win cap: total paid: %w", err)
		}
	}
	outcome.TotalWinMinor = totalPaid
	cycleWin, err := safeAdd(priorWin, totalPaid)
	if err != nil {
		return fmt.Errorf("win cap: cycle win: %w", err)
	}

	// 对被裁剪结果和恰好达到上限的结果都发出边界事件。若恢复后的游戏已达到上限，
	// 之后出现原始奖励时会再次发出事件，使该结果中支付为零的奖励仍具有明确解释。
	// Emit the boundary event for both clipped results and results that exactly reach the cap. If a recovered game has already reached the cap,
	// a later raw award emits it again so the zero-paid award in that result remains explicitly explained.
	if rawTotal > 0 && rawTotal >= capMinor-priorWin {
		outcome.Events = append(outcome.Events, Event{
			Type:               "win_cap.reached",
			Multiplier:         config.MaxWinMultiplier,
			CumulativeWinMinor: capMinor,
		})
	}

	if input.Feature.Active() {
		if outcome.NextFeature.Remaining == 0 {
			outcome.Events = append(outcome.Events, Event{
				Type: "free_spins.completed", Mode: input.Feature.Mode,
				Awarded: outcome.NextFeature.Awarded, CumulativeWinMinor: cycleWin,
			})
			outcome.NextFeature = outcome.NextFeature.WithoutFreeSpins()
		} else {
			outcome.NextFeature.WinMinor = cycleWin
		}
	} else if outcome.NextFeature.Active() {
		// 新触发的功能会继承基础旋转的已支付结果。因此上限覆盖整个触发游戏，
		// 而不只覆盖随后不收费的旋转。
		// A newly triggered feature inherits the base spin's paid result. The cap therefore covers the entire triggered game,
		// not only the subsequent no-charge spins.
		outcome.NextFeature.WinMinor = totalPaid
	}
	return nil
}

func projectWinsToBudget(wins []Win, budget int64) ([]Win, int64) {
	if len(wins) == 0 {
		return nil, 0
	}
	projected := make([]Win, 0, len(wins))
	remaining := budget
	for _, win := range wins {
		paid := minInt64(win.AmountMinor, remaining)
		projected = append(projected, projectWinToAmount(win, paid))
		remaining -= paid
	}
	return projected, budget - remaining
}

func projectWinToAmount(win Win, amount int64) Win {
	projected := win
	projected.PaidAmountMinor = amount
	projected.PathAwards = make([]PathAward, 0, len(win.PathAwards))
	remaining := amount
	for _, award := range win.PathAwards {
		paid := minInt64(award.AmountMinor, remaining)
		award.PaidAmountMinor = paid
		projected.PathAwards = append(projected.PathAwards, award)
		remaining -= paid
	}
	return projected
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

// validateCappedAwardsAgainstConfig 会重新计算未设上限的数学奖励及其确定性上限投影。
// 它是感知定义的信任边界，可同时防止超额赔付和无法解释的少付。
// English: validateCappedAwardsAgainstConfig recalculates uncapped mathematical rewards and their deterministic
// capped projection. It is a perceptually defined trust boundary that protects against both overpayments and
// unexplained underpayments.
func validateCappedAwardsAgainstConfig(
	config Config,
	input SpinInput,
	outcome SpinOutcome,
	rawWins []Win,
	rawWaysAward int64,
) error {
	input.Feature = canonicalFeatureState(input.Feature)
	capMinor, err := safeMul(input.BetMinor, config.MaxWinMultiplier)
	if err != nil {
		return fmt.Errorf("outcome: max win: %w", err)
	}
	priorWin := int64(0)
	if input.Feature.Active() {
		priorWin = input.Feature.WinMinor
	}
	if priorWin < 0 || priorWin > capMinor {
		return errors.New("outcome: recovered game win exceeds the definition cap")
	}
	initialBudget := capMinor - priorWin
	expectedWins, waysPaid := projectWinsToBudget(rawWins, initialBudget)
	if !sameWins(expectedWins, outcome.Wins) {
		return errors.New("outcome: capped Ways wins do not match the authoritative grid and definition")
	}
	remaining := initialBudget - waysPaid
	expectedTotal := waysPaid
	rawTotal := rawWaysAward
	for _, event := range outcome.Events {
		nominal, monetary, nominalErr := nominalEventAward(input.BetMinor, event)
		if nominalErr != nil {
			return nominalErr
		}
		if !monetary {
			continue
		}
		expected := minInt64(nominal, remaining)
		if event.AmountMinor != expected {
			return errors.New("outcome: monetary event does not match the remaining max-win budget")
		}
		remaining -= expected
		expectedTotal, err = safeAdd(expectedTotal, expected)
		if err != nil {
			return err
		}
		rawTotal, err = safeAdd(rawTotal, nominal)
		if err != nil {
			return err
		}
	}
	if outcome.TotalWinMinor != expectedTotal {
		return errors.New("outcome: total win does not match the authoritative max-win projection")
	}
	wantCapEvent := rawTotal > 0 && rawTotal >= initialBudget
	capEvents := eventIndexes(outcome.Events, "win_cap.reached")
	if wantCapEvent != (len(capEvents) == 1) {
		return errors.New("outcome: win cap boundary event does not match the mathematical result")
	}
	if wantCapEvent {
		event := outcome.Events[capEvents[0]]
		if event.Multiplier != config.MaxWinMultiplier || event.CumulativeWinMinor != capMinor {
			return errors.New("outcome: win cap event does not match the immutable definition")
		}
	}
	return nil
}

func nominalEventAward(betMinor int64, event Event) (int64, bool, error) {
	switch event.Type {
	case "vault.awarded":
		amount, err := safeMul(betMinor, event.Multiplier)
		return amount, true, err
	case "wheel.awarded":
		if event.Outcome != string(WheelInstant) {
			return 0, false, nil
		}
		amount, err := safeMul(betMinor, event.Multiplier)
		return amount, true, err
	default:
		return 0, false, nil
	}
}
