import type {
  LockedVaultFace,
  SymbolId,
  WheelInstantMultiplier,
  WheelJackpotTier,
} from "../../protocol/protocolConstants";

// 保留既有应用状态入口；运行时定义只允许位于无反向依赖的协议叶子模块。
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
  /** 权威的已解锁 Vault 姿态（例如 MINI_2X 或 FREE_SPIN）。 */
  prize?: string;
  /**
   * 仍锁定的 Symbol8 Vault 所使用的权威表现牌面。它与承载派彩的 `multiplier` / `prize`
   * 互斥，并且从不参与结算。
   */
  lockedVaultFace?: LockedVaultFace;
}

export interface CellAddress {
  reel: number;
  row: number;
}

export interface PathAward {
  /** 按转轴顺序，转轴 0、1、2 各有且只有一个由服务端选择的格子。 */
  cells: CellAddress[];
  /** 此路径上 WILD 倍率的乘积；没有 WILD 时为 1。 */
  multiplier: number;
  /** 合并 WILD 倍率前显示的服务端已解析金额。 */
  baseAmountMinor: MoneyMinor;
  /** 已结算的路径金额。表现层绝不能重新计算。 */
  amountMinor: MoneyMinor;
}

export interface Win {
  id: string;
  symbol: SymbolId;
  /** 每个实时服务端结果都包含；仅在旧版夹具/重放中可选。 */
  ways?: number;
  amountMinor: MoneyMinor;
  /**
   * 仅用于表现的倍率。只有当每个 pathAward 具有相同值时，实时记录才会携带它；混合记录和
   * 旧记录会省略它。没有 pathAwards 的旧记录仍可提供显式表现数据。
   */
  multiplier?: number;
  cells: CellAddress[];
  /**
   * 可选的结算/审计拆分。Primal 表现绝不能将此聚合记录拆成视觉赔付线。
   */
  pathAwards?: PathAward[];
}

export type FeatureMode = "BASE" | "EXPANSION" | "OVERDRIVE";

export interface FeatureState {
  mode: FeatureMode;
  freeSpinsRemaining: number;
  freeSpinsPlayed?: number;
  baseBetMinor?: MoneyMinor;
  /** 持续更新的权威特性总额；Free Spins 激活期间存在。 */
  freeSpinsWinMinor?: MoneyMinor;
  /** 规范且可安全重连的 Rage 计量条投影。 */
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
  /** 可选的表现别名。权威服务端会省略它。 */
  prize?: "KONG_QUEST";
  multiplier?: never;
  amountMinor?: never;
}

export interface OverdriveWheelAwardedEvent {
  type: "wheel.awarded";
  outcome: "OVERDRIVE";
  /** 可选的表现别名。权威服务端会省略它。 */
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
  | FreeSpinsCompletedEvent;

/**
 * 金额的小单位解释属于会话经济绑定。`currencyExponent` 表示一个主单位包含
 * 10^exponent 个小单位；它在同一 sessionId 内不得改变。
 */
export interface MoneyDisplayBinding {
  readonly currency: string;
  readonly currencyExponent: number;
}

/** 固定玩法文案绑定到这组完整数学定义身份，不从版本名或哈希前缀猜测兼容性。 */
export interface GameDefinitionBinding {
  readonly gameId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
}

export interface SessionOpened extends MoneyDisplayBinding {
  type: "session.opened";
  protocolVersion: 1;
  /** 历史协议兼容字段；生产 RGS 会话以获批定义的版本和哈希为准。 */
  engineRulesVersion?: "slots-game-ways3-features-v4";
  /** RGS 投影总是提供；非 RGS 测试替身省略时，固定玩法文案必须保持关闭。 */
  definitionBinding?: Readonly<GameDefinitionBinding>;
  requestId: string;
  sessionId: string;
  balanceMinor: MoneyMinor;
  betOptionsMinor: MoneyMinor[];
  defaultBetMinor: MoneyMinor;
  featureState: FeatureState;
  /** 生产 RGS 提供的服务端权威空闲断开绝对时间；测试网关可以省略。 */
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
