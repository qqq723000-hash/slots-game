import { BLEND_MODES } from "pixi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnticipationView,
  enforceAnticipationAdditiveSlots,
  PRIMAL_ANTICIPATION_BASE_SCALE,
  PRIMAL_ANTICIPATION_ANIMATION,
  PRIMAL_ANTICIPATION_ANIMATION_MS,
  PRIMAL_ANTICIPATION_REEL_X,
  PRIMAL_ANTICIPATION_RUNTIME_FIT,
  PRIMAL_ANTICIPATION_TRACK,
  primalAnticipationTransform,
  primalAnticipationTransformFromReel,
} from "../src/renderer/AnticipationView";
import {
  REEL_AREA_HEIGHT,
  REEL_AREA_WIDTH,
  REEL_STAGE_Y,
  ReelSetView,
} from "../src/reels/ReelSetView";
import { ReelPerspectiveFilter } from "../src/reels/ReelPerspectiveFilter";
import { LOGICAL_WIDTH } from "../src/renderer/theme";
import {
  PRIMAL_SPINE_SPECS,
  primalSpineSkeletonUrl,
} from "../src/renderer/spine/PrimalSpineAssets";

const previousDocument = Reflect.get(globalThis, "document");
const previousHtmlImageElement = Reflect.get(globalThis, "HTMLImageElement");
const previousHtmlVideoElement = Reflect.get(globalThis, "HTMLVideoElement");
const previousImageBitmap = Reflect.get(globalThis, "ImageBitmap");
const previousHtmlCanvasElement = Reflect.get(globalThis, "HTMLCanvasElement");
const previousSvgElement = Reflect.get(globalThis, "SVGElement");

