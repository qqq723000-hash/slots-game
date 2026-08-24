package rgsapi

import (
	"strconv"
	"time"

	"slots-game/server/internal/game"
	"slots-game/server/internal/rgs"
)

func makeSessionResponse(session rgs.Session) sessionResponse {
	return sessionResponse{
		OperatorID: session.OperatorID, SessionID: session.SessionID,
		GameID: session.GameID, DefinitionVersion: session.DefinitionVersion,
		DefinitionHash: session.DefinitionHash, Currency: session.Currency,
		CurrencyExponent: session.CurrencyExponent, Jurisdiction: session.Jurisdiction,
		Status: session.Status, ExpiresAt: formatTime(session.ExpiresAt),
		IdleDisconnectAt: formatTime(session.IdleDisconnectAt),
		BalanceMinor:     strconv.FormatInt(session.BalanceMinor, 10),
		Revision:         strconv.FormatUint(session.Revision, 10),
		Sequence:         strconv.FormatUint(session.Sequence, 10),
		Feature:          makeFeatureStateResponse(session.Feature),
	}
}

func makeSpinResultResponse(result rgs.SpinResult) (spinResultResponse, error) {
	resultHash, err := rgs.CommittedResultHashFor(result)
	if err != nil {
		return spinResultResponse{}, err
	}
	wins := make([]winResponse, len(result.Wins))
	for index, win := range result.Wins {
		cells := make([]game.Position, len(win.Cells))
		copy(cells, win.Cells)
		pathAwards := make([]pathAwardResponse, len(win.PathAwards))
		for pathIndex, award := range win.PathAwards {
			pathCells := make([]game.Position, len(award.Cells))
			copy(pathCells, award.Cells)
			pathAwards[pathIndex] = pathAwardResponse{
				Cells: pathCells, Multiplier: strconv.FormatInt(award.Multiplier, 10),
				BaseAmountMinor: strconv.FormatInt(award.BaseAmountMinor, 10),
				AmountMinor:     strconv.FormatInt(award.AmountMinor, 10),
			}
		}
		wins[index] = winResponse{
			ID: win.ID, Symbol: win.Symbol, Ways: win.Ways,
			AmountMinor: strconv.FormatInt(win.AmountMinor, 10),
			Cells:       cells, PathAwards: pathAwards,
		}
		if multiplier, uniform := win.UniformPathMultiplier(); uniform {
			wins[index].Multiplier = strconv.FormatInt(multiplier, 10)
		}
	}
	events := make([]eventResponse, len(result.Events))
	for index, event := range result.Events {
		cells := make([]game.Position, len(event.Cells))
		copy(cells, event.Cells)
		mode := event.Mode
		if mode == "" {
			mode = game.FeatureNone
		}
		events[index] = eventResponse{
			Type: event.Type, Count: event.Count,
			Cells:     cells,
			Triggered: event.Triggered, Guaranteed: event.Guaranteed,
			Outcome: event.Outcome, Prize: event.Prize, Multiplier: strconv.FormatInt(event.Multiplier, 10),
			AmountMinor:        strconv.FormatInt(event.AmountMinor, 10),
			CumulativeWinMinor: strconv.FormatInt(event.CumulativeWinMinor, 10), Mode: mode,
			Awarded: event.Awarded, Rows: event.Rows, Ways: event.Ways,
			Reel: event.Reel, Row: event.Row, Level: event.Level, Total: event.Total, Step: event.Step,
			FromMultiplier: strconv.FormatInt(event.FromMultiplier, 10),
			ToMultiplier:   strconv.FormatInt(event.ToMultiplier, 10),
		}
	}
	grid := make(game.Grid, len(result.Grid))
	for reel := range result.Grid {
		grid[reel] = make([]game.Cell, len(result.Grid[reel]))
		copy(grid[reel], result.Grid[reel])
	}
	response := spinResultResponse{
		OperatorID: result.OperatorID, SessionID: result.SessionID,
		RoundID: result.RoundID, GameID: result.GameID,
		DefinitionVersion: result.DefinitionVersion, DefinitionHash: result.DefinitionHash,
		Currency: result.Currency, RoundKind: result.RoundKind,
		ServerTransactionID: result.ServerTransactionID,
		WalletTransactionID: result.WalletTransactionID,
		StartRevision:       strconv.FormatUint(result.StartRevision, 10),
		EndRevision:         strconv.FormatUint(result.EndRevision, 10),
		Sequence:            strconv.FormatUint(result.Sequence, 10),
		ResultHash:          resultHash,
		BetMinor:            strconv.FormatInt(result.BetMinor, 10),
		ChargedBetMinor:     strconv.FormatInt(result.ChargedBetMinor, 10),
		BalanceMinor:        strconv.FormatInt(result.BalanceMinor, 10),
		TotalWinMinor:       strconv.FormatInt(result.TotalWinMinor, 10),
		Grid:                grid, Wins: wins, Events: events,
		Feature: makeFeatureStateResponse(result.FeatureState),
	}
	if !result.IdleDisconnectAt.IsZero() {
		response.IdleDisconnectAt = formatTime(result.IdleDisconnectAt)
	}
	return response, nil
}

func makeFeatureStateResponse(feature game.FeatureState) featureStateResponse {
	mode := feature.Mode
	if mode == "" {
		mode = game.FeatureNone
	}
	return featureStateResponse{
		Mode: mode, Remaining: feature.Remaining, Awarded: feature.Awarded,
		BetMinor:  strconv.FormatInt(feature.BetMinor, 10),
		WinMinor:  strconv.FormatInt(feature.WinMinor, 10),
		RageLevel: feature.RageLevel, RageCollected: feature.RageCollected,
	}
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}
