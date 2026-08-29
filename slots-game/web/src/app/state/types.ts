import type {
  LockedVaultFace,
  SymbolId,
  WheelInstantMultiplier,
  WheelJackpotTier,
} from "../../protocol/protocolConstants";

// 保留既有应用状态入口；运行时定义只允许位于无反向依赖的协议叶子模块。 / English: Existing application state entries are retained; runtime definitions are only allowed in protocol leaf modules with no reverse dependencies.
export {
  LOCKED_VAULT_FACES,
  SYMBOL_IDS,
  WHEEL_INSTANT_MULTIPLIER_BY_TIER,
  lockedVaultFaceForOriginalServerId,
  type LockedVaultFace,
  type SymbolId,
  type WheelInstantMultiplier,
  type WheelJackpotTier,
} from "../../protocol/protocolConstants";

export type MoneyMinor = string;

export interface GridCell {
  symbol: SymbolId;
  multiplier?: number;
  /** 权威的已解锁 Vault 姿态（例如 MINI_2X 或 FREE_SPIN）。 / English: The authoritative unlocked Vault state (for example, MINI_2X or FREE_SPIN). */
  prize?: string;
  /**
   * 仍锁定的 Symbol8 Vault 所使用的权威表现牌面。它与承载派彩的 `multiplier` / `prize`
   * 互斥，并且从不参与结算。
   *
   * 英文 / English: The authoritative performance deck used by the Symbol8 Vault that is still locked. It is mutually exclusive with the `multiplier` / `prize` that carries the payout, and never participates in settlement.
   */
  lockedVaultFace?: LockedVaultFace;
}

export interface CellAddress {
  reel: number;
  row: number;
}

export interface PathAward {
  /** 按转轴顺序，转轴 0、1、2 各有且只有一个由服务端选择的格子。 / English: In the order of the reels, reels 0, 1, and 2 each have one and only one grid selected by the server. */
  cells: CellAddress[];
  /** 此路径上 WILD 倍率的乘积；没有 WILD 时为 1。 / English: The product of the WILD multipliers on this path; 1 without WILD. */
  multiplier: number;
  /** 合并 WILD 倍率前显示的服务端已解析金额。 / English: The server-side parsed amount displayed before merging the WILD multiplier. */
  baseAmountMinor: MoneyMinor;
  /** 整局最高赢额上限应用前的数学路径金额。 / English: The mathematical path amount before the maximum win limit for the entire round is applied. */
  nominalAmountMinor: MoneyMinor;
  /** 实际支付并计入 `totalWinMinor` 的路径金额。表现层绝不能重新计算。 / English: The path amount actually paid and credited to `totalWinMinor`. The presentation layer must never be recalculated. */
  amountMinor: MoneyMinor;
}

export interface Win {
  id: string;
  symbol: SymbolId;
  /** 每个实时服务端结果都包含；仅在旧版夹具/重放中可选。 / English: Included with every live server result; only optional in legacy fixtures/replays. */
  ways?: number;
  /** 整局最高赢额上限应用前的数学聚合金额。 / English: The mathematically aggregated amount before the maximum win cap for the entire round is applied. */
  nominalAmountMinor: MoneyMinor;
  /** 实际支付并计入 `totalWinMinor` 的聚合金额。 / English: The aggregate amount actually paid and included in `totalWinMinor`. */
  amountMinor: MoneyMinor;
  /**
   * 仅用于表现的倍率。只有当每个 pathAward 具有相同值时，实时记录才会携带它；混合记录和
   * 旧记录会省略它。没有 pathAwards 的旧记录仍可提供显式表现数据。
   *
   * 英文 / English: Magnification for performance purposes only. Live records only carry it if each pathAward has the same value; mixed and old records omit it. Explicit performance data is still available for older records without pathAwards.
   */
  multiplier?: number;
  cells: CellAddress[];
  /**
   * 可选的结算/审计拆分。Primal 表现绝不能将此聚合记录拆成视觉赔付线。
   *
   * 英文 / English: Optional settlement/audit split. Primal performance can never break this aggregate record into visual paylines.
   */
  pathAwards?: PathAward[];
}

