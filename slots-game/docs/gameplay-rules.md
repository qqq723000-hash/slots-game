# 玩法规则与权威事件契约

状态：已实现规则契约；精确商业数学仍未认证。

最后更新：2026-08-26

本文档把从抓取的客户端、赔付表与采样命令响应中确认的规则事实，与这些产物未披露的概率值分开
列出。Go 引擎在网格、奖品、特性状态、事件顺序与所有资金上具有权威。动画代码消费这些事实，
绝不采样第二次结果。

## 1. 基础游戏与 Ways

- 基础网格为 3 轴 × 3 行。
- 一个 Way 要求相同的赔付符号出现在从左到右的三根相邻轴上。所有具体的行组合都被赔付并按符号
  聚合。
- Rage 与 Vault 是特性符号，绝不构成 Ways 获胜。
- Wild 仅出现在第 2 轴，并替代每个赔付符号。其抓取的倍数目录为 base/x1、x2、x3、x5、x10、
  x25、x50、x100；倍数仅应用于穿过该 Wild 格子的具体 Ways 路径。采样值持久化在那个确切的
  `grid[1][row]` 格子上作为 `multiplier`；客户端绝不采样视觉倍数。普通 WILD 省略该字段并按
  x1 评估，而单独编写的 X1 面携带 `multiplier: 1`，保留其视觉区分。
- Vault 仅出现在第 2 轴。Rage 在基础游戏中可出现在任何轴。
- 抓取的每条具体 Way 的三轴赔付（相对于总投注）为：Q/`PRISM` 0.1x、K/`ORBIT` 0.3x、
  Helmet/`PULSE` 0.8x、Radio/`NOVA` 1x、Tank/`TANK` 1.5x、Jet/`CIRCUIT` 2x。以本地 100 最小
  参考单位计，这些存储为 `10/30/80/100/150/200`。

`Win` 是按赔付符号的聚合：`ways` 与 `cells` 覆盖该符号的每条具体路径。不同路径可能穿过不同
的 WILD 格子，因此协议刻意不把它们压缩成一个模糊的 `Win.multiplier`。取而代之，有序的
`pathAwards` 携带三格、实际 WILD 倍数、服务端解析的合并前基础金额与每条具体路径的金额事实。
基础金额是显式的，而非通过除法推导，因为最小单位缩放可能舍入。

在 `Win` 与每条 `pathAwards` 上，HTTP `nominalAmountMinor` 保留应用 WILD 后、整场最高赢取预算
截断前的完整数学金额；个别路径经确定性的最小货币单位取整后可为零，但聚合 Win 名义金额必须为
正。为保持既有客户端兼容，HTTP `amountMinor` 表示实际结算/支付金额。未触发上限时两者相等；触
发上限时，所有原始路径、`ways` 与 `cells` 仍完整保留，但较后的路径支付可以被截断甚至为零。每
条路径的名义金额之和精确等于聚合名义金额，每条路径的实际支付之和精确等于
聚合 `amountMinor`，且只有后者计入 `TotalWinMinor`、钱包结算与整场预算。引擎在接受自己的结果
前从网格与不可变赔付表重新计算完整分解。客户端可以表现这些记录，但绝不猜测。

该名义/支付分离以内部 `ResultSchemaPaidFactsV1`（`rgs-spin-result-paid-facts-v1`）绑定到新持久化
结果及其经济哈希；该内部标记不是 HTTP 响应字段。标记出现前的历史结果没有保存两套金额，重放
时只能规范化为名义金额等于实际支付，同时继续使用其原始旧版哈希投影，不能伪造已经丢失的封顶
前路径事实。

## 2. Rage 收集与 Primal Wheel

Rage 仅在一次有偿基础游戏网格结算后评估：

1. `surge.collected` 标识每个已结算的 Rage 格子、结算后的权威等级与总数，以及收集是否触发。
   未触发的一/两符号结果把计数持久化到 PPS；成功触发的一/两符号结果消费该次 PPS 会话并在事
   件与最终状态中都报告规范的重置值 `level=1,total=0`。三符号直接轮盘触发保留请求起点的 PPS
   快照，因为它不属于概率 PPS 会话。
2. 一个或两个 Rage 符号使用配置的触发概率。三个及以上保证触发。
3. 当一个或两个触发时，`rage.transformed` 精确提供猿形级联用来表现三 Rage 激活的额外格子。
   这些覆盖不重写已评估的 Ways 结果。
