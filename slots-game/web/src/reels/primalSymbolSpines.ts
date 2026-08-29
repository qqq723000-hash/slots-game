import type { SymbolId } from "../app/state/types";
import type { PrimalSpineKey } from "../renderer/spine/PrimalSpineAssets";

export type PrimalSymbolSpineKey = Extract<
  PrimalSpineKey,
  | "symbol0"
  | "symbol1"
  | "symbol2"
  | "symbol3"
  | "symbol4"
  | "symbol5"
  | "symbol6"
  | "symbol7"
  | "symbol8"
  | "symbol9"
>;

/**
 * 从捕获的桌面客户端而不是从文件名顺序恢复精确映射。其 GameSymbol 枚举将 LP1..BONUS_UNLOCKED 分配给 0..9；所提供的装备将LP1识别为Q，
 * LP2识别为K，MP1识别为头盔，MP2识别为无线电，HP1识别为坦克，HP2识别为喷气机。服务器故意公开域名而不是那些客户端本地数字 ID。
 *
 * 英文 / English: Exact mappings are restored from captured desktop clients rather than from filename order. Its GameSymbol enumeration assigns LP1..BONUS_UNLOCKED to 0..9; the provided rig identifies LP1 as a Q, LP2 as a K, MP1 as a helmet, MP2 as a radio, HP1 as a tank, and HP2 as a jet. Servers intentionally expose domain names instead of those client local numeric IDs.
 */
export const PRIMAL_CLIENT_SYMBOL_ID_BY_SERVER_ID: Readonly<Record<SymbolId, number>> = Object.freeze({
  PRISM: 0, // Q / LP1
  ORBIT: 1, // K / LP2
  PULSE: 2, // 头盔 / MP1
  NOVA: 3, // 收音机 / MP2
  TANK: 4, // 坦克 / HP1
  CIRCUIT: 5, // 喷气式飞机 / HP2
  WILD: 6,
  SURGE: 7, // Rage / SCATTER
  VAULT: 8, // 上锁的金库； Symbol9 是其解锁的功能状态
});

export const PRIMAL_SYMBOL_SPINE_KEY_BY_SERVER_ID: Readonly<Record<SymbolId, PrimalSymbolSpineKey>> =
  Object.freeze({
    PRISM: "symbol0",
    ORBIT: "symbol1",
    PULSE: "symbol2",
    NOVA: "symbol3",
    TANK: "symbol4",
    CIRCUIT: "symbol5",
    WILD: "symbol6",
    SURGE: "symbol7",
    VAULT: "symbol8",
  });

/** 所有提供的符号骨架，包括解锁的库功能状态。 / English: All provided symbol skeletons, including unlocked library feature states. */
export const PRIMAL_SYMBOL_SPINE_KEYS: readonly PrimalSymbolSpineKey[] = Object.freeze([
  "symbol0",
  "symbol1",
  "symbol2",
  "symbol3",
  "symbol4",
  "symbol5",
  "symbol6",
  "symbol7",
  "symbol8",
  "symbol9",
]);

/**
 * 原始客户端为屏幕外条带行寻址 `Symbol_blurred_dummy`，然后通过自定义渲染器提供实时符号纹理。因此，裸露的 Spine 实例在这里不会绘制任何内容。
 * ReelView 使用等效的过滤实时符号条，并故意不将此空骨架附加到 `PRIMAL_SYMBOL_SPINE_KEYS`。
 *
 * 英文 / English: The original client addresses `Symbol_blurred_dummy` for the off-screen stripe line and then provides the real-time symbol texture via a custom renderer. So a bare Spine instance won't draw anything here. ReelView uses an equivalent filtered live symbol strip and intentionally does not attach this empty skeleton to `PRIMAL_SYMBOL_SPINE_KEYS`.
 */
export const PRIMAL_BLURRED_SYMBOL_PLACEHOLDER = Object.freeze({
  spineKey: "symbolBlurredDummy" as const,
  renderStrategy: "filtered-live-symbol-strip" as const,
  instantiateSpine: false,
  blurStrength: 9,
  blurX: 0.32,
  blurY: 16,
  quality: 5,
  repeatEdgePixels: true,
});
