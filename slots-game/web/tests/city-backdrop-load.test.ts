import { BaseTexture, Container, Texture } from "pixi.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const loaders = vi.hoisted(() => ({
  loadParticles: vi.fn(),
  loadSpines: vi.fn(),
  createSpine: vi.fn(),
  setParticlePalette: vi.fn(),
  killParticles: vi.fn(),
}));

vi.mock("../src/renderer/PrimalBackgroundParticles", async () => {
  const { Container: PixiContainer } = await import("pixi.js");
  return {
    PrimalBackgroundParticles: class extends PixiContainer {
      load(options?: unknown): Promise<void> {
        return loaders.loadParticles(options);
      }

      setPalette(palette: unknown): void {
        loaders.setParticlePalette(palette);
      }
      setReducedMotion(): void {}
      update(): void {}
      killAll(): void {
        loaders.killParticles();
      }
    },
  };
});

vi.mock("../src/renderer/spine/PrimalSpineAssets", () => ({
  loadPrimalSpineSet: loaders.loadSpines,
}));

vi.mock("../src/renderer/spine/SpineAdapter", () => ({
  createSpineView: loaders.createSpine,
  SPINE_DEFAULT_MIX_SECONDS: 0.15,
}));

import {
  CityBackdrop,
  PRIMAL_BACKGROUND_TRACK,
} from "../src/renderer/CityBackdrop";
import { SPINE_DEFAULT_MIX_SECONDS } from "../src/renderer/spine/SpineAdapter";

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
      fillRect: () => undefined,
      clearRect: () => undefined,
      setTransform: () => undefined,
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

beforeAll(() => {
  Object.assign(globalThis, {
    HTMLImageElement: TestImageElement,
    HTMLVideoElement: TestVideoElement,
    ImageBitmap: TestImageBitmap,
    HTMLCanvasElement: TestCanvas,
    SVGElement: TestSvgElement,
    document: { createElement: () => new TestCanvas() },
  });
});

