import type { FeatureMode, FeatureState } from "./state/types";

export interface FreeSpinAutoplayGate {
  readonly mode: FeatureMode;
  readonly remaining: number;
  readonly online: boolean;
  readonly canSpin: boolean;
  readonly pendingSpin: boolean;
  readonly destroyed: boolean;
}

export function shouldScheduleFreeSpin(input: FreeSpinAutoplayGate): boolean {
  return !input.destroyed
    && input.mode !== "BASE"
    && Number.isSafeInteger(input.remaining)
    && input.remaining > 0
    && input.online
    && input.canSpin
    && !input.pendingSpin;
}

export function freeSpinAutoplayDelay(reducedMotion: boolean): number {
  // 制作好的 FreeSpinController 会在上一次表现稳定后恰好 300 ms 推进。
  // 减少动态效果时保留无障碍快捷路径，但正常路径不得继承旧版明显迟缓的延迟。
  return reducedMotion ? 120 : 300;
}

/**
 * 检测权威的特性到 Base 边界。必须先呈现结果再让渲染器收缩，否则最后一个扩展网格和
 * 任何由服务端指定的中奖都会被过早裁剪。
 */
export function didFeatureModeEnd(previous: FeatureState, current: FeatureState): boolean {
  return previous.mode !== "BASE" && current.mode === "BASE";
}
