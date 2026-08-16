import { afterEach, describe, expect, it, vi } from "vitest";
import { TextMetrics } from "pixi.js";
import {
  configurePixiTextMetricsReadbackCanvas,
} from "../src/renderer/configurePixiTextMetricsReadbackCanvas";

interface PixiTextMetricsInternals {
  __canvas?: HTMLCanvasElement;
  __context?: CanvasRenderingContext2D;
}

const internalMetrics = TextMetrics as unknown as PixiTextMetricsInternals;
const originalDocument = Reflect.get(globalThis, "document");

afterEach(() => {
  internalMetrics.__canvas = undefined;
  internalMetrics.__context = undefined;
  TextMetrics.clearMetrics();
  Reflect.set(globalThis, "document", originalDocument);
  vi.restoreAllMocks();
});

describe("Pass 132 Pixi TextMetrics readback canvas", () => {
  it("seeds Pixi's font-metrics singleton with a readback-optimized 2D context", () => {
    const context = {
      measureText: vi.fn(() => ({ width: 10 })),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(10 * 28 * 4) })),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal("document", { createElement });

    expect(configurePixiTextMetricsReadbackCanvas()).toBe(true);
    expect(createElement).toHaveBeenCalledOnce();
    expect(createElement).toHaveBeenCalledWith("canvas");
    expect(canvas.getContext).toHaveBeenCalledOnce();
    expect(canvas.getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
    expect(TextMetrics._canvas).toBe(canvas);
    expect(TextMetrics._context).toBe(context);
    TextMetrics.measureFont("10px Pass132MetricsProbe");
    expect(context.getImageData).toHaveBeenCalledOnce();
  });

  it("does not replace an already initialized Pixi metrics cache", () => {
    const existingCanvas = {} as HTMLCanvasElement;
    const existingContext = {} as CanvasRenderingContext2D;
    internalMetrics.__canvas = existingCanvas;
    internalMetrics.__context = existingContext;
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });

    expect(configurePixiTextMetricsReadbackCanvas()).toBe(false);
    expect(createElement).not.toHaveBeenCalled();
    expect(TextMetrics._canvas).toBe(existingCanvas);
    expect(TextMetrics._context).toBe(existingContext);
  });

  it("keeps the entrypoint ahead of the renderer-owning dynamic import without global hooks", async () => {
    const mainSource = await import("../src/main.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    const helperSource = await import(
      "../src/renderer/configurePixiTextMetricsReadbackCanvas.ts?raw"
    ).then((module) => (
      (module as unknown as { default: string }).default
    ));

    expect(mainSource.indexOf("configurePixiTextMetricsReadbackCanvas()"))
      .toBeLessThan(mainSource.indexOf('import("./app/AppController")'));
    expect(helperSource).not.toContain("HTMLCanvasElement.prototype");
    expect(helperSource).not.toContain("console.warn");
    expect(helperSource).not.toContain("document.createElement =");
  });
});