afterAll(() => {
  for (const key of shimKeys) {
    const previous = previousGlobals.get(key);
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

interface MockSpine extends Container {
  autoUpdate: boolean;
  readonly skeleton: {
    setToSetupPose: ReturnType<typeof vi.fn>;
  };
  readonly state: {
    hasAnimation(name: string): boolean;
    setAnimation: ReturnType<typeof vi.fn>;
    addAnimation: ReturnType<typeof vi.fn>;
    getCurrent: ReturnType<typeof vi.fn>;
    setEmptyAnimation: ReturnType<typeof vi.fn>;
    clearTrack: ReturnType<typeof vi.fn>;
  };
  update: ReturnType<typeof vi.fn>;
}

function createMockSpine(name: string, hasAnimation = false): MockSpine {
  const view = new Container() as MockSpine;
  view.name = name;
  view.autoUpdate = true;
  Object.defineProperty(view, "skeleton", {
    value: { setToSetupPose: vi.fn() },
  });
  const current = new Map<number, object>();
  Object.defineProperty(view, "state", {
    value: {
      hasAnimation: () => hasAnimation,
      setAnimation: vi.fn((track: number) => {
        const entry = { track, mixDuration: 0.15 };
        current.set(track, entry);
        return entry;
      }),
      addAnimation: vi.fn(),
      getCurrent: vi.fn((track: number) => current.get(track) ?? null),
      setEmptyAnimation: vi.fn((track: number) => {
        const entry = { track, empty: true };
        current.set(track, entry);
        return entry;
      }),
      clearTrack: vi.fn((track: number) => {
        current.delete(track);
      }),
    },
  });
  view.update = vi.fn();
  return view;
}

function attachAuthoredSpines(
  backdrop: CityBackdrop,
  background: MockSpine,
  foreground: MockSpine,
): void {
  Object.assign(backdrop as unknown as Record<string, unknown>, {
    authoredBackground: background,
    authoredForeground: foreground,
  });
}

beforeEach(() => {
  loaders.loadParticles.mockReset().mockResolvedValue(undefined);
  loaders.loadSpines.mockReset().mockResolvedValue({
    background: { id: "background" },
    backgroundFront: { id: "background-front" },
  });
  loaders.createSpine.mockReset();
  loaders.setParticlePalette.mockReset();
  loaders.killParticles.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CityBackdrop artwork load ownership", () => {
  it("destroys staged Spine views after a sibling failure and commits one pair on retry", async () => {
    const atlasBase = new BaseTexture(null, { width: 3_000, height: 2_700 });
    const atlas = new Texture(atlasBase);
    const bitmapFailure = new Error("environment atlas unavailable");
    vi.spyOn(Texture, "fromURL")
      .mockRejectedValueOnce(bitmapFailure)
      .mockResolvedValueOnce(Texture.EMPTY)
      .mockResolvedValueOnce(atlas)
      .mockResolvedValueOnce(Texture.EMPTY);

    const createdSpines: MockSpine[] = [];
    loaders.createSpine.mockImplementation(() => {
      const view = createMockSpine(`spine-${createdSpines.length + 1}`);
      createdSpines.push(view);
      return view;
    });

    const backdrop = new CityBackdrop();
    const internals = backdrop as unknown as {
      readonly authoredBackdropHost: Container;
      readonly parallax: Container;
      readonly fallback: Container;
      readonly authoredBackground: MockSpine | null;
      readonly authoredForeground: MockSpine | null;
    };

    await expect(backdrop.loadArtwork()).rejects.toBe(bitmapFailure);
    await Promise.resolve();

    expect(createdSpines).toHaveLength(2);
    expect(loaders.createSpine).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "background" }),
      { regionAdditiveFallback: false },
    );
    expect(loaders.createSpine).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "background-front" }),
      { regionAdditiveFallback: false },
    );
    expect(createdSpines[0]?.destroyed).toBe(true);
    expect(createdSpines[1]?.destroyed).toBe(true);
    expect(internals.authoredBackground).toBeNull();
    expect(internals.authoredForeground).toBeNull();
    expect(internals.authoredBackdropHost.children).toHaveLength(0);
    expect(backdrop.foregroundView.children).toHaveLength(1);
    expect(internals.parallax.children).toHaveLength(0);
    expect(internals.fallback.visible).toBe(true);

    await expect(backdrop.loadArtwork()).resolves.toBeUndefined();

    expect(createdSpines).toHaveLength(4);
    expect(internals.authoredBackground).toBe(createdSpines[2]);
    expect(internals.authoredForeground).toBe(createdSpines[3]);
    expect(internals.authoredBackdropHost.children).toEqual([createdSpines[2]]);
    expect(backdrop.foregroundView.children).toHaveLength(2);
    expect(backdrop.foregroundView.children[0]).toBe(createdSpines[3]);
    expect(internals.parallax.children).toHaveLength(2);
    expect(internals.fallback.visible).toBe(false);

    backdrop.destroy({ children: true, texture: false, baseTexture: false });
    atlas.destroy(true);
  });
});

