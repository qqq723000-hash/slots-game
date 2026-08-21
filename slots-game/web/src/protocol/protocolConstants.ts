/**
 * 协议解码与应用状态共同使用的运行时常量。
 *
 * 本模块必须保持为无项目内依赖的叶子模块。协议分块会在模块求值时基于这些常量构造
 * Set；若反向依赖应用分块，循环求值可能把尚未初始化的导出快照为空集合。
 */
export const SYMBOL_IDS = [
  "ORBIT",
  "PRISM",
  "PULSE",
  "NOVA",
  "CIRCUIT",
  "TANK",
  "WILD",
  "VAULT",
  "SURGE",
] as const;

export type SymbolId = (typeof SYMBOL_IDS)[number];

/** 官方锁定 Symbol8 骨架上制作的零时长数值姿态。 */
export const LOCKED_VAULT_FACES = [
  "x1",
  "x2",
  "x3",
  "x4",
  "x5",
  "x6",
  "x7",
  "x8",
  "x9",
  "mini",
  "minor",
  "major",
  "mega",
  "grand",
  "free_spin",
] as const;

export type LockedVaultFace = (typeof LOCKED_VAULT_FACES)[number];

/** 从官方锁定的服务端 ID 17-31 中恢复的精确表现映射。 */
export function lockedVaultFaceForOriginalServerId(serverId: number): LockedVaultFace | null {
  return Number.isInteger(serverId) && serverId >= 17 && serverId <= 31
    ? LOCKED_VAULT_FACES[serverId - 17] ?? null
    : null;
}

export const WHEEL_INSTANT_MULTIPLIER_BY_TIER = Object.freeze({
  MINI: 10,
  MINOR: 30,
  MAJOR: 75,
  MEGA: 250,
  GRAND: 1_000,
} as const);

export type WheelJackpotTier = keyof typeof WHEEL_INSTANT_MULTIPLIER_BY_TIER;
export type WheelInstantMultiplier = (
  typeof WHEEL_INSTANT_MULTIPLIER_BY_TIER
)[WheelJackpotTier];
