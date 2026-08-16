export interface ReelStopStep {
  reel: number;
  delayMs: number;
  settleMs: number;
}

export interface StopPlanOptions {
  firstDelayMs?: number;
  reelGapMs?: number;
  settleMs?: number;
}

export function createStopPlan(reelCount: number, options: StopPlanOptions = {}): ReelStopStep[] {
  if (!Number.isSafeInteger(reelCount) || reelCount <= 0) throw new Error("reelCount must be a positive integer");
  // 捕获的 Ug 停止序列器：首先在旋转 +1500ms 处制动，随后每 300ms 卷绕一次，然后 300ms 制动加上 350ms 预设的弹跳。
  const firstDelayMs = options.firstDelayMs ?? PRIMAL_REEL_TIMING_MS.firstBrake;
  const reelGapMs = options.reelGapMs ?? PRIMAL_REEL_TIMING_MS.reelGap;
  const settleMs = options.settleMs
    ?? PRIMAL_REEL_TIMING_MS.brake + PRIMAL_REEL_TIMING_MS.bounce;
  if ([firstDelayMs, reelGapMs, settleMs].some((value) => value < 0 || !Number.isFinite(value))) {
    throw new Error("stop timing values must be finite and non-negative");
  }
  return Array.from({ length: reelCount }, (_, reel) => ({
    reel,
    delayMs: firstDelayMs + reel * reelGapMs,
    settleMs,
  }));
}
import { PRIMAL_REEL_TIMING_MS } from "./primalAnimationTiming";
