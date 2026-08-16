package rgs

import "context"

// WalletRound 是一项原子经济指令。生产钱包适配器必须以原子方式应用扣款与入账，
// 并强制执行 OperationID 幂等性：相同操作及指纹返回原始回执，使用不同字段复用则为硬冲突。
type WalletRound struct {
	OperationID       string
	Fingerprint       string
	OperatorID        string
	PlayerID          string
	WalletAccountID   string
	SessionID         string
	RoundID           string
	GameID            string
	DefinitionVersion string
	DefinitionHash    string
	RoundKind         RoundKind
	Currency          string
	DebitMinor        int64
	CreditMinor       int64
}

type WalletReceipt struct {
	OperationID   string
	Fingerprint   string
	TransactionID string
	OperatorID    string
	Currency      string
	DebitMinor    int64
	CreditMinor   int64
	BalanceMinor  int64
}

type WalletRollback struct {
	RollbackID  string
	OperationID string
	OperatorID  string
	Reason      string
}

// WalletPort 刻意公开 Lookup。钱包已提交后的传输超时不代表拒绝；协调器会按操作标识解析结果。
// Rollback 本身按 RollbackID 幂等，仅供明确的对账或运维流程使用，绝不能作为超时后的自动响应。
type WalletPort interface {
	ApplyRound(context.Context, WalletRound) (WalletReceipt, error)
	Lookup(context.Context, string, string) (WalletReceipt, bool, error)
	Rollback(context.Context, WalletRollback) (WalletReceipt, error)
}
