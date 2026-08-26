package rgs

import "errors"

// ResultSchemaPaidFactsV1 将名义数学奖励与应用已签名整场最高赢取上限后
// 实际结算的金额分别保存。
const ResultSchemaPaidFactsV1 = "rgs-spin-result-paid-facts-v1"

// NormalizePersistedSpinResult 会升级内存中的历史结果，但不改变其不可变的
// 旧版哈希投影。历史引擎存储的 AmountMinor 已应用上限，因此 paid=nominal
// 是唯一有效的解释。
func NormalizePersistedSpinResult(result *SpinResult) error {
	if result == nil {
		return errors.New("rgs: nil persisted result")
	}
	switch result.ResultSchemaVersion {
	case "":
		for winIndex := range result.Wins {
			result.Wins[winIndex].PaidAmountMinor = result.Wins[winIndex].AmountMinor
			for pathIndex := range result.Wins[winIndex].PathAwards {
				award := &result.Wins[winIndex].PathAwards[pathIndex]
				award.PaidAmountMinor = award.AmountMinor
			}
		}
		return nil
	case ResultSchemaPaidFactsV1:
		return nil
	default:
		return errors.New("rgs: unsupported persisted result schema")
	}
}
