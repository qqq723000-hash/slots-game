import type { FeatureEvent, FreeSpinsCompletedEvent, MoneyMinor, Win } from "./state/types";

export interface RoundPresentationPhases {
  /** PPS/特性机制只在已停网格的 Ways 中奖之后开始。 / English: The PPS/Feature mechanic only starts after winning Ways on a stopped grid. */
  readonly postWinEvents: readonly FeatureEvent[];
  /** 终局 Free Spins 总结位于 Ways 中奖和 PPS 机制之后。 / English: The endgame Free Spins summary follows the Ways jackpot and PPS mechanics. */
  readonly summaryEvents: readonly FreeSpinsCompletedEvent[];
}

/**
 * `grid.expanded` 归停轴前的结构处理阶段所有。其余 PPS 事件保持线上的顺序，
 * 但只在普通 Ways 中奖之后开始；终局 Free Spins 面板是最后阶段。
 *
 * 英文 / English: `grid.expanded` is owned by the structure processing stage before stopping the axis. The rest of the PPS events maintain online order, but only start after the normal Ways win; the endgame Free Spins panel is the final stage.
 */
export function roundPresentationPhases(
  events: readonly FeatureEvent[],
): RoundPresentationPhases {
  const postWinEvents: FeatureEvent[] = [];
  const summaryEvents: FreeSpinsCompletedEvent[] = [];
  for (const event of events) {
    if (event.type === "grid.expanded") continue;
    if (event.type === "free_spins.completed") summaryEvents.push(event);
    else postWinEvents.push(event);
  }
  return { postWinEvents, summaryEvents };
}

/** 一轮中的 Ways 部分，不含显式的 Wheel/Vault 事件奖励。 / English: The Ways portion of a round without explicit Wheel/Vault event rewards. */
export function authoritativeWaysWinTotal(wins: readonly Pick<Win, "amountMinor">[]): MoneyMinor {
  let total = 0n;
  for (const { amountMinor } of wins) {
    if (/^(0|[1-9]\d*)$/.test(amountMinor)) total += BigInt(amountMinor);
  }
  return total.toString();
}