export type FeatureMode = "BASE" | "EXPANSION" | "OVERDRIVE";

export interface FeatureState {
  mode: FeatureMode;
  freeSpinsRemaining: number;
  freeSpinsPlayed?: number;
  baseBetMinor?: MoneyMinor;
  /** 持续更新的权威特性总额；Free Spins 激活期间存在。 / English: Continuously updated authoritative feature sum; Free Spins exist during activation. */
  freeSpinsWinMinor?: MoneyMinor;
  /** 规范且可安全重连的 Rage 计量条投影。 / English: Canonical and reconnectable Rage meter bar projection. */
  rageLevel: number;
  rageCollected: number;
}

export interface SurgeCollectedEvent {
  type: "surge.collected";
  count: number;
  cells: readonly Readonly<CellAddress>[];
  triggered: boolean;
  guaranteed: boolean;
  level: number;
  total: number;
}

export interface RageTransformedEvent {
  type: "rage.transformed";
  count: number;
  cells: readonly Readonly<CellAddress>[];
  level: number;
  total: number;
}

export interface WheelStartedEvent {
  type: "wheel.started";
}

export interface InstantWheelAwardedEvent {
  type: "wheel.awarded";
  outcome: "INSTANT";
  prize: WheelJackpotTier;
  multiplier: WheelInstantMultiplier;
  amountMinor: MoneyMinor;
}

export interface ExpansionWheelAwardedEvent {
  type: "wheel.awarded";
  outcome: "EXPANSION";
  /** 可选的表现别名。权威服务端会省略它。 / English: Optional performance alias. Authoritative servers will omit it. */
  prize?: "KONG_QUEST";
  multiplier?: never;
  amountMinor?: never;
}

export interface OverdriveWheelAwardedEvent {
  type: "wheel.awarded";
  outcome: "OVERDRIVE";
  /** 可选的表现别名。权威服务端会省略它。 / English: Optional performance alias. Authoritative servers will omit it. */
  prize?: "KING_SPIN";
  multiplier?: never;
  amountMinor?: never;
}

export type WheelAwardedEvent =
  | InstantWheelAwardedEvent
  | ExpansionWheelAwardedEvent
  | OverdriveWheelAwardedEvent;

export interface FreeSpinsStartedEvent {
  type: "free_spins.started";
  mode: Exclude<FeatureMode, "BASE">;
  awarded: number;
}

export interface GridExpandedEvent {
  type: "grid.expanded";
  rows: number;
  ways: number;
}

export interface VaultAwardedEvent {
  type: "vault.awarded";
  reel: number;
  row: number;
  multiplier: number;
  amountMinor: MoneyMinor;
  prize?: string;
}

export interface VaultGroupEvent {
  type: "vaults.landed" | "vaults.locked" | "vaults.unlock.started" | "vaults.unlock.completed";
  count: number;
  cells: readonly Readonly<CellAddress>[];
}

export interface VaultUnlockedEvent {
  type: "vault.unlocked";
  reel: number;
  row: number;
  prize: string;
  multiplier?: number;
}

export interface FreeSpinAwardedEvent {
  type: "free_spin.awarded";
  count: number;
  reel?: number;
  row?: number;
}

export interface VaultUpgradedEvent {
  type: "vault.upgraded";
  reel: number;
  row: number;
  fromMultiplier: number;
  toMultiplier: number;
  prize: string;
  step: number;
}

export interface VaultUpgradeStartedEvent {
  type: "vaults.upgrade.started";
  count: number;
  step: number;
}

export interface FreeSpinCapReachedEvent {
  type: "free_spin.cap_reached";
  reel: number;
  row: number;
}

export interface FreeSpinsCompletedEvent {
  type: "free_spins.completed";
  mode: Exclude<FeatureMode, "BASE">;
  awarded: number;
  cumulativeWinMinor: MoneyMinor;
}