4. `wheel.started` 仅在收集/变形之后发出。
5. `wheel.awarded` 提供定义目录中恰好七种可见结果之一：MINI x10、MINOR x30、MAJOR x75、
   MEGA x250、GRAND x1000、Kong Quest 或 King Spin。
6. 特性授予后跟 `free_spins.started`；即时授予在同一提交轮次中入账。

抓取的轮盘顺时针资产/索引顺序为 MEGA、KONG QUEST、MINOR、GRAND、KING SPIN、MAJOR、MINI。该
顺序是表现元数据；服务端提交一个命名的奖品/模式，绝不信任客户端选择的扇区索引。

抓取的命令确立了空闲 PPS 等级 `1` 与零 Rage，以及在总数 `12` 时权威同步到等级 `2`。服务端持
久化 `RageLevel` 与 `RageCollected`，包括跨轮盘、任一 Free Spins 模式与重连。三个及以上触发
的 Rage 符号不计入该总数。客户端有六个编写的 PPS 等级；当前签名本地定义显式配置了
一/两 Rage 触发率 `800/2400` 基点（`8%/24%`）和六级阈值 `0/12/24/36/48/60`。除已抓取验证的
`12` 边界外，其余概率与高等级阈值都是版本化的净室数学值，不代表原游戏商业概率或已认证数学。
赔付表明确把 PPS/背景演进描述为仅视觉：它不表示真实进度、不改变触发赔率，也不保证轮盘。因
此引擎绝不从显示等级推导奖品。

## 3. Vault 结算

服务端总是先标识完整的中轴 Vault 集合：

```text
vaults.landed
  ├─ vaults.locked
  └─ vaults.unlock.started
       ├─ vault.unlocked → vault.awarded
       ├─ vault.unlocked → free_spin.awarded
       └─ vault.unlocked → free_spin.cap_reached
     vaults.unlock.completed
```

基础游戏与 Kong Quest 的 Vault 对完整集合使用一次服务端解锁决策。如果解锁，每个 Vault 揭示
一个权威奖励。固定金钱目录为 x1 到 x9、MINI x10、MINOR x30、MAJOR x75、MEGA x250、
GRAND x1000。`vault.awarded` 是唯一可赔付的 Vault 事件；揭示与升级事件刻意不带金钱，防止重复
记账。

每个结算的 Vault 把其最终结果写回对应的网格格子。一个可赔付 Vault 有匹配的
`cell.multiplier` 与 `cell.prize`；一个 `FREE_SPIN` Vault 仅有 `cell.prize`；一个锁定的
Vault 两者皆不暴露。`vault.awarded` 的名义金额应为 `betMinor × multiplier`。其事件
`amountMinor` 是实际支付：未触发整场上限时必须等于名义金额；触发上限时可以小于名义金额（包括
零），但不得为负或超过名义金额，且必须存在匹配的 `win_cap.reached` 边界。结果校验器拒绝任何
不一致。

不可变定义也被限制为带编写符号面的标签：基础 Vault x1–x9 加 MINI/MINOR/MAJOR/MEGA/GRAND，
以及 King Spin 的同集合加四个 `*_2X` 面。不支持的任意值会失败配置校验，而非静默变成客户端兜
底标签。支持目录内的权重由版本化服务端定义显式提供，浏览器资产不参与概率配置。

## 4. Kong Quest（`EXPANSION`）

- 从 8 次 Free Spins 开始。
- 每次旋转独立地从 3x3 到 3x8 中选择一个三轴高度；`grid.expanded` 在转轴表现开始前携带行数
  与结果的 `rows³` Ways 计数。
- Rage 从特性轴采样中移除。
- 一个解锁的 Vault 可揭示 `FREE_SPIN`；每个此类格子恰好增加一次剩余与授予旋转，并发出
  `free_spin.awarded`。
- 持久化的 `Remaining`、`Awarded`、锁定的 `BetMinor` 与运行中的已支付累计值 `WinMinor` 使自动
  播放可安全重启。
- 加载的定义必须设置防御性扩展上限，并发出 `free_spin.cap_reached` 而非静默丢弃扩展。

## 5. King Spin（`OVERDRIVE`）

- 从 8 次 Free Spins 开始，且不可扩展。
- Rage 从特性轴采样中移除。
- 每个落地的 Vault 都被解锁；没有锁定分支。
- 零或多个有序升级轮次可能跟随。每轮发出一个 `vaults.upgrade.started`，然后对每个变化的格子
  发出一个 `vault.upgraded`，携带其确切的 `fromMultiplier`、`toMultiplier`、奖品标签与步骤
  号。
