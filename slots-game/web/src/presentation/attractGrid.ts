import type { CellAddress, GridCell } from "../app/state/types";

/**
 * 第一轮之前显示的固定的、无需付费的橱柜着装。它永远不会存储在 GameSnapshot 中、进行评估、突出显示或发送到服务器。
 */
const ATTRACT_GRID: readonly (readonly GridCell[])[] = [
  // 预设的 Symbol1 装备将 ORBIT 渲染为 K，而 Symbol0 将 PRISM 渲染为 Q，与规范的服务器域映射匹配。
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
 */
export const ATTRACT_GRID_LOCKED_VAULT_CELLS: readonly CellAddress[] = Object.freeze([
  Object.freeze({ reel: 1, row: 0 }),
]);

export function createAttractGrid(): GridCell[][] {
  return ATTRACT_GRID.map((reel) => reel.map((cell) => ({ ...cell })));
}
