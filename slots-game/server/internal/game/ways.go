package game

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// EvaluateWays 是纯三列连线求值器。它展开每条具体路径，使不同倍数的 WILD 格只作用于
// 实际经过该格的路径，然后按赔付符号聚合路径。
func EvaluateWays(grid Grid, paytable map[Symbol]int64, unitMinor int64) ([]Win, int64, error) {
	if len(grid) != 3 {
		return nil, 0, fmt.Errorf("ways: expected 3 reels, got %d", len(grid))
	}
	if unitMinor <= 0 {
		return nil, 0, errors.New("ways: unit must be positive")
	}
	rows := len(grid[0])
	if rows < 3 || rows > 8 {
		return nil, 0, fmt.Errorf("ways: row count must be in [3,8], got %d", rows)
	}
	for reel, cells := range grid {
		if len(cells) != rows {
			return nil, 0, fmt.Errorf("ways: reel %d has %d rows, want %d", reel, len(cells), rows)
		}
		for row, cell := range cells {
			if !IsKnownSymbol(cell.Symbol) {
				return nil, 0, fmt.Errorf("ways: unknown symbol at %d,%d", reel, row)
			}
			if reel != 1 && (cell.Symbol == SymbolWild || cell.Symbol == SymbolVault) {
				return nil, 0, fmt.Errorf("ways: %s at %d,%d is outside the middle reel", cell.Symbol, reel, row)
			}
			if err := validateCellModifier(cell); err != nil {
				return nil, 0, fmt.Errorf("ways: invalid cell at %d,%d: %w", reel, row, err)
			}
		}
	}

	wins := make([]Win, 0, len(PayingSymbols))
	var total int64
	for _, target := range PayingSymbols {
		pay := paytable[target]
		if pay <= 0 {
			return nil, 0, fmt.Errorf("ways: invalid paytable value for %s", target)
		}

		matches := [3][]int{}
		for reel := range 3 {
			for row, cell := range grid[reel] {
				if cell.Symbol == target || cell.Symbol == SymbolWild {
					matches[reel] = append(matches[reel], row)
				}
			}
		}
		if len(matches[0]) == 0 || len(matches[1]) == 0 || len(matches[2]) == 0 {
			continue
		}

		base, err := safeMul(pay, unitMinor)
		if err != nil {
			return nil, 0, fmt.Errorf("ways: %s base award: %w", target, err)
		}
		cellSet := make(map[Position]struct{})
		pathAwards := make([]PathAward, 0, len(matches[0])*len(matches[1])*len(matches[2]))
		wayCount := 0
		var amount int64
		for _, row0 := range matches[0] {
			for _, row1 := range matches[1] {
				for _, row2 := range matches[2] {
					rows := [3]int{row0, row1, row2}
					pathMultiplier := int64(1)
					for reel, row := range rows {
						cell := grid[reel][row]
						if cell.Symbol == SymbolWild {
							wildMultiplier := cell.Multiplier
							if wildMultiplier == 0 {
								wildMultiplier = 1
							}
							pathMultiplier, err = safeMul(pathMultiplier, wildMultiplier)
							if err != nil {
								return nil, 0, fmt.Errorf("ways: %s path multiplier: %w", target, err)
							}
						}
						cellSet[Position{Reel: reel, Row: row}] = struct{}{}
					}
					pathAmount, mulErr := safeMul(base, pathMultiplier)
					if mulErr != nil {
						return nil, 0, fmt.Errorf("ways: %s path award: %w", target, mulErr)
					}
					amount, err = safeAdd(amount, pathAmount)
					if err != nil {
						return nil, 0, fmt.Errorf("ways: %s aggregate award: %w", target, err)
					}
					pathAwards = append(pathAwards, PathAward{
						Cells: []Position{
							{Reel: 0, Row: row0},
							{Reel: 1, Row: row1},
							{Reel: 2, Row: row2},
						},
						Multiplier:      pathMultiplier,
						BaseAmountMinor: base,
						AmountMinor:     pathAmount,
					})
					wayCount++
				}
			}
		}

		cells := make([]Position, 0, len(cellSet))
		for position := range cellSet {
			cells = append(cells, position)
		}
		sort.Slice(cells, func(i, j int) bool {
			if cells[i].Reel != cells[j].Reel {
				return cells[i].Reel < cells[j].Reel
			}
			return cells[i].Row < cells[j].Row
		})
		win := Win{
			ID:          strings.ToLower(string(target)) + "-3",
			Symbol:      target,
			Ways:        wayCount,
			AmountMinor: amount,
			Cells:       cells,
			PathAwards:  pathAwards,
		}
		wins = append(wins, win)
		total, err = safeAdd(total, amount)
		if err != nil {
			return nil, 0, fmt.Errorf("ways: total award: %w", err)
		}
	}
	return wins, total, nil
}