describe("CityBackdrop authored palette retirement", () => {
  it("mixes retired Free Spins auxiliary tracks to setup pose without hard-clearing them", () => {
    const backdrop = new CityBackdrop();
    const background = createMockSpine("background", true);
    const foreground = createMockSpine("foreground", true);
    attachAuthoredSpines(backdrop, background, foreground);

    // 预置 Free Spins 在轨道 3..12 上留下的精确火焰调色板。
    backdrop.restoreAuthoredPalette("fire");
    background.state.setAnimation.mockClear();
    background.state.setEmptyAnimation.mockClear();
    background.state.clearTrack.mockClear();
    foreground.state.clearTrack.mockClear();

    backdrop.transitionAuthoredPalette("main");

    expect(background.state.setEmptyAnimation.mock.calls).toEqual([
      [4, SPINE_DEFAULT_MIX_SECONDS],
      [9, SPINE_DEFAULT_MIX_SECONDS],
      [10, SPINE_DEFAULT_MIX_SECONDS],
      [11, SPINE_DEFAULT_MIX_SECONDS],
      [12, SPINE_DEFAULT_MIX_SECONDS],
    ]);
    expect(background.state.clearTrack).not.toHaveBeenCalled();
    expect(foreground.state.clearTrack).not.toHaveBeenCalledWith(
      PRIMAL_BACKGROUND_TRACK.transition,
    );
    expect(background.state.setAnimation).toHaveBeenCalledWith(
      3,
      "bg_main_Clouds_Loop",
      true,
    );
    expect(background.state.setAnimation).toHaveBeenCalledWith(
      8,
      "smoke_2_main_and_fire",
      true,
    );

    backdrop.destroy({ children: true, texture: false, baseTexture: false });
  });

  it("hard-resets stale transition and auxiliary tracks on reconnect restoration", () => {
    const backdrop = new CityBackdrop();
    const background = createMockSpine("background", true);
    const foreground = createMockSpine("foreground", true);
    attachAuthoredSpines(backdrop, background, foreground);

    backdrop.restoreAuthoredPalette("fire");
    background.state.setAnimation.mockClear();
    background.state.setEmptyAnimation.mockClear();
    background.state.clearTrack.mockClear();
    foreground.state.clearTrack.mockClear();
    background.skeleton.setToSetupPose.mockClear();
    foreground.skeleton.setToSetupPose.mockClear();

    backdrop.restoreAuthoredPalette("main");

    expect(background.state.setEmptyAnimation).not.toHaveBeenCalled();
    expect(background.skeleton.setToSetupPose).toHaveBeenCalledOnce();
    expect(foreground.skeleton.setToSetupPose).toHaveBeenCalledOnce();
    expect(background.state.clearTrack).toHaveBeenCalledWith(
      PRIMAL_BACKGROUND_TRACK.transition,
    );
    expect(foreground.state.clearTrack).toHaveBeenCalledWith(
      PRIMAL_BACKGROUND_TRACK.transition,
    );
    for (
      let track = PRIMAL_BACKGROUND_TRACK.auxBegin;
      track <= PRIMAL_BACKGROUND_TRACK.auxEnd;
      track += 1
    ) {
      expect(background.state.clearTrack).toHaveBeenCalledWith(track);
    }
    expect(background.state.setAnimation).toHaveBeenCalledWith(
      3,
      "bg_main_Clouds_Loop",
      true,
    );
    const restoredBase = background.state.setAnimation.mock.results.find(
      ({ value }) => value?.track === PRIMAL_BACKGROUND_TRACK.base,
    )?.value as { mixDuration?: number } | undefined;
    expect(restoredBase?.mixDuration).toBe(0);

    backdrop.destroy({ children: true, texture: false, baseTexture: false });
  });

  it.each([
    ["EXPANSION", "fire"],
    ["OVERDRIVE", "snow"],
  ] as const)(
    "atomically settles %s camera, authored palette and particles before the exit promise resolves",
    (_mode, palette) => {
      const backdrop = new CityBackdrop();
      const background = createMockSpine("background", true);
      const foreground = createMockSpine("foreground", true);
      attachAuthoredSpines(backdrop, background, foreground);
      backdrop.restoreAuthoredPalette(palette);

      const internals = backdrop as unknown as {
        rows: number;
        currentTrackY: number;
        targetTrackY: number;
        readonly daylight: { y: number };
        readonly destroyedPlate: { y: number };
      };
      internals.rows = 8;
      internals.currentTrackY = 576;
      internals.targetTrackY = 576;
      background.state.clearTrack.mockClear();
      foreground.state.clearTrack.mockClear();
      background.state.setEmptyAnimation.mockClear();
      foreground.state.setEmptyAnimation.mockClear();
      loaders.setParticlePalette.mockClear();
      loaders.killParticles.mockClear();

      backdrop.settleFeatureExit();

      expect(internals.rows).toBe(3);
      expect(internals.currentTrackY).toBe(internals.targetTrackY);
      expect(internals.daylight.y).toBe(internals.targetTrackY);
      expect(internals.destroyedPlate.y).toBe(internals.targetTrackY);
      expect(background.state.setEmptyAnimation).not.toHaveBeenCalled();
      expect(foreground.state.setEmptyAnimation).not.toHaveBeenCalled();
      expect(background.state.clearTrack).toHaveBeenCalledWith(
        PRIMAL_BACKGROUND_TRACK.transition,
      );
      expect(foreground.state.clearTrack).toHaveBeenCalledWith(
        PRIMAL_BACKGROUND_TRACK.transition,
      );
      expect(loaders.setParticlePalette).toHaveBeenLastCalledWith("main");
      expect(loaders.killParticles).toHaveBeenCalledOnce();

      const settledY = internals.currentTrackY;
      for (const deltaMs of [64, 64, 64, 8]) backdrop.update(deltaMs);
      expect(internals.currentTrackY).toBe(settledY);
      expect(internals.targetTrackY).toBe(settledY);
      expect(internals.daylight.y).toBe(settledY);
      expect(internals.destroyedPlate.y).toBe(settledY);

      backdrop.destroy({ children: true, texture: false, baseTexture: false });
    },
  );
});
