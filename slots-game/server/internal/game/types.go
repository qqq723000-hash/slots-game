package game

import "context"

type Symbol string

const (
	SymbolOrbit   Symbol = "ORBIT"
	SymbolPrism   Symbol = "PRISM"
	SymbolPulse   Symbol = "PULSE"
	SymbolNova    Symbol = "NOVA"
	SymbolCircuit Symbol = "CIRCUIT"
	SymbolTank    Symbol = "TANK"
	SymbolWild    Symbol = "WILD"
	SymbolVault   Symbol = "VAULT"
	SymbolSurge   Symbol = "SURGE"
)

var PayingSymbols = []Symbol{
	SymbolOrbit,
	SymbolPrism,
	SymbolPulse,
	SymbolNova,
	SymbolCircuit,
	SymbolTank,
}

type Cell struct {
	Symbol     Symbol `json:"symbol"`
	Multiplier int64  `json:"multiplier,omitempty"`
	// Prize 是服务器解析出的功能格展示及赔付表标签。WILD 只使用 Multiplier；
	// 零表示普通 WILD 图案，在连线赔付中实际按 1 倍计算；一表示单独制作的 X1 图案。
	// 已解锁 VAULT 同时携带最终 Multiplier 和 Prize，但不含金额倍数的 FREE_SPIN 除外。
	Prize string `json:"prize,omitempty"`
}

// Grid 始终按 grid[reel][row] 寻址。
type Grid [][]Cell

type Position struct {
	Reel int `json:"reel"`
	Row  int `json:"row"`
}

// PathAward 是服务器解析出的一条从左到右的具体连线路径。Cells 始终按列排序，
// 并分别包含第 0、1、2 列的一个地址。Multiplier 是该路径经过的 WILD 修正值乘积，
// 路径不含 WILD 时为 1。BaseAmountMinor 是合并 WILD 倍数前展示的权威金额；
// AmountMinor 是整场最高赢取预算应用前的数学路径金额，PaidAmountMinor 是最终结算贡献。
// 这些值是独立事实，因为最小货币单位取整会导致客户端无法通过除法安全地相互推导。
type PathAward struct {
	Cells           []Position
	Multiplier      int64
	BaseAmountMinor int64
	// AmountMinor 是应用整场最高赢取预算前的名义数学路径奖励；
	// PaidAmountMinor 是最终结算贡献。除非已签名上限裁剪此结果，否则两者相等。
	AmountMinor     int64
	PaidAmountMinor int64
}

type Win struct {
	ID     string
	Symbol Symbol
	Ways   int
	// AmountMinor 保留名义 Ways 奖励；PaidAmountMinor 是应用游戏上限后
	// 计入 TotalWinMinor 和钱包结算的金额。
	AmountMinor     int64
	PaidAmountMinor int64
	Cells           []Position
	PathAwards      []PathAward
}

// UniformPathMultiplier 返回所有具体连线奖励共同使用的唯一倍数。分解缺失或倍数混合时，
// 不存在真实的记录级倍数，展示序列化器必须继续省略该值。此值仅为投影，绝不参与赔付计算。
func (w Win) UniformPathMultiplier() (int64, bool) {
	if len(w.PathAwards) == 0 || w.PathAwards[0].Multiplier < 1 {
		return 0, false
	}
	multiplier := w.PathAwards[0].Multiplier
	for _, award := range w.PathAwards[1:] {
		if award.Multiplier != multiplier {
			return 0, false
		}
	}
	return multiplier, true
}

type Event struct {
	Type               string
	Count              int
	Cells              []Position
	Triggered          bool
	Guaranteed         bool
	Outcome            string
	Prize              string
	Multiplier         int64
	AmountMinor        int64
	CumulativeWinMinor int64
	Mode               FeatureMode
	Awarded            int
	Rows               int
	Ways               int
	Reel               int
	Row                int
	Level              int
	Total              int
	Step               int
	FromMultiplier     int64
	ToMultiplier       int64
}

type FeatureMode string

const (
	FeatureNone      FeatureMode = "NONE"
	FeatureExpansion FeatureMode = "EXPANSION"
	FeatureOverdrive FeatureMode = "OVERDRIVE"
	DefaultRageLevel             = 1
	MaxFeatureSpins              = 1_000_000
	MaxRageCollected             = 1_000_000
)

type FeatureState struct {
	Mode      FeatureMode
	Remaining int
	Awarded   int
	BetMinor  int64
	// WinMinor 是已支付的整场累计值：触发时的基础结果加上之后的每次免费旋转。
	// 持久化该值后，最高赢取预算可作为权威状态，并能在进程或钱包重试后精确恢复。
	WinMinor      int64
	RageLevel     int
	RageCollected int
}

func (s FeatureState) Active() bool {
	return s.Mode != FeatureNone && s.Remaining > 0
}

func EmptyFeatureState() FeatureState {
	return FeatureState{Mode: FeatureNone, RageLevel: DefaultRageLevel}
}

// WithoutFreeSpins 返回规范的基础游戏状态，同时保留跨局怒气计量值。该计量值属于展示可见的
// 游戏状态，因此与具有经济效力的免费旋转计数器一同持久化。
func (s FeatureState) WithoutFreeSpins() FeatureState {
	level := s.RageLevel
	if s.RageCollected == 0 {
		level = DefaultRageLevel
	}
	return FeatureState{
		Mode: FeatureNone, RageLevel: level, RageCollected: s.RageCollected,
	}
}

type SpinInput struct {
	BetMinor int64
	Feature  FeatureState
}

type SpinOutcome struct {
	Grid          Grid
	Wins          []Win
	Events        []Event
	TotalWinMinor int64
	NextFeature   FeatureState
}

type Spinner interface {
	Spin(context.Context, SpinInput) (SpinOutcome, error)
}