// EvaluateWaysForBet 将已编制赔付表从参考投注缩放到所选投注。奖励取整到最近的最小货币单位；
// 即使采用最小投注，具体的正数连线奖励也绝不会呈现为零值奖励。
func EvaluateWaysForBet(
	grid Grid,
	paytable map[Symbol]int64,
	betMinor int64,
	payUnitMinor int64,
) ([]Win, int64, error) {
	if betMinor <= 0 || payUnitMinor <= 0 {
		return nil, 0, errors.New("ways: bet and pay unit must be positive")
	}
	wins, _, err := EvaluateWays(grid, paytable, 1)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	for index := range wins {
		scaled, scaleErr := scaleWaysAward(wins[index].AmountMinor, betMinor, payUnitMinor)
		if scaleErr != nil {
			return nil, 0, fmt.Errorf("ways: %s scaled award: %w", wins[index].Symbol, scaleErr)
		}
		if scaleErr := scalePathAwards(wins[index].PathAwards, scaled, betMinor, payUnitMinor); scaleErr != nil {
			return nil, 0, fmt.Errorf("ways: %s scaled paths: %w", wins[index].Symbol, scaleErr)
		}
		wins[index].AmountMinor = scaled
		total, err = safeAdd(total, scaled)
		if err != nil {
			return nil, 0, fmt.Errorf("ways: total scaled award: %w", err)
		}
	}
	return wins, total, nil
}

// scalePathAwards 在不改变旧版聚合值的前提下，将已取整的聚合奖励分配到具体路径。
// 它先取每条路径的精确下限值，再按小数余数从大到小分配剩余最小货币单位。
// 余数相同时保留求值器的路径顺序，使低额投注取整具有确定性且可安全重放。
func scalePathAwards(
	paths []PathAward,
	aggregateMinor int64,
	betMinor int64,
	payUnitMinor int64,
) error {
	type remainderRecord struct {
		index     int
		remainder int64
	}
	remainders := make([]remainderRecord, len(paths))
	var floorTotal int64
	for index := range paths {
		numerator, err := safeMul(paths[index].AmountMinor, betMinor)
		if err != nil {
			return err
		}
		paths[index].AmountMinor = numerator / payUnitMinor
		floorTotal, err = safeAdd(floorTotal, paths[index].AmountMinor)
		if err != nil {
			return err
		}
		remainders[index] = remainderRecord{index: index, remainder: numerator % payUnitMinor}
	}
	if floorTotal > aggregateMinor {
		return errors.New("path floors exceed the aggregate award")
	}
	remaining := aggregateMinor - floorTotal
	if remaining > int64(len(paths)) {
		return errors.New("aggregate rounding cannot be distributed across paths")
	}
	sort.SliceStable(remainders, func(i, j int) bool {
		return remainders[i].remainder > remainders[j].remainder
	})
	for index := int64(0); index < remaining; index++ {
		pathIndex := remainders[index].index
		paths[pathIndex].AmountMinor++
	}
	for index := range paths {
		// BaseAmountMinor 是服务器独立解析出的展示事实。应直接缩放并取整未乘倍数的路径值，
		// 不得通过结算金额除法反推；按最大余数分配聚合金额时，这种除法在小额投注下会丢失精度。
		baseAmount, err := scaleWaysAward(
			paths[index].BaseAmountMinor,
			betMinor,
			payUnitMinor,
		)
		if err != nil {
			return err
		}
		if paths[index].AmountMinor == 0 {
			baseAmount = 0
		}
		if paths[index].Multiplier == 1 {
			baseAmount = paths[index].AmountMinor
		}
		paths[index].BaseAmountMinor = baseAmount
	}
	return nil
}

func scaleWaysAward(amountMinor, betMinor, payUnitMinor int64) (int64, error) {
	numerator, err := safeMul(amountMinor, betMinor)
	if err != nil {
		return 0, err
	}
	quotient := numerator / payUnitMinor
	remainder := numerator % payUnitMinor
	if remainder >= payUnitMinor-remainder {
		if quotient == math.MaxInt64 {
			return 0, errors.New("int64 overflow")
		}
		quotient++
	}
	if amountMinor > 0 && quotient == 0 {
		return 1, nil
	}
	return quotient, nil
}

func safeAdd(a, b int64) (int64, error) {
	if a < 0 || b < 0 {
		return 0, errors.New("negative money is not allowed")
	}
	if a > math.MaxInt64-b {
		return 0, errors.New("int64 overflow")
	}
	return a + b, nil
}

func safeMul(a, b int64) (int64, error) {
	if a < 0 || b < 0 {
		return 0, errors.New("negative money is not allowed")
	}
	if a != 0 && b > math.MaxInt64/a {
		return 0, errors.New("int64 overflow")
	}
	return a * b, nil
}
