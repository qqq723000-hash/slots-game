package rgs

import "slots-game/server/internal/game"

func cloneSpinResult(result SpinResult) SpinResult {
	result.Grid = cloneGrid(result.Grid)
	result.Wins = append([]game.Win(nil), result.Wins...)
	for index := range result.Wins {
		result.Wins[index].Cells = append([]game.Position(nil), result.Wins[index].Cells...)
		result.Wins[index].PathAwards = append([]game.PathAward(nil), result.Wins[index].PathAwards...)
		for pathIndex := range result.Wins[index].PathAwards {
			result.Wins[index].PathAwards[pathIndex].Cells = append(
				[]game.Position(nil), result.Wins[index].PathAwards[pathIndex].Cells...,
			)
		}
	}
	result.Events = append([]game.Event(nil), result.Events...)
	for index := range result.Events {
		result.Events[index].Cells = append([]game.Position(nil), result.Events[index].Cells...)
	}
	return result
}

func cloneGrid(grid game.Grid) game.Grid {
	copyGrid := make(game.Grid, len(grid))
	for reel, cells := range grid {
		copyGrid[reel] = append([]game.Cell(nil), cells...)
	}
	return copyGrid
}

func cloneRound(record RoundRecord) RoundRecord {
	record.Result = cloneSpinResult(record.Result)
	if record.WalletReceipt != nil {
		receipt := *record.WalletReceipt
		record.WalletReceipt = &receipt
	}
	return record
}
