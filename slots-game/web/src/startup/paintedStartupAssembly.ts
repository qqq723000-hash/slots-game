import {
  waitForPaintedFrame,
  type FrameRequest,
} from "./frameSlicedInitialization";

export interface PaintedStartupStageOptions {
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  readonly onBuilt?: (stage: string) => void;
  readonly onPainted?: (stage: string) => void;
}

/**
 * 构建一个同步启动组件，然后将下一个组件保留在有保证的绘制后面。在绘制的两侧都会检查取消，因此中止的所有者无法继续改变图表。
 *
 * 英文 / English: Build a component that starts synchronously and then holds the next component behind a guaranteed draw. Cancellation is checked on both sides of the draw, so the aborted owner cannot continue to alter the chart.
 */
export async function buildPaintedStartupStage<T>(
  stage: string,
  build: () => T,
  options: PaintedStartupStageOptions = {},
): Promise<T> {
  throwIfAborted(options.signal);
  const value = build();
  options.onBuilt?.(stage);
  await waitForPaintedFrame(options.requestFrame);
  throwIfAborted(options.signal);
  options.onPainted?.(stage);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Painted startup assembly was aborted");
  error.name = "AbortError";
  throw error;
}
