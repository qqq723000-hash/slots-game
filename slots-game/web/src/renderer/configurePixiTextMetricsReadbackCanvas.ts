import { TextMetrics } from "pixi.js";

interface PixiTextMetricsInternals {
  __canvas?: HTMLCanvasElement;
  __context?: CanvasRenderingContext2D;
}

/**
 * 在其大量读回的 measureFont 路径延迟创建无提示画布之前，种子 Pixi 6.5.2 的字体指标缓存。
 *
 * 英文 / English: Seeds Pixi 6.5.2's font metrics cache before lazily creating a silent canvas for its bulk readback of measureFont paths.
 */
export function configurePixiTextMetricsReadbackCanvas(): boolean {
  const internals = TextMetrics as unknown as PixiTextMetricsInternals;

  if (
    typeof document === "undefined"
    || internals.__canvas
    || internals.__context
  ) {
    return false;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;

  internals.__canvas = canvas;
  internals.__context = context;
  return true;
}
