package rgs

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"strconv"

	"slots-game/server/internal/game"
)

// FingerprintFor 返回规范的 v2 经济请求指纹。带标签及长度前缀的值使编码无歧义，
// 并防止未来模式版本意外与 v1 冲突。
func FingerprintFor(request SpinRequest) string {
	digest := sha256.New()
	writeFingerprintField(digest, "schema", "rgs-round-fingerprint-v2")
	writeFingerprintField(digest, "operator", request.OperatorID)
	writeFingerprintField(digest, "session", request.SessionID)
	writeFingerprintField(digest, "round", request.RoundID)
	writeFingerprintField(digest, "game", request.GameID)
	writeFingerprintField(digest, "definition", request.DefinitionVersion)
	writeFingerprintField(digest, "definitionHash", request.DefinitionHash)
	writeFingerprintField(digest, "currency", request.Currency)
	writeFingerprintField(digest, "roundKind", string(request.RoundKind))
	writeFingerprintField(digest, "betMinor", strconv.FormatInt(request.BetMinor, 10))
	writeFingerprintField(digest, "startRevision", strconv.FormatUint(request.StartRevision, 10))
	return "rgs-fp-v2:" + hex.EncodeToString(digest.Sum(nil))
}

// OutcomeHashFor 标识完整的规范预备结果。它会在产生任何钱包副作用前随轮次持久化，
// 并可在重放、导出和审计时进行比较。
func OutcomeHashFor(result SpinResult) (string, error) {
	var value any = result
	switch result.ResultSchemaVersion {
	case "":
		value = makeLegacySpinResultHashProjection(result)
	case ResultSchemaPaidFactsV1:
	default:
		return "", fmt.Errorf("rgs: unsupported result schema %q", result.ResultSchemaVersion)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("rgs: encode canonical outcome: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// legacySpinResultHashProjection 是引入已支付奖励事实和 ResultSchemaVersion
// 之前使用的精确表示。历史哈希不可变：升级会先校验此投影，再在内存中补全
// paid=nominal，用于展示和结构检查，且不会重写经济身份。
type legacySpinResultHashProjection struct {
	OperatorID          string
	SessionID           string
	RoundID             string
	GameID              string
	DefinitionVersion   string
	DefinitionHash      string
	Currency            string
	RoundKind           RoundKind
	ServerTransactionID string
	WalletTransactionID string
	StartRevision       uint64
	EndRevision         uint64
	Sequence            uint64
	BetMinor            int64
	ChargedBetMinor     int64
	BalanceMinor        int64
	TotalWinMinor       int64
	Grid                game.Grid
	Wins                []legacyWinHashProjection
	Events              []game.Event
	FeatureState        game.FeatureState
}

type legacyWinHashProjection struct {
	ID          string
	Symbol      game.Symbol
	Ways        int
	AmountMinor int64
	Cells       []game.Position
	PathAwards  []legacyPathAwardHashProjection
}

type legacyPathAwardHashProjection struct {
	Cells           []game.Position
	Multiplier      int64
	BaseAmountMinor int64
	AmountMinor     int64
}

func makeLegacySpinResultHashProjection(result SpinResult) legacySpinResultHashProjection {
	projection := legacySpinResultHashProjection{
		OperatorID: result.OperatorID, SessionID: result.SessionID, RoundID: result.RoundID,
		GameID: result.GameID, DefinitionVersion: result.DefinitionVersion,
		DefinitionHash: result.DefinitionHash, Currency: result.Currency, RoundKind: result.RoundKind,
		ServerTransactionID: result.ServerTransactionID, WalletTransactionID: result.WalletTransactionID,
		StartRevision: result.StartRevision, EndRevision: result.EndRevision, Sequence: result.Sequence,
		BetMinor: result.BetMinor, ChargedBetMinor: result.ChargedBetMinor,
		BalanceMinor: result.BalanceMinor, TotalWinMinor: result.TotalWinMinor,
		Grid: result.Grid, Events: result.Events, FeatureState: result.FeatureState,
	}
	if result.Wins != nil {
		projection.Wins = make([]legacyWinHashProjection, len(result.Wins))
		for index, win := range result.Wins {
			projection.Wins[index] = legacyWinHashProjection{
				ID: win.ID, Symbol: win.Symbol, Ways: win.Ways,
				AmountMinor: win.AmountMinor, Cells: win.Cells,
			}
			if win.PathAwards != nil {
				projection.Wins[index].PathAwards = make([]legacyPathAwardHashProjection, len(win.PathAwards))
				for pathIndex, award := range win.PathAwards {
					projection.Wins[index].PathAwards[pathIndex] = legacyPathAwardHashProjection{
						Cells: award.Cells, Multiplier: award.Multiplier,
						BaseAmountMinor: award.BaseAmountMinor, AmountMinor: award.AmountMinor,
					}
				}
			}
		}
	}
	return projection
}

// PreparedOutcomeHashFor 返回产生任何钱包副作用前写入的不可变哈希。已提交结果包含
// 预备结果时尚不存在的回执派生字段，因此重放及完整性验证时会刻意将其从哈希投影中移除。
func PreparedOutcomeHashFor(result SpinResult) (string, error) {
	result.WalletTransactionID = ""
	result.BalanceMinor = 0
	result.EndRevision = 0
	return OutcomeHashFor(result)
}

// CommittedResultHashFor 标识钱包结算后交付给客户端的确切规范结果。与
// PreparedOutcomeHashFor 不同，它包含所有回执派生字段。
func CommittedResultHashFor(result SpinResult) (string, error) {
	return OutcomeHashFor(result)
}

func walletOperationID(request SpinRequest) string {
	digest := sha256.New()
	writeFingerprintField(digest, "schema", "rgs-wallet-operation-v1")
	writeFingerprintField(digest, "operator", request.OperatorID)
	writeFingerprintField(digest, "session", request.SessionID)
	writeFingerprintField(digest, "round", request.RoundID)
	return "rgs-op-v1:" + hex.EncodeToString(digest.Sum(nil))
}

func writeFingerprintField(digest hash.Hash, name, value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(name)))
	_, _ = digest.Write(size[:])
	_, _ = digest.Write([]byte(name))
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = digest.Write(size[:])
	_, _ = digest.Write([]byte(value))
}
