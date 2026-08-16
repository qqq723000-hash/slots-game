import { afterAll, describe, expect, it, vi } from "vitest";
import type { GridCell } from "../src/app/state/types";

// Pixi 的 Node 构建会在首次创建 Graphics 时延迟创建 1x1 白色纹理。
// 最小 canvas 适配器可让此结构测试检查显示树，无需引入 jsdom 或浏览器渲染器。
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
  REEL_COMPOSITE_ROOT_NAME,
  REEL_ADDITIVE_FRAME_OVERLAY_NAME,
  REEL_WINNING_SYMBOL_ADDITIVE_OVERLAY_NAME,
  REEL_HARDWARE_NODE_NAMES,
  REEL_SET_DRAW_ORDER,
  REEL_WIN_LAYER_NAMES,
  PRIMAL_WINNING_WILD_ACTIVATED_MS,
  ReelSetView,
} = await import("../src/reels/ReelSetView");
const { BLEND_MODES, Container: PixiContainer, Point: PixiPoint } = await import("pixi.js");
const { ReelPerspectiveFilter } = await import("../src/reels/ReelPerspectiveFilter");
const { AnticipationView } = await import("../src/renderer/AnticipationView");
const {
  PRIMAL_REEL_MAX_PRELOADED_ROWS,
  PRIMAL_REEL_AUTHORED_INIT_BATCH_CAP,
  PRIMAL_REEL_SYMBOL_INIT_BATCH_CAP,
  REEL_VIEW_LAYER_NAMES,
  ReelView,
  reelCellStaysSharpDuringSpin,
  reelStopPresentationCell,
  reelViewportMaskGeometry,
} = await import("../src/reels/ReelView");
const { reelPresentationCellCount } = await import("../src/reels/reelMotion");
const { SymbolView } = await import("../src/reels/SymbolView");
const { PixiRenderer } = await import("../src/renderer/PixiRenderer");

