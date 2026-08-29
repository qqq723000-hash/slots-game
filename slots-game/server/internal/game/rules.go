package game

// EngineRulesVersion 标识随机数到结果的转换语义。它是已签名数学
// Config 的必填字段，因此修改这些语义时必须升级定义版本并重新审批。
// English: EngineRulesVersion identifies the random number to result conversion semantics. It is a required field
// for signed math Config, so modifying these semantics requires upgrading the definition version and re-approving
// it.
const EngineRulesVersion = "slots-game-ways3-features-win-cap-paid-facts-v6"

// PrimalMaxWinMultiplier 属于 Primal 客户端使用的 v6 引擎契约。
// 若要采用不同上限，必须使用新的引擎规则版本（或未来将已签名上限绑定到
// 会话身份的协议）。
// English: PrimalMaxWinMultiplier belongs to the v6 engine contract used by the Primal client. To adopt a
// different cap, you must use a new engine rule version (or a future protocol that binds signed caps to session
// identities).
const PrimalMaxWinMultiplier int64 = 2_500
