import type { CellAddress, GridCell } from "../app/state/types";

/**
 * 第一轮之前显示的固定的、无需付费的橱柜着装。它永远不会存储在 GameSnapshot 中、进行评估、突出显示或发送到服务器。
 *
 * 英文 / English: Fixed, no-pay cupboard dressing shown before round one. It is never stored in GameSnapshot, evaluated, highlighted, or sent to the server.
 */
const ATTRACT_GRID: readonly (readonly GridCell[])[] = [
  // 预设的 Symbol1 装备将 ORBIT 渲染为 K，而 Symbol0 将 PRISM 渲染为 Q，与规范的服务器域映射匹配。 / English: The default Symbol1 rig renders ORBIT as K, while Symbol0 renders PRISM as Q, matching the canonical server domain mapping.
  [{ symbol: "CIRCUIT" }, { symbol: "NOVA" }, { symbol: "ORBIT" }],
  [
    { symbol: "VAULT", prize: "GRAND", multiplier: 1_000 },
    { symbol: "SURGE" },
    { symbol: "WILD", multiplier: 100 },
  ],
  [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "TANK" }],
] as const;

/**
 * 固定柜装饰的仅渲染器主体覆盖。  这不能被编码到 `GridCell` 中：大铭牌在任何服务器回合之前都是可见的，但原始主体仍然是锁定的 Symbol8 金库。
 *
 * 英文 / English: Renderer body only override of fixed cabinet trim. This cannot be coded into the `GridCell`: the large nameplate is visible before any server turn, but the original body remains a locked Symbol8 vault.
 */
export const ATTRACT_GRID_LOCKED_VAULT_CELLS: readonly CellAddress[] = Object.freeze([
  Object.freeze({ reel: 1, row: 0 }),
]);

export function createAttractGrid(): GridCell[][] {
  return ATTRACT_GRID.map((reel) => reel.map((cell) => ({ ...cell })));
}
