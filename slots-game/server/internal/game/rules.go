package game

// EngineRulesVersion 标识随机数到结果的转换语义。它是已签名数学
// Config 的必填字段，因此修改这些语义时必须升级定义版本并重新审批。
const EngineRulesVersion = "slots-game-ways3-features-win-cap-paid-facts-v6"

// PrimalMaxWinMultiplier 属于 Primal 客户端使用的 v6 引擎契约。
// 若要采用不同上限，必须使用新的引擎规则版本（或未来将已签名上限绑定到
// 会话身份的协议）。
const PrimalMaxWinMultiplier int64 = 2_500