class TestElement {}
class TestImageElement extends TestElement {}
class TestVideoElement extends TestElement {}
class TestImageBitmap extends TestElement {}
class TestCanvasElement extends TestElement {
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
class TestSvgElement extends TestElement {}

beforeAll(() => {
  Reflect.set(globalThis, "HTMLImageElement", TestImageElement);
  Reflect.set(globalThis, "HTMLVideoElement", TestVideoElement);
  Reflect.set(globalThis, "ImageBitmap", TestImageBitmap);
  Reflect.set(globalThis, "HTMLCanvasElement", TestCanvasElement);
  Reflect.set(globalThis, "SVGElement", TestSvgElement);
  Reflect.set(globalThis, "document", {
    createElement: () => new TestCanvasElement(),
  });
});

afterAll(() => {
  if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
  else Reflect.set(globalThis, "document", previousDocument);
  const restore = (key: string, value: unknown): void => {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  };
  restore("HTMLImageElement", previousHtmlImageElement);
  restore("HTMLVideoElement", previousHtmlVideoElement);
  restore("ImageBitmap", previousImageBitmap);
  restore("HTMLCanvasElement", previousHtmlCanvasElement);
  restore("SVGElement", previousSvgElement);
});

describe("native reel anticipation", () => {
  it("projects the opaque RGB Spine through a final ADD perspective pass", () => {
    const view = new AnticipationView();

    expect(view.filters).toHaveLength(1);
    expect(view.filters?.[0]).toBeInstanceOf(ReelPerspectiveFilter);
    expect(view.filters?.[0]?.state.blendMode).toBe(BLEND_MODES.ADD);
    expect(view.getPerspectiveDiagnostics()).toMatchObject({
      attached: true,
      enabled: true,
      resolution: 2,
      effectiveDepth: 3,
      angle: [0, -0.1],
      blendMode: BLEND_MODES.ADD,
      appliedFrames: 0,
      sourceFrame: null,
      active: false,
      visible: false,
    });

    view.setPerspectiveCoordinateScale(1);
    expect(view.getPerspectiveDiagnostics()).toMatchObject({ resolution: 1, effectiveDepth: 1.5 });

    for (const scale of [2, 3, Number.NaN]) {
      view.setPerspectiveCoordinateScale(scale);
      expect(view.getPerspectiveDiagnostics()).toMatchObject({ resolution: 2, effectiveDepth: 3 });
    }

    view.destroy({ children: true });
  });

  it("keeps opaque RGB anticipation frames additive after attachment swaps", () => {
    const additiveSprite = { blendMode: BLEND_MODES.NORMAL };
    const additiveMesh = { blendMode: BLEND_MODES.NORMAL };
    const normalSprite = { blendMode: BLEND_MODES.NORMAL };
    const view = {
      skeleton: {
        slots: [
          {
            data: { blendMode: BLEND_MODES.NORMAL },
            blendMode: BLEND_MODES.NORMAL,
            getAttachment: () => ({ region: { name: "add/add_anticipation_frame" } }),
            currentSprite: additiveSprite,
            currentMesh: additiveMesh,
          },
          {
            data: { blendMode: BLEND_MODES.NORMAL },
            blendMode: BLEND_MODES.ADD,
            getAttachment: () => ({ region: { name: "normal/anticipation_shadow" } }),
            currentSprite: normalSprite,
          },
        ],
      },
    };

    expect(enforceAnticipationAdditiveSlots(view as never)).toBe(1);
    expect(view.skeleton.slots[0]?.blendMode).toBe(BLEND_MODES.ADD);
    expect(additiveSprite.blendMode).toBe(BLEND_MODES.ADD);
    expect(additiveMesh.blendMode).toBe(BLEND_MODES.ADD);
    expect(view.skeleton.slots[1]?.blendMode).toBe(BLEND_MODES.NORMAL);
    expect(normalSprite.blendMode).toBe(BLEND_MODES.NORMAL);
    expect(enforceAnticipationAdditiveSlots(null)).toBe(0);
  });

  it("registers the captured Spine 4.1 anticipation skeleton", () => {
    expect(PRIMAL_SPINE_SPECS.anticipation).toEqual({
      group: "spine_ui",
      skeleton: "anticipation",
      idleAnimation: "hidden",
    });
    expect(primalSpineSkeletonUrl("anticipation"))
      .toContain("/spine_ui/anticipation.skel");
  });

  it("uses the original two-track in/loop/hide contract and measured clips", () => {
    expect(PRIMAL_ANTICIPATION_TRACK).toEqual({ loop: 0, transition: 1 });
    expect(PRIMAL_ANTICIPATION_ANIMATION).toEqual({
      hidden: "hidden",
      in: "in",
      loop: "loop",
      hide: "hide",
    });
    expect(PRIMAL_ANTICIPATION_ANIMATION_MS).toEqual({
      in: 333.333,
      hide: 333.333,
    });
    expect(PRIMAL_ANTICIPATION_REEL_X).toEqual([-202.25, 0, 244]);
    expect(PRIMAL_ANTICIPATION_BASE_SCALE).toBe(0.8);
    expect(PRIMAL_ANTICIPATION_RUNTIME_FIT).toEqual({
      scaleX: 0.855,
      scaleY: 0.8,
      x: -8,
      y: 12,
    });
  });

  it("keeps the third-reel overlay attached to the responsive cabinet", () => {
    const desktop = primalAnticipationTransform(0.9152);
    const tablet = primalAnticipationTransform(0.896);
    const unscaled = primalAnticipationTransform(1);

    expect(unscaled).toEqual({
      x: LOGICAL_WIDTH / 2 + 244 * 0.8 * 0.855 - 8,
      y: REEL_STAGE_Y + REEL_AREA_HEIGHT / 2 + 12,
      scaleX: 0.8 * 0.855,
      scaleY: 0.8 * 0.8,
    });
    expect(desktop.scaleX).toBeCloseTo(0.8 * 0.855 * 0.9152, 10);
    expect(desktop.scaleY).toBeCloseTo(0.8 * 0.8 * 0.9152, 10);
    expect(desktop.x - LOGICAL_WIDTH / 2)
      .toBeCloseTo((244 * 0.8 * 0.855 - 8) * 0.9152, 10);
    expect(desktop.y - REEL_STAGE_Y)
      .toBeCloseTo((REEL_AREA_HEIGHT / 2 + 12) * 0.9152, 10);
    expect(tablet.scaleX).toBeLessThan(desktop.scaleX);
    expect(tablet.scaleY).toBeLessThan(desktop.scaleY);
    expect(primalAnticipationTransform(Number.NaN)).toEqual(unscaled);
    expect(primalAnticipationTransform(0)).toEqual(unscaled);
  });

  it("preserves the captured desktop pose when driven from live reel geometry", () => {
    const compositionScale = 0.9152;
    const legacy = primalAnticipationTransform(compositionScale);
    const live = primalAnticipationTransformFromReel({
      x: LOGICAL_WIDTH / 2 - REEL_AREA_WIDTH * compositionScale / 2,
      y: REEL_STAGE_Y,
      scaleX: compositionScale,
      scaleY: compositionScale,
      bounds: { x: 0, y: 0, width: REEL_AREA_WIDTH, height: REEL_AREA_HEIGHT },
    });

    expect(live.x).toBeCloseTo(legacy.x, 10);
    expect(live.y).toBeCloseTo(legacy.y, 10);
    expect(live.scaleX).toBeCloseTo(legacy.scaleX, 10);
    expect(live.scaleY).toBeCloseTo(legacy.scaleY, 10);
  });

  it("follows an independently positioned and scaled mobile reel window", () => {
    const transform = primalAnticipationTransformFromReel({
      x: 2,
      y: 293,
      scaleX: 0.81,
      scaleY: 0.84,
      bounds: { x: 4, y: 6, width: 474, height: 309 },
    });
    const expectedScaleX = PRIMAL_ANTICIPATION_BASE_SCALE
      * PRIMAL_ANTICIPATION_RUNTIME_FIT.scaleX
      * 0.81;
    const expectedScaleY = PRIMAL_ANTICIPATION_BASE_SCALE
      * PRIMAL_ANTICIPATION_RUNTIME_FIT.scaleY
      * 0.84;
    const expectedCentreX = 2 + (4 + 474 / 2) * 0.81;
    const expectedCentreY = 293 + (6 + 309 / 2) * 0.84;

    expect(transform).toEqual({
      x: expectedCentreX
        + PRIMAL_ANTICIPATION_REEL_X[2] * expectedScaleX
        + PRIMAL_ANTICIPATION_RUNTIME_FIT.x * 0.81,
      y: expectedCentreY + PRIMAL_ANTICIPATION_RUNTIME_FIT.y * 0.84,
      scaleX: expectedScaleX,
      scaleY: expectedScaleY,
    });
    expect(transform.x).not.toBeCloseTo(LOGICAL_WIDTH / 2 + 244 * expectedScaleX, 5);
    expect(transform.y).not.toBeCloseTo(REEL_STAGE_Y + REEL_AREA_HEIGHT * 0.81 / 2, 5);
  });

  it("reuses Reel 3's live host, source scale and complete projected clip across resize", () => {
    const reels = new ReelSetView();
    const view = new AnticipationView();
    const syncToReel = (view as unknown as {
      syncToReelHost?: (host: ReelSetView) => void;
    }).syncToReelHost;

    // Pass98 只是将手工拟合的中心点和缩放复制到独立宿主中。
    // 官方 CC/reelSuspense2 节点是 OB/reel 的子节点，因此该 API
    // 必须改为将效果绑定到 ReelSetView 实际使用的实时投影。
    expect(typeof syncToReel).toBe("function");
    syncToReel?.call(view, reels);

    const diagnostics = view.getPerspectiveDiagnostics() as ReturnType<
      AnticipationView["getPerspectiveDiagnostics"]
    > & {
      readonly hostPosition: readonly [number, number];
      readonly hostScale: readonly [number, number];
      readonly sourceRoot: Readonly<{
        x: number;
        y: number;
        scaleX: number;
        scaleY: number;
      }>;
      readonly filterArea: Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
      }> | null;
      readonly masked: boolean;
    };
    const reelPerspective = reels.getPerspectiveDiagnostics();

    expect(diagnostics.hostPosition).toEqual([reels.position.x, reels.position.y]);
    expect(diagnostics.hostScale).toEqual([reels.scale.x, reels.scale.y]);
    expect(diagnostics.sourceRoot).toEqual({
      x: REEL_AREA_WIDTH / 2 + PRIMAL_ANTICIPATION_REEL_X[2] * 0.57,
      y: REEL_AREA_HEIGHT / 2,
      scaleX: 0.57,
      scaleY: 0.57,
    });
    expect(diagnostics.filterArea).toEqual(reelPerspective.targetBounds);
    expect(diagnostics.filterArea?.width).toBeCloseTo(reelPerspective.targetBounds.width, 10);
    expect(diagnostics.filterArea?.height).toBeCloseTo(reelPerspective.targetBounds.height, 10);
    expect(diagnostics.sourceRoot.scaleX).toBeCloseTo(
      REEL_AREA_WIDTH / 747,
      10,
    );
    expect(diagnostics.masked).toBe(false);
    expect(diagnostics.resolution).toBe(reelPerspective.resolution);

    reels.setRows(8);
    syncToReel?.call(view, reels);
    const expanded = view.getPerspectiveDiagnostics() as typeof diagnostics;
    const expandedBounds = reels.getPresentationBounds();
    const expandedPerspective = reels.getPerspectiveDiagnostics();

    expect(expanded.hostPosition).toEqual([reels.position.x, reels.position.y]);
    expect(expanded.hostScale).toEqual([reels.scale.x, reels.scale.y]);
    expect(expanded.sourceRoot.x).toBeCloseTo(
      expandedBounds.width / 2 + PRIMAL_ANTICIPATION_REEL_X[2] * (3.15 / 8 * 0.8),
      10,
    );
    expect(expanded.sourceRoot.y).toBeCloseTo(expandedBounds.height / 2, 10);
    expect(expanded.sourceRoot.scaleX).toBeCloseTo(3.15 / 8 * 0.8, 10);
    expect(expanded.sourceRoot.scaleY).toBeCloseTo(3.15 / 8 * 0.8, 10);
    expect(expanded.filterArea).toEqual(expandedPerspective.targetBounds);
    expect(expanded.filterArea?.width).toBeCloseTo(expandedPerspective.targetBounds.width, 10);
    expect(expanded.filterArea?.height).toBeCloseTo(expandedPerspective.targetBounds.height, 10);

    view.destroy({ children: true });
    reels.destroy({ children: true });
  });

  it("retains a start requested before lazy artwork and clears immediately on cancel", () => {
    const view = new AnticipationView();
    expect(view.active).toBe(false);
    expect(view.visible).toBe(false);

    view.start();
    expect(view.active).toBe(true);
    expect(view.visible).toBe(true);

    view.stop(true);
    expect(view.active).toBe(false);
    expect(view.visible).toBe(false);
    view.destroy({ children: true });
  });
});