/** 纯经济边界事实；客户端可观测但不得为其虚构独立动画或音频。 / English: Purely economic boundary fact; client may observe but may not invent independent animations or audio for it. */
export interface WinCapReachedEvent {
  type: "win_cap.reached";
  multiplier: 2_500;
  cumulativeWinMinor: MoneyMinor;
}

export type FeatureEvent =
  | SurgeCollectedEvent
  | RageTransformedEvent
  | WheelStartedEvent
  | WheelAwardedEvent
  | FreeSpinsStartedEvent
  | GridExpandedEvent
  | VaultAwardedEvent
  | VaultGroupEvent
  | VaultUnlockedEvent
  | FreeSpinAwardedEvent
  | VaultUpgradedEvent
  | VaultUpgradeStartedEvent
  | FreeSpinCapReachedEvent
  | WinCapReachedEvent
  | FreeSpinsCompletedEvent;

/**
 * 金额的小单位解释属于会话经济绑定。`currencyExponent` 表示一个主单位包含
 * 10^exponent 个小单位；它在同一 sessionId 内不得改变。
 *
 * 英文 / English: Interpretation of small units of amounts falls under conversational economic binding. `currencyExponent` means that a main unit contains 10^exponent small units; it must not change within the same sessionId.
 */
export interface MoneyDisplayBinding {
  readonly currency: string;
  readonly currencyExponent: number;
}

/** 固定玩法文案绑定到这组完整数学定义身份，不从版本名或哈希前缀猜测兼容性。 / English: Fixed gameplay copy binding to this complete set of mathematically defined identities, without guessing compatibility from version names or hash prefixes. */
export interface GameDefinitionBinding {
  readonly gameId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
}

export interface SessionOpened extends MoneyDisplayBinding {
  type: "session.opened";
  protocolVersion: 1;
  /** 历史协议兼容字段；生产 RGS 会话以获批定义的版本和哈希为准。 / English: Historical protocol compatibility field; production RGS sessions are subject to the version and hash of the approved definition. */
  engineRulesVersion?: "slots-game-ways3-features-win-cap-paid-facts-v6";
  /** RGS 投影总是提供；非 RGS 测试替身省略时，固定玩法文案必须保持关闭。 / English: RGS projection is always provided; fixed gameplay copy must remain off when non-RGS test doubles are omitted. */
  definitionBinding?: Readonly<GameDefinitionBinding>;
  requestId: string;
  sessionId: string;
  balanceMinor: MoneyMinor;
  betOptionsMinor: MoneyMinor[];
  defaultBetMinor: MoneyMinor;
  featureState: FeatureState;
  /** 生产 RGS 提供的服务端权威空闲断开绝对时间；测试网关可以省略。 / English: The absolute server-side authoritative idle disconnect time provided by the production RGS; the test gateway can be omitted. */
  idleDisconnectAt?: string;
}

export interface SpinResult {
  type: "spin.result";
  protocolVersion: 1;
  requestId: string;
  sessionId: string;
  roundId: string;
  sequence: number;
  betMinor: MoneyMinor;
  chargedBetMinor: MoneyMinor;
  balanceMinor: MoneyMinor;
  totalWinMinor: MoneyMinor;
  grid: GridCell[][];
  wins: Win[];
  events: readonly FeatureEvent[];
  featureState: FeatureState;
}

export interface ServerError {
  type: "error";
  protocolVersion: 1;
  requestId?: string;
  sessionId?: string;
  roundId?: string;
  code: string;
  message: string;
  retryable: boolean;
}

export type ServerMessage = SessionOpened | SpinResult | ServerError;

export interface GameSnapshot {
  currency: string;
  currencyExponent: number;
  balanceMinor: MoneyMinor;
  selectedBetMinor: MoneyMinor;
  betOptionsMinor: MoneyMinor[];
  featureState: FeatureState;
  lastWinMinor: MoneyMinor;
  currentGrid: GridCell[][];
}

export const EMPTY_FEATURE_STATE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
};