afterAll(() => {
  for (const key of shimKeys) {
    const previous = previousGlobals.get(key);
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

type Container = import("pixi.js").Container;
type ReelViewInstance = InstanceType<typeof ReelView>;

function displayName(display: unknown): string | undefined {
  return (display as { name?: string }).name;
}

function installWinningCompositeStub(symbol: InstanceType<typeof SymbolView>) {
  const createView = () => {
    const tracks = new Map<number, { animation: { name: string }; trackTime: number }>();
    const slots = [
      {
        data: { blendMode: BLEND_MODES.NORMAL },
        blendMode: BLEND_MODES.NORMAL,
        currentSprite: { blendMode: BLEND_MODES.NORMAL, renderable: true },
        getAttachment: () => ({ region: { name: "normal/test-symbol" } }),
      },
      {
        data: { blendMode: BLEND_MODES.NORMAL },
        blendMode: BLEND_MODES.NORMAL,
        currentSprite: { blendMode: BLEND_MODES.NORMAL, renderable: true },
        getAttachment: () => ({ region: { name: "add/test-symbol-glow" } }),
      },
    ];
    const spine = new PixiContainer() as Container & {
      tint: number;
      state: {
        timeScale: number;
        hasAnimation: ReturnType<typeof vi.fn>;
        clearTracks: ReturnType<typeof vi.fn>;
        clearTrack: ReturnType<typeof vi.fn>;
        setAnimation: ReturnType<typeof vi.fn>;
        addAnimation: ReturnType<typeof vi.fn>;
        getCurrent: ReturnType<typeof vi.fn>;
      };
      skeleton: {
        slots: typeof slots;
        setToSetupPose: ReturnType<typeof vi.fn>;
      };
      update: ReturnType<typeof vi.fn>;
    };
    const state = {
      timeScale: 1,
      hasAnimation: vi.fn((animation: string) => (
        animation === "stop"
          || animation === "win"
          || animation === "collect"
          || animation === "hide"
          || animation === "x50"
      )),
      clearTracks: vi.fn(() => tracks.clear()),
      clearTrack: vi.fn((track: number) => tracks.delete(track)),
      setAnimation: vi.fn((track: number, animation: string) => {
        const entry = { animation: { name: animation }, trackTime: 0, mixDuration: 0.15 };
        tracks.set(track, entry);
        return entry;
      }),
      addAnimation: vi.fn((track: number, animation: string) => {
        const entry = { animation: { name: animation }, trackTime: 0, mixDuration: 0.15 };
        tracks.set(track, entry);
        return entry;
      }),
      getCurrent: vi.fn((track: number) => tracks.get(track) ?? null),
    };
    spine.tint = 0xffffff;
    spine.state = state;
    spine.skeleton = { slots, setToSetupPose: vi.fn() };
    spine.update = vi.fn((deltaSeconds: number) => {
      tracks.forEach((entry) => {
        entry.trackTime += deltaSeconds * state.timeScale;
      });
    });
    return { spine, slots };
  };

  const normal = createView();
  const additive = createView();
  const internals = symbol as unknown as {
    authoredLayer: Container;
    authoredView: unknown;
    authoredAdditiveView: unknown;
    additiveCompositeActive: boolean;
    additivePlaybackRunning: boolean;
    activeAdditiveAttachmentCount: number;
  };
  internals.authoredLayer.addChild(normal.spine);
  symbol.winningAdditiveDisplay.addChild(additive.spine);
  internals.authoredView = normal.spine;
  internals.authoredAdditiveView = additive.spine;
  internals.additiveCompositeActive = false;
  internals.additivePlaybackRunning = false;
  internals.activeAdditiveAttachmentCount = 0;
  return { normal, additive, internals };
}

describe("Primal official reel composite contract", () => {
  it("keeps an authoritative Wild plain on the travelling belt until reveal", () => {
    expect(reelStopPresentationCell({ symbol: "WILD", multiplier: 100 }))
      .toEqual({ symbol: "WILD" });
    expect(reelStopPresentationCell({ symbol: "VAULT", multiplier: 10, prize: "MINI" }))
      .toEqual({ symbol: "VAULT", multiplier: 10, prize: "MINI" });
  });

  it("projects one shared reel composite whose fallback layers retain their order", () => {
    const view = new ReelSetView();
    expect(view.children.map(displayName)).toEqual([REEL_COMPOSITE_ROOT_NAME]);
    const composite = view.children[0] as Container;
    expect(view.filters).toHaveLength(1);
    expect(view.filters?.[0]).toBeInstanceOf(ReelPerspectiveFilter);
    expect(composite.filters).toBeNull();
    expect(displayName(view.additiveFrameOverlay)).toBe(REEL_ADDITIVE_FRAME_OVERLAY_NAME);
    expect(displayName(view.winningSymbolAdditiveOverlay))
      .toBe(REEL_WINNING_SYMBOL_ADDITIVE_OVERLAY_NAME);
    expect(view.additiveFrameOverlay.parent).toBeNull();
    expect(view.winningSymbolAdditiveOverlay.parent).toBeNull();
    expect(view.additiveFrameOverlay.filters).toHaveLength(1);
    expect(view.additiveFrameOverlay.filters?.[0]).toBeInstanceOf(ReelPerspectiveFilter);
    expect(view.additiveFrameOverlay.filters?.[0]?.state.blendMode).toBe(BLEND_MODES.ADD);
    expect(view.winningSymbolAdditiveOverlay.filters).toHaveLength(1);
    expect(view.winningSymbolAdditiveOverlay.filters?.[0]).toBeInstanceOf(ReelPerspectiveFilter);
    expect(view.winningSymbolAdditiveOverlay.filters?.[0]?.state.blendMode)
      .toBe(BLEND_MODES.ADD);
    view.setPerspectiveCoordinateScale(1);
    expect(view.filters?.[0]?.uniforms.uDepth).toBe(1.5);
    expect(view.additiveFrameOverlay.filters?.[0]?.uniforms.uDepth).toBe(1.5);
    expect(view.winningSymbolAdditiveOverlay.filters?.[0]?.uniforms.uDepth).toBe(1.5);
    const filters = [
      view.filters?.[0],
      view.additiveFrameOverlay.filters?.[0],
      view.winningSymbolAdditiveOverlay.filters?.[0],
    ];
    expect(filters.map((filter) => filter!.resolution)).toEqual([1, 1, 1]);
    expect(view.getPerspectiveDiagnostics().resolutions).toEqual({
      normal: 1,
      additiveFrame: 1,
      winningSymbolAdditive: 1,
    });
    expect(filters.map((filter) => [...filter!.uniforms.uAngle])).toEqual([
      [0, -0.1],
      [0, -0.1],
      [0, -0.1],
    ]);
    view.setPerspectiveCoordinateScale(2);
    expect(filters.map((filter) => filter!.uniforms.uDepth)).toEqual([3, 3, 3]);
    expect(filters.map((filter) => filter!.resolution)).toEqual([2, 2, 2]);
    expect(view.getPerspectiveDiagnostics().resolutions).toEqual({
      normal: 2,
      additiveFrame: 2,
      winningSymbolAdditive: 2,
    });

    view.alpha = 0.4;
    view.visible = false;
    view.renderable = false;
    view.update(0);
    expect(view.additiveFrameOverlay.alpha).toBe(0.4);
    expect(view.additiveFrameOverlay.visible).toBe(false);
    expect(view.additiveFrameOverlay.renderable).toBe(false);
    expect(view.winningSymbolAdditiveOverlay.alpha).toBe(0.4);
    expect(view.winningSymbolAdditiveOverlay.visible).toBe(false);
    expect(view.winningSymbolAdditiveOverlay.renderable).toBe(false);
    expect(composite.children.map(displayName)).toEqual(REEL_SET_DRAW_ORDER);

    const [tracks, symbols, outerFrame, middleFrame] = composite.children as Container[];
    expect(tracks).toBeDefined();
    expect(symbols).toBeDefined();
    expect(middleFrame).toBeDefined();
    expect(outerFrame).toBeDefined();

    expect(tracks?.children.map(displayName).filter(Boolean)).toEqual([
      `${REEL_VIEW_LAYER_NAMES.track}-1`,
      `${REEL_VIEW_LAYER_NAMES.track}-2`,
      `${REEL_VIEW_LAYER_NAMES.track}-3`,
    ]);
    expect(symbols?.children.map(displayName)).toEqual([
      REEL_WIN_LAYER_NAMES.frames,
      `${REEL_VIEW_LAYER_NAMES.symbols}-3`,
      `${REEL_VIEW_LAYER_NAMES.symbols}-2`,
      `${REEL_VIEW_LAYER_NAMES.symbols}-1`,
      `${REEL_VIEW_LAYER_NAMES.shadow}-1`,
      `${REEL_VIEW_LAYER_NAMES.shadow}-2`,
      `${REEL_VIEW_LAYER_NAMES.shadow}-3`,
      REEL_WIN_LAYER_NAMES.activated,
    ]);
    expect(middleFrame?.children.length).toBeGreaterThan(0);
    expect(outerFrame?.children.length).toBeGreaterThan(0);
    expect(outerFrame?.children.map(displayName)).toContain(REEL_HARDWARE_NODE_NAMES.fallbackOuter);
    expect(middleFrame?.children.map(displayName)).toEqual(expect.arrayContaining([
      REEL_HARDWARE_NODE_NAMES.middleShadow,
      REEL_HARDWARE_NODE_NAMES.fallbackMiddle,
    ]));
    expect(composite.getChildIndex(outerFrame!)).toBeLessThan(
      composite.getChildIndex(middleFrame!),
    );
  });

  it("mounts projected renderer siblings in reels -> frame ADD -> symbol ADD -> anticipation order", () => {
    const source = PixiRenderer.toString();
    const start = source.indexOf("this.camera.gameLayer.addChild(");
    expect(start).toBeGreaterThanOrEqual(0);
    const call = source.slice(start, source.indexOf(");", start) + 2);
    const orderedNodes = [
      "this.reels,",
      "this.reels.additiveFrameOverlay,",
      "this.reels.winningSymbolAdditiveOverlay,",
      "this.anticipation",
    ];
    const offsets = orderedNodes.map((node) => call.indexOf(node));

    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    const anticipation = new AnticipationView();
    expect(anticipation.filters?.[0]).toBeInstanceOf(ReelPerspectiveFilter);
    expect(anticipation.filters?.[0]?.state.blendMode).toBe(BLEND_MODES.ADD);
    anticipation.destroy({ children: true });
  });

  it("sends one renderer resolution to the reel and anticipation perspective passes", () => {
    const source = PixiRenderer.toString();

    expect(source).toContain("this.reels.setPerspectiveCoordinateScale(resolution);");
    expect(source).toContain("this.anticipation.setPerspectiveCoordinateScale(resolution);");
  });

  it("can mount reel-owned non-additive effects below reel hardware", () => {
    const view = new ReelSetView();
    const effect = new PixiContainer();
    view.mountSymbolEffect(effect);

    const composite = view.children[0] as Container;
    const symbolLayer = composite.children[1] as Container;
    expect(effect.parent).toBe(symbolLayer);
    expect(symbolLayer.children.at(-1)).toBe(effect);
    expect(composite.getChildIndex(symbolLayer)).toBeLessThan(2);
  });

  it("keeps WinBox below symbols and promotes a winning Wild for exactly 1000ms", () => {
    const view = new ReelSetView();
    const winBox = new PixiContainer();
    view.mountWinFrameEffect(winBox);
    view.setGrid([
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
      [{ symbol: "WILD", multiplier: 2 }, { symbol: "ORBIT" }, { symbol: "PRISM" }],
      [{ symbol: "TANK" }, { symbol: "PULSE" }, { symbol: "CIRCUIT" }],
    ]);

    const composite = view.children[0] as Container;
    const symbolLayer = composite.children[1] as Container;
    const winFrameLayer = symbolLayer.children.find((child) => (
      displayName(child) === REEL_WIN_LAYER_NAMES.frames
    )) as Container;
    const activatedLayer = symbolLayer.children.find((child) => (
      displayName(child) === REEL_WIN_LAYER_NAMES.activated
    )) as Container;
    expect(winBox.parent).toBe(winFrameLayer);
    expect(symbolLayer.getChildIndex(winFrameLayer)).toBeLessThan(
      symbolLayer.children.findIndex((child) => displayName(child) === `${REEL_VIEW_LAYER_NAMES.symbols}-2`),
    );

    view.highlight([{ reel: 1, row: 0 }]);
    expect(activatedLayer.children).toHaveLength(1);
    view.update(PRIMAL_WINNING_WILD_ACTIVATED_MS - 1);
    expect(activatedLayer.children).toHaveLength(1);
    view.update(1);
    expect(activatedLayer.children).toHaveLength(0);

    view.highlight([{ reel: 1, row: 0 }]);
    expect(activatedLayer.children).toHaveLength(1);
    view.clearHighlights();
    expect(activatedLayer.children).toHaveLength(0);
  });

  it("promotes and restores a winning Wild through matching NORMAL and ADD owners", () => {
    const view = new ReelSetView();
    view.setGrid([
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
      [{ symbol: "WILD", multiplier: 50 }, { symbol: "ORBIT" }, { symbol: "PRISM" }],
      [{ symbol: "TANK" }, { symbol: "PULSE" }, { symbol: "CIRCUIT" }],
    ]);
    const internals = view as unknown as {
      reels: Array<{ symbolViews: Array<InstanceType<typeof SymbolView>> }>;
      activatedSymbolLayer: Container;
      winningSymbolAdditiveActivatedLayer: Container;
    };
    const wild = internals.reels[1]!.symbolViews[0]!;
    const normalOwner = wild.parent;
    const additiveOwner = wild.winningAdditiveDisplay.parent;
    const normalBefore = wild.toGlobal(new PixiPoint(0, 0));
    const additiveBefore = wild.winningAdditiveDisplay.toGlobal(new PixiPoint(0, 0));

    view.highlight([{ reel: 1, row: 0 }]);

    expect(wild.parent).toBe(internals.activatedSymbolLayer);
    expect(wild.winningAdditiveDisplay.parent)
      .toBe(internals.winningSymbolAdditiveActivatedLayer);
    expect(wild.toGlobal(new PixiPoint(0, 0))).toMatchObject({
      x: normalBefore.x,
      y: normalBefore.y,
    });
    expect(wild.winningAdditiveDisplay.toGlobal(new PixiPoint(0, 0))).toMatchObject({
      x: additiveBefore.x,
      y: additiveBefore.y,
    });

    view.update(PRIMAL_WINNING_WILD_ACTIVATED_MS);
    expect(wild.parent).toBe(normalOwner);
    expect(wild.winningAdditiveDisplay.parent).toBe(additiveOwner);
    expect(internals.activatedSymbolLayer.children).toHaveLength(0);
    expect(internals.winningSymbolAdditiveActivatedLayer.children).toHaveLength(0);

    view.highlight([{ reel: 1, row: 0 }]);
    view.clearHighlights();
    expect(wild.parent).toBe(normalOwner);
    expect(wild.winningAdditiveDisplay.parent).toBe(additiveOwner);

    view.highlight([{ reel: 1, row: 0 }]);
    view.beginSpin();
    expect(wild.parent).toBe(normalOwner);
    expect(wild.winningAdditiveDisplay.parent).toBe(additiveOwner);
    expect(internals.activatedSymbolLayer.children).toHaveLength(0);
    expect(internals.winningSymbolAdditiveActivatedLayer.children).toHaveLength(0);
  });

  it("moves and restores collected Rage through matching NORMAL and ADD owners", () => {
    const view = new ReelSetView();
    view.setGrid([
      [{ symbol: "SURGE" }, { symbol: "PRISM" }, { symbol: "ORBIT" }],
      [{ symbol: "TANK" }, { symbol: "NOVA" }, { symbol: "PRISM" }],
      [{ symbol: "CIRCUIT" }, { symbol: "PULSE" }, { symbol: "ORBIT" }],
    ]);
    const internals = view as unknown as {
      reels: Array<{ symbolViews: Array<InstanceType<typeof SymbolView>> }>;
      activatedSymbolLayer: Container;
      winningSymbolAdditiveActivatedLayer: Container;
    };
    const rage = internals.reels[0]!.symbolViews[0]!;
    installWinningCompositeStub(rage);
    const normalOwner = rage.parent;
    const additiveOwner = rage.winningAdditiveDisplay.parent;
    const normalBefore = rage.toGlobal(new PixiPoint(0, 0));
    const additiveBefore = rage.winningAdditiveDisplay.toGlobal(new PixiPoint(0, 0));

    expect(view.beginSurgeCollection({ reel: 0, row: 0 })).toBe(true);
    expect(view.areSurgeCollectionsActivated([{ reel: 0, row: 0 }])).toBe(true);
    expect(rage.parent).toBe(internals.activatedSymbolLayer);
    expect(rage.winningAdditiveDisplay.parent)
      .toBe(internals.winningSymbolAdditiveActivatedLayer);
    expect(rage.toGlobal(new PixiPoint(0, 0))).toMatchObject(normalBefore);
    expect(rage.winningAdditiveDisplay.toGlobal(new PixiPoint(0, 0)))
      .toMatchObject(additiveBefore);

    expect(view.restoreSurgeCollectionLayer({ reel: 0, row: 0 })).toBe(true);
    expect(rage.parent).toBe(normalOwner);
    expect(rage.winningAdditiveDisplay.parent).toBe(additiveOwner);
    expect(internals.activatedSymbolLayer.children).toHaveLength(0);
    expect(internals.winningSymbolAdditiveActivatedLayer.children).toHaveLength(0);
  });

  it("clears hidden 3x8 winning ADD instances before applying a new 3-row grid", () => {
    const view = new ReelSetView();
    const expandedGrid = Array.from({ length: 3 }, (_unused, reel) => (
      Array.from({ length: 8 }, (_cell, row) => ({
        symbol: reel === 0 && row === 7 ? "PULSE" as const : "PRISM" as const,
      }))
    ));
    view.setGrid(expandedGrid);
    const internals = view as unknown as {
      reels: Array<{ symbolViews: Array<InstanceType<typeof SymbolView>> }>;
    };
    const pooledWinner = internals.reels[0]!.symbolViews[7]!;
    const composite = installWinningCompositeStub(pooledWinner);

    view.highlight([{ reel: 0, row: 7 }]);
    expect(composite.internals.additiveCompositeActive).toBe(true);
    expect(pooledWinner.winningAdditiveDisplay.visible).toBe(true);

    view.setGrid(Array.from({ length: 3 }, () => (
      Array.from({ length: 3 }, () => ({ symbol: "PRISM" as const }))
    )));

    expect(pooledWinner.visible).toBe(false);
    expect((pooledWinner as unknown as { highlighted: boolean }).highlighted).toBe(false);
    expect(composite.internals.additiveCompositeActive).toBe(false);
    expect(pooledWinner.winningAdditiveDisplay.visible).toBe(false);
    const additiveUpdatesAfterGrid = composite.additive.spine.update.mock.calls.length;
    view.update(16);
    expect(composite.additive.spine.update).toHaveBeenCalledTimes(additiveUpdatesAfterGrid);
  });

  it("freezes a high-symbol ADD clock while the next spin hides settled output", () => {
    const view = new ReelSetView();
    view.setGrid([
      [{ symbol: "PULSE" }, { symbol: "PRISM" }, { symbol: "ORBIT" }],
      [{ symbol: "TANK" }, { symbol: "NOVA" }, { symbol: "PRISM" }],
      [{ symbol: "CIRCUIT" }, { symbol: "PULSE" }, { symbol: "ORBIT" }],
    ]);
    const internals = view as unknown as {
      reels: Array<{ symbolViews: Array<InstanceType<typeof SymbolView>> }>;
    };
    const winner = internals.reels[0]!.symbolViews[0]!;
    const composite = installWinningCompositeStub(winner);
    view.highlight([{ reel: 0, row: 0 }]);
    expect(composite.internals.additiveCompositeActive).toBe(true);
    expect(winner.winningAdditiveDisplay.visible).toBe(true);

    view.beginSpin();

    expect((winner as unknown as { highlighted: boolean }).highlighted).toBe(false);
    expect(composite.internals.additiveCompositeActive).toBe(true);
    expect(composite.internals.additivePlaybackRunning).toBe(false);
    expect(winner.winningAdditiveDisplay.visible).toBe(true);
    expect(winner.winningAdditiveDisplay.parent?.alpha).toBe(0);
    const additiveUpdatesAtSpinStart = composite.additive.spine.update.mock.calls.length;
    view.update(16);
    expect(composite.additive.spine.update).toHaveBeenCalledTimes(additiveUpdatesAtSpinStart);
  });

  it("destroys both external projected siblings during a mid-win reel teardown", () => {
    const owner = new PixiContainer();
    const view = new ReelSetView();
    const anticipation = new PixiContainer();
    owner.addChild(
      view,
      view.additiveFrameOverlay,
      view.winningSymbolAdditiveOverlay,
      anticipation,
    );
    view.setGrid([
      [{ symbol: "PULSE" }, { symbol: "PRISM" }, { symbol: "ORBIT" }],
      [{ symbol: "TANK" }, { symbol: "NOVA" }, { symbol: "PRISM" }],
      [{ symbol: "CIRCUIT" }, { symbol: "PULSE" }, { symbol: "ORBIT" }],
    ]);
    const internals = view as unknown as {
      reels: Array<{ symbolViews: Array<InstanceType<typeof SymbolView>> }>;
    };
    const winner = internals.reels[0]!.symbolViews[0]!;
    installWinningCompositeStub(winner);
    view.highlight([{ reel: 0, row: 0 }]);
    expect(winner.winningAdditiveDisplay.visible).toBe(true);

    view.destroy({ children: true });

    expect(view.destroyed).toBe(true);
    expect(view.additiveFrameOverlay.destroyed).toBe(true);
    expect(view.winningSymbolAdditiveOverlay.destroyed).toBe(true);
    expect(owner.children).toEqual([anticipation]);
  });

  it("promotes only the addressed collecting Rage above track shadows without moving it", () => {
    const view = new ReelSetView();
    view.setGrid([
      [{ symbol: "PRISM" }, { symbol: "CIRCUIT" }, { symbol: "PRISM" }],
      [{ symbol: "SURGE" }, { symbol: "PULSE" }, { symbol: "CIRCUIT" }],
      [{ symbol: "TANK" }, { symbol: "TANK" }, { symbol: "ORBIT" }],
    ]);

    const composite = view.children[0] as Container;
    const symbolLayer = composite.children[1] as Container;
    const activatedLayer = symbolLayer.children.find((child) => (
      displayName(child) === REEL_WIN_LAYER_NAMES.activated
    )) as Container;
    const middleReel = symbolLayer.children.find((child) => (
      displayName(child) === `${REEL_VIEW_LAYER_NAMES.symbols}-2`
    )) as ReelViewInstance;
    const middleSymbols = (middleReel as unknown as { symbolViews: Container[] }).symbolViews;
    const rage = middleSymbols[0]!;
    const originalParents = new Map<Container, Container | null>();
    for (const reel of symbolLayer.children.filter((child) => (
      displayName(child)?.startsWith(REEL_VIEW_LAYER_NAMES.symbols)
    )) as ReelViewInstance[]) {
      for (const symbol of (reel as unknown as { symbolViews: Container[] }).symbolViews.slice(0, 3)) {
        originalParents.set(symbol, symbol.parent);
      }
    }
    const before = rage.toGlobal(new PixiPoint(0, 0));

    view.beginSurgeCollection({ reel: 1, row: 0 });

    const after = rage.toGlobal(new PixiPoint(0, 0));
    expect(rage.parent).toBe(activatedLayer);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(symbolLayer.getChildIndex(activatedLayer)).toBeGreaterThan(
      Math.max(...symbolLayer.children.filter((child) => (
        displayName(child)?.startsWith(REEL_VIEW_LAYER_NAMES.shadow)
      )).map((child) => symbolLayer.getChildIndex(child))),
    );
    for (const [symbol, parent] of originalParents) {
      if (symbol !== rage) expect(symbol.parent).toBe(parent);
    }

    expect(view.restoreSurgeCollectionLayer({ reel: 1, row: 0 })).toBe(true);
    expect(rage.parent).toBe(originalParents.get(rage));
  });

  it("keeps Wild and collecting-Rage ownership independent in the shared activated layer", () => {
    const view = new ReelSetView();
    view.setGrid([
      [{ symbol: "PRISM" }, { symbol: "CIRCUIT" }, { symbol: "ORBIT" }],
      [{ symbol: "SURGE" }, { symbol: "WILD", multiplier: 2 }, { symbol: "PULSE" }],
      [{ symbol: "TANK" }, { symbol: "NOVA" }, { symbol: "ORBIT" }],
    ]);
    const composite = view.children[0] as Container;
    const symbolLayer = composite.children[1] as Container;
    const activatedLayer = symbolLayer.children.find((child) => (
      displayName(child) === REEL_WIN_LAYER_NAMES.activated
    )) as Container;
    const middleReel = symbolLayer.children.find((child) => (
      displayName(child) === `${REEL_VIEW_LAYER_NAMES.symbols}-2`
    )) as ReelViewInstance;
    const [rage, wild] = (middleReel as unknown as { symbolViews: Container[] }).symbolViews;

    view.highlight([{ reel: 1, row: 1 }]);
    view.beginSurgeCollection({ reel: 1, row: 0 });
    expect(rage?.parent).toBe(activatedLayer);
    expect(wild?.parent).toBe(activatedLayer);

    expect(view.restoreSurgeCollectionLayer({ reel: 1, row: 0 })).toBe(true);
    expect(rage?.parent).toBe(middleReel.children[0]);
    expect(wild?.parent).toBe(activatedLayer);

    view.beginSurgeCollection({ reel: 1, row: 0 });
    view.clearHighlights();
    expect(rage?.parent).toBe(activatedLayer);
    expect(wild?.parent).toBe(middleReel.children[0]);
  });

  it("clips each moving overlay while leaving settled symbols in an unmasked overlay", () => {
    const view = new ReelSetView();
    const composite = view.children[0] as Container;
    const tracks = composite.children[0] as Container;
    const symbols = composite.children[1] as Container;
    const reelViews = symbols.children
      .filter((child) => displayName(child)?.startsWith(REEL_VIEW_LAYER_NAMES.symbols))
      .reverse() as ReelViewInstance[];
    const shadows = symbols.children.filter((child) => (
      displayName(child)?.startsWith(REEL_VIEW_LAYER_NAMES.shadow)
    )) as Container[];

    reelViews.forEach((reel, index) => {
      const internals = reel as unknown as {
        clip: Container;
        maskedOverlay: Container;
        symbols: Container;
      };
      expect(reel.mask).toBeNull();
      expect(displayName(internals.maskedOverlay.mask)).toBe(
        `${REEL_VIEW_LAYER_NAMES.mask}-${index + 1}`,
      );
      expect(internals.maskedOverlay.mask).toBe(internals.clip);
      expect(internals.symbols.mask).toBeNull();
      expect(internals.clip.parent).toBe(reel);
      expect(reel.trackDisplay.parent).toBe(tracks);
      expect(reel.trackShadowDisplay).toBe(shadows[index]);
      expect(reel.trackShadowDisplay.parent).toBe(symbols);
    });
  });

  it("swaps directly to the moving belt and releases the settled mask at visual impact", () => {
    const reel = new ReelView(0);
    const internals = reel as unknown as {
      clip: Container;
      maskedOverlay: Container;
      motionLayer: Container;
      symbols: Container;
      stopImpactCommitted: boolean;
      stopImpactRequestedMode: "NORMAL" | "FAST" | "SLOW" | null;
      stopTargetRows: number | null;
      stopPresentationRows: number;
      stopTargetReached: boolean;
      commitRequestedStopImpact(): void;
    };

    reel.beginSpin(false);

    expect(internals.motionLayer.visible).toBe(true);
    expect(internals.motionLayer.alpha).toBe(1);
    expect(internals.symbols.alpha).toBe(0);
    expect(internals.symbols.mask).toBe(internals.clip);

    reel.commitStopImpact("FAST");
    expect(internals.stopImpactCommitted).toBe(false);
    expect(internals.stopImpactRequestedMode).toBe("FAST");
    expect(internals.motionLayer.visible).toBe(true);
    expect(internals.symbols.alpha).toBe(0);
    expect(internals.symbols.mask).toBe(internals.clip);

    internals.stopTargetRows = 5;
    internals.stopPresentationRows = 5;
    internals.stopTargetReached = true;
    internals.commitRequestedStopImpact();

    expect(internals.stopImpactCommitted).toBe(true);
    expect(internals.stopImpactRequestedMode).toBeNull();
    expect(internals.motionLayer.visible).toBe(false);
    expect(internals.symbols.alpha).toBe(1);
    expect(internals.symbols.y).toBe(0);
    expect(internals.symbols.mask).toBeNull();
  });

  it("preallocates the complete 3x8 symbol graph in bounded per-axis frames", async () => {
    const view = new ReelSetView();
    let frames = 0;
    const progress: number[] = [];

    await view.prepareMaximumRows({
      requestFrame: async () => { frames += 1; },
      onProgress: (fraction) => progress.push(fraction),
    });

    const reels = (view as unknown as {
      reels: Array<{
        rowCount: number;
        layoutCellHeight: number;
        layoutTopOffset: number;
        symbolOffsetX: number;
        symbolViews: Array<{
          visible: boolean;
          position: { x: number; y: number };
        }>;
        spinSymbolViews: unknown[];
      }>;
    }).reels;
    expect(reels).toHaveLength(3);
    reels.forEach((reel) => {
      expect(reel.symbolViews).toHaveLength(PRIMAL_REEL_MAX_PRELOADED_ROWS);
      expect(reel.spinSymbolViews).toHaveLength(
        reelPresentationCellCount(PRIMAL_REEL_MAX_PRELOADED_ROWS),
      );
      expect(reel.rowCount).toBe(3);
      reel.symbolViews.forEach((symbol, row) => {
        expect(symbol.visible).toBe(row < reel.rowCount);
        expect(symbol.position.x).toBeCloseTo(reel.symbolOffsetX, 10);
        expect(symbol.position.y).toBe(
          reel.layoutTopOffset + row * reel.layoutCellHeight,
        );
      });
    });
    const perReelObjects = (PRIMAL_REEL_MAX_PRELOADED_ROWS - 3)
      + reelPresentationCellCount(PRIMAL_REEL_MAX_PRELOADED_ROWS);
    expect(frames).toBe(
      Math.ceil(perReelObjects / PRIMAL_REEL_SYMBOL_INIT_BATCH_CAP) * 3,
    );
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("enables every settled authored Spine view in bounded per-axis frames", async () => {
    const view = new ReelSetView();
    await view.prepareMaximumRows({ requestFrame: async () => undefined });
    let frames = 0;
    const progress: number[] = [];

    await view.setAuthoredSymbolsEnabledFrameSliced(true, {
      requestFrame: async () => { frames += 1; },
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(frames).toBe(
      Math.ceil(
        (PRIMAL_REEL_MAX_PRELOADED_ROWS + 1) / PRIMAL_REEL_AUTHORED_INIT_BATCH_CAP,
      ) * 3,
    );
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("rolls back a partially enabled authored batch when launch is aborted", async () => {
    const view = new ReelSetView();
    await view.prepareMaximumRows({ requestFrame: async () => undefined });
    const controller = new AbortController();
    let frame = 0;

    await expect(view.setAuthoredSymbolsEnabledFrameSliced(true, {
      signal: controller.signal,
      requestFrame: async () => {
        frame += 1;
        if (frame === 2) controller.abort(new Error("cancel authored symbols"));
      },
    })).rejects.toThrow("cancel authored symbols");

    const reels = (view as unknown as {
      reels: Array<{
        authoredSymbolsEnabled: boolean;
        symbolViews: Array<{ authoredEnabled: boolean }>;
      }>;
    }).reels;
    expect(reels.every((reel) => reel.authoredSymbolsEnabled === false)).toBe(true);
    expect(reels.flatMap((reel) => reel.symbolViews).every(
      (symbol) => symbol.authoredEnabled === false,
    )).toBe(true);
  });

  it("cancels detached reel pool construction when its owner is destroyed", async () => {
    const reel = new ReelView(0);
    let releaseFrame: (() => void) | undefined;
    const preparation = reel.prepareMaximumRows({
      requestFrame: () => new Promise<void>((resolve) => { releaseFrame = resolve; }),
    });

    releaseFrame?.();
    await Promise.resolve();
    await Promise.resolve();
    reel.destroy({ children: true });
    releaseFrame?.();

    await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the same exact rectangular combined-mask geometry on all reels", () => {
    for (const [width, height] of [[154.693, 309.386], [75.6, 403.2]] as const) {
      const left = reelViewportMaskGeometry(0, width, height, true);
      const middle = reelViewportMaskGeometry(1, width, height, true);
      const right = reelViewportMaskGeometry(2, width, height, true);
      expect(left).toEqual(right);
      expect(middle).toEqual(left);
      expect(middle).toEqual({ x: 0, y: 0, width, height, radius: 0 });
      expect(middle.radius).toBe(0);
    }
  });

  it("removes procedural track depth when the complete authored frame owns it", () => {
    const reel = new ReelView(1);
    const internals = reel as unknown as {
      trackShadow: Container;
      glassBackdrop: Container;
      glassSurface: Container;
      environmentReflection: Container;
      environmentCoreReflection: Container;
    };

    reel.setAuthoredCabinet(true);

    expect(internals.trackShadow.visible).toBe(false);
    expect(internals.trackShadow.renderable).toBe(false);
    expect(internals.glassBackdrop.visible).toBe(false);
    expect(internals.glassSurface.visible).toBe(false);
    expect(internals.environmentReflection.visible).toBe(false);
    expect(internals.environmentCoreReflection.visible).toBe(false);
  });

  it("keeps only Rage and unlocked Vault symbols sharp during reel motion", () => {
    expect(reelCellStaysSharpDuringSpin({ symbol: "SURGE" })).toBe(true);
    expect(reelCellStaysSharpDuringSpin({ symbol: "VAULT", prize: "GRAND" })).toBe(true);
    expect(reelCellStaysSharpDuringSpin({ symbol: "VAULT", multiplier: 5 })).toBe(true);
    expect(reelCellStaysSharpDuringSpin({ symbol: "VAULT" })).toBe(false);
    expect(reelCellStaysSharpDuringSpin({ symbol: "TANK" })).toBe(false);
  });

  it("hides a collected Rage without replacing or tinting its stable track", () => {
    const reel = new ReelView(1);
    reel.setLayout(160, 320, 3);
    const cells: GridCell[] = [
      { symbol: "PRISM" },
      { symbol: "SURGE" },
      { symbol: "TANK" },
    ];
    reel.setCells(cells);
    const track = reel.trackDisplay;
    const before = {
      alpha: track.alpha,
      visible: track.visible,
      children: [...track.children],
      position: track.position.clone(),
    };

    reel.completeSurgeCollection(1);

    expect(track.alpha).toBe(before.alpha);
    expect(track.visible).toBe(before.visible);
    expect(track.children).toEqual(before.children);
    expect(track.position).toEqual(before.position);
  });

  it("treats a pre-existing Rage cascade cell as an intentional no-op", () => {
    const reel = new ReelView(1);
    reel.setLayout(160, 320, 3);
    reel.setCells([
      { symbol: "PRISM" },
      { symbol: "SURGE" },
      { symbol: "TANK" },
    ]);

    expect(reel.revealRageCascadeCell(1, false)).toBe(true);
  });

  it("holds an exploded source at the authored terminal pose instead of restoring idle", () => {
    const symbol = new SymbolView(true);
    const setAnimation = vi.fn();
    const addAnimation = vi.fn();
    const update = vi.fn();
    Object.assign(symbol as object, {
      currentCell: { symbol: "TANK" },
      authoredView: {
        state: {
          hasAnimation: (name: string) => name === "explosion" || name === "idle",
          setAnimation,
          addAnimation,
        },
        update,
      },
    });

    expect(symbol.playExplosionAnimation()).toBe(true);
    expect(setAnimation).toHaveBeenCalledWith(0, "explosion", false);
    expect(addAnimation).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(0);
  });
});
