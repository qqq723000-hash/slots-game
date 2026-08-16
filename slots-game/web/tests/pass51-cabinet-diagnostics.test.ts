import { afterAll, describe, expect, it } from "vitest";

class TestElement {}
class TestImageElement extends TestElement {}
class TestVideoElement extends TestElement {}
class TestImageBitmap extends TestElement {}
class TestSvgElement extends TestElement {}
class TestCanvas extends TestElement {
  width = 0;
  height = 0;
  style = {};

  getContext(): object {
    return {
      fillStyle: "",
      strokeStyle: "",
      font: "",
      lineWidth: 0,
      lineJoin: "",
      miterLimit: 0,
      textBaseline: "",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      fillRect: () => undefined,
      clearRect: () => undefined,
      setTransform: () => undefined,
      scale: () => undefined,
      strokeText: () => undefined,
      fillText: () => undefined,
      measureText: () => ({
        width: 100,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 2,
      }),
    };
  }
}

const shimKeys = [
  "HTMLImageElement",
  "HTMLVideoElement",
  "ImageBitmap",
  "HTMLCanvasElement",
  "SVGElement",
  "document",
] as const;
const previousGlobals = new Map(shimKeys.map((key) => [key, Reflect.get(globalThis, key)]));
Object.assign(globalThis, {
  HTMLImageElement: TestImageElement,
  HTMLVideoElement: TestVideoElement,
  ImageBitmap: TestImageBitmap,
  HTMLCanvasElement: TestCanvas,
  SVGElement: TestSvgElement,
  document: { createElement: () => new TestCanvas() },
});

const {
  REEL_ADDITIVE_FRAME_OVERLAY_NAME,
  REEL_SET_DRAW_ORDER,
  ReelSetView,
} = await import("../src/reels/ReelSetView");
const { Container } = await import("pixi.js");
const {
  publishReelCabinetCompositionDiagnostics,
} = await import("../src/testing/visualFixtureObservation");
type PixiContainer = import("pixi.js").Container;

afterAll(() => {
  for (const key of shimKeys) {
    const previous = previousGlobals.get(key);
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value as Record<string, unknown>).forEach(expectDeepFrozen);
}

function fakeFrame(animation = "stop"): PixiContainer & {
  state: { getCurrent(track: number): object | null };
} {
  const frame = new Container() as PixiContainer & {
    state: { getCurrent(track: number): object | null };
  };
  frame.state = {
    getCurrent: (track: number) => track === 0
      ? { animation: { name: animation }, loop: false, trackTime: 0.75 }
      : null,
  };
  return frame;
}

describe("Pass51 settled Base cabinet capture diagnostics", () => {
  it("reports the live fallback hierarchy, three equal masks, and frozen plain data", () => {
    const view = new ReelSetView();
    const diagnostics = view.getCabinetCompositionDiagnostics();

    expect(diagnostics.activeRows).toBe(3);
    expect(diagnostics.frameMode).toBe("fallback");
    expect(diagnostics.reelMotionRoot.orderedChildNames).toEqual(REEL_SET_DRAW_ORDER);
    expect(diagnostics.normalFrame).toBeNull();
    expect(diagnostics.additiveFrame).toBeNull();
    expect(diagnostics.frameInstances).toEqual({
      normalInComposite: 0,
      additiveInExternalOverlay: 0,
    });
    expect(diagnostics.transform.worldPosition).toEqual(
      diagnostics.transform.localPosition,
    );
    expect(diagnostics.transform.localScale).toEqual({ x: 1, y: 1 });
    expect(diagnostics.transform.worldScale).toEqual({ x: 1, y: 1 });
    expect(diagnostics.reels).toHaveLength(3);
    expect(diagnostics.reels.map(({ reelIndex }) => reelIndex)).toEqual([0, 1, 2]);
    expect(diagnostics.reels.map(({ maskRect }) => maskRect)).toEqual([
      diagnostics.reels[0]?.maskRect,
      diagnostics.reels[0]?.maskRect,
      diagnostics.reels[0]?.maskRect,
    ]);
    diagnostics.reels.forEach((reel) => {
      expect(reel.maskRect.width).toBeCloseTo(141.93, 10);
      expect(reel.maskRect.height).toBeCloseTo(273.6, 10);
      expect(reel.movingOverlayMasked).toBe(true);
      expect(reel.settledOverlayMasked).toBe(false);
    });
    expect(diagnostics.perspective).toMatchObject({
      attached: true,
      enabled: true,
      resolution: 2,
      resolutions: {
        normal: 2,
        additiveFrame: 2,
        winningSymbolAdditive: 2,
      },
      angle: [0, -0.1],
      effectiveDepth: 3,
      sourceFrame: null,
    });
    expectDeepFrozen(diagnostics);
    expect(() => {
      (diagnostics.reelMotionRoot.orderedChildNames as string[]).push("mutated");
    }).toThrow();
  });

  it("proves one normal authored frame plus its external additive pass from live parents", () => {
    const view = new ReelSetView();
    const normal = fakeFrame();
    const additive = fakeFrame();
    normal.position.set(212.895, 136.8);
    normal.scale.set(0.5757);
    additive.position.copyFrom(normal.position);
    additive.scale.copyFrom(normal.scale);

    const internals = view as unknown as {
      authoredFrame: typeof normal | null;
      authoredFrameAdditive: typeof additive | null;
      trackLayer: PixiContainer;
    };
    internals.authoredFrame = normal;
    internals.authoredFrameAdditive = additive;
    internals.trackLayer.addChildAt(normal, 0);
    view.additiveFrameOverlay.addChild(additive);

    const diagnostics = view.getCabinetCompositionDiagnostics();
    expect(diagnostics.frameMode).toBe("authored");
    expect(diagnostics.frameInstances).toEqual({
      normalInComposite: 1,
      additiveInExternalOverlay: 1,
    });
    expect(diagnostics.normalFrame).toMatchObject({
      parentChildIndex: 0,
      position: { x: 212.895, y: 136.8 },
      scale: { x: 0.5757, y: 0.5757 },
      animation: { name: "stop", loop: false, trackTime: 0.75 },
    });
    expect(diagnostics.additiveFrame).toMatchObject({
      parentName: REEL_ADDITIVE_FRAME_OVERLAY_NAME,
      parentChildIndex: 0,
      animation: { name: "stop" },
    });
    expectDeepFrozen(diagnostics);
  });

  it("tracks the live effective depth and publishes the complete JSON snapshot", () => {
    const view = new ReelSetView();
    view.setPerspectiveCoordinateScale(1);
    expect(view.getCabinetCompositionDiagnostics().perspective.effectiveDepth).toBe(1.5);
    expect(view.getCabinetCompositionDiagnostics().perspective.resolutions).toEqual({
      normal: 1,
      additiveFrame: 1,
      winningSymbolAdditive: 1,
    });
    view.setPerspectiveCoordinateScale(2);
    const diagnostics = view.getCabinetCompositionDiagnostics();
    expect(diagnostics.perspective.effectiveDepth).toBe(3);
    expect(diagnostics.perspective.resolutions).toEqual({
      normal: 2,
      additiveFrame: 2,
      winningSymbolAdditive: 2,
    });

    const dataset: Record<string, string | undefined> = {};
    publishReelCabinetCompositionDiagnostics(dataset, diagnostics);
    expect(JSON.parse(dataset.fixtureReelCabinetComposition ?? "null")).toEqual(diagnostics);
  });
});