- 最终 Vault 值在所有升级轮次后通过 `vault.awarded` 一次性入账。
- 可见升级目录达到 GRAND x1000，并包含 King Spin 特殊的 MINI 2X (x20)、MINOR 2X (x60)、
  MAJOR 2X (x150)、MEGA 2X (x500)。

## 6. 特性完成与恢复

每个活跃 Free Spin 把已提交轮次的实际支付加到持久化的 `FeatureState.WinMinor`。最后一次旋转
发出：

```text
free_spins.completed {
  mode,
  awarded,
  cumulativeWinMinor
}
```

其中 `cumulativeWinMinor` 也是该触发局已实际支付的累计金额，而不是未截断的名义责任。状态然后
返回 `NONE`，同时保留规范的 Rage 计量。一个重放的 `roundId` 返回相同的网格、获胜、事件数组、
累计已支付特性获胜、余额与下一状态；它绝不再次运行 RNG 或钱包操作。RGS 仓库在钱包恢复
前/中持久化该投影，因此一个模糊的钱包响应或进程重启不会丢失特性进度。

编写的 Free Spins 摘要仅在 `cumulativeWinMinor > betMinor` 时进入，按规范整数最小单位比较。
零、低于投注、等于投注或畸形金额走无摘要状态/跳过片尾路径。在该路径上，基础恢复与约 400 ms
的 HUD 隐藏同时开始；客户端不虚构摘要面板。

本地定义 `local-production-2026-08-26.3` 还固定了整场触发局的权威最高赢取为总投注的 2500 倍，
并将引擎语义版本纳入签名定义。
触发基础局、该局产生的 Kong Quest/King Spin 以及其所有后续 Free Spin 共用同一整数最小货币单位
预算。Ways 的完整名义路径事实始终保留，实际支付与 Vault、即时 Wheel 奖励按权威事件顺序消耗
预算；正好命中或被截断到上限时发出
`win_cap.reached { multiplier: 2500, cumulativeWinMinor }`。恢复态已达到上限后仍可完成剩余免费局，
但不得再产生资金支付。该控制只证明最高赢取声明与本地结算一致，不证明商业概率或 RTP 一致。

## 7. 规范的单次旋转顺序

引擎按此顺序发出事件；缺失的分支直接省略：

1. `grid.expanded`（仅 Kong Quest）
2. `vaults.landed`
3. Vault 锁定、解锁/揭示、升级与最终授予事件
4. `surge.collected`（仅基础游戏）
5. `rage.transformed`（仅触发一/两 Rage 的结果）
6. `wheel.started`
7. `wheel.awarded`
8. `free_spins.started`（仅特性轮盘结果）
9. `win_cap.reached`（仅整场触发局正好命中或越过定义上限）
10. `free_spins.completed`（仅最后一次活跃 Free Spin）

快速停止可缩短表现等待，但必须保留此事件顺序并收敛到相同的最终投影。

在 `surge.collected.cells` 与 `rage.transformed.cells` 内，数组顺序是规范的表示顺序。每个坐
标出现一次。已结算的 Rage 格子使用确定性的轴主序；变形格子保留服务端 RNG 选择顺序。传输/存
储克隆原样保留数组，因此一个多格子的猿形收集可以顺序动画每个确切格子，而无需客户端选择或洗
牌。

## 8. 哪些已发布就绪、哪些未就绪

已恢复的 Ways 赔付金额、规则路径、溢出检查、可见授予目录、事件记账、幂等重放与特性状态恢复
已实现并由确定性测试覆盖。抓取的命令响应校验单个可见网格、命令形状与符号/值目录，但不披露
商业轴条带/权重、触发赔率、Vault 分组解锁概率、轮盘扇区概率、Vault 奖励权重、升级赔率、行
高分布、RTP 分解或精确最大获胜证明。抓取的客户端视觉条带数组仅是表现数据，绝不能被重新标记
为 RNG 权重。因此 `DemoConfig` 使用清晰标识的净室值，只能作为确定性工程测试夹具：它不是
1:1 商业数学、生产 RTP/概率或认证结论的声明，也不得被正式 RGS 启动路径选用。

在真实货币使用前，用已批准的不可变签名定义替换这些值，并为确切的定义哈希与二进制取得独立
的数学/RNG 认证。不要从视觉客户端资产调优或推断隐藏赔率。
