// @ts-expect-error Vitest 在 Node 中运行，而浏览器 tsconfig 故意不声明 Node 内置模块。 / English: @ts-expect-error Vitest runs in Node, and the browser tsconfig intentionally does not declare Node built-in modules.
import { readFileSync } from "node:fs";
import { TextureAtlas, Vector2 } from "@pixi-spine/base";
import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  Skeleton,
  SkeletonBinary,
} from "@pixi-spine/runtime-4.1";
import { BaseTexture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import {
  FREE_SPIN_HUD_ANIMATION,
  FREE_SPIN_HUD_ANIMATION_MS,
  FREE_SPIN_CAP_COPY,
  FREE_SPIN_HUD_COUNTER_STOP_BOUNDS_X,
  FREE_SPIN_HUD_DESKTOP_CONTAINMENT_INSET_X,
  FREE_SPIN_HUD_DESKTOP_CORE_REGION_X,
  FREE_SPIN_HUD_DESKTOP_LAYOUT,
  FREE_SPIN_HUD_MOBILE_LAYOUTS,
  FREE_SPIN_HUD_REDUCED_MOTION_MS,
  FREE_SPIN_HUD_TEXT_SLOTS,
  FREE_SPIN_HUD_TRACK,
  FreeSpinHudView,
  freeSpinHudDesktopCounterLayout,
  freeSpinHudResponsiveLayout,
  formatFreeSpinCounter,
  projectFreeSpinHud,
  type FreeSpinHudFeatureState,
} from "../src/renderer/FreeSpinHudView";
import {
  computeResponsiveLayoutSnapshot,
  resolveResponsiveMinBound,
} from "../src/renderer/ResponsiveLayout";
import {
  PRIMAL_SPINE_SPECS,
  primalSpineSkeletonUrl,
} from "../src/renderer/spine/PrimalSpineAssets";

const ACTIVE_STATE: FreeSpinHudFeatureState = {
  mode: "EXPANSION",
  freeSpinsRemaining: 7,
  freeSpinsPlayed: 2,
  freeSpinsWinMinor: "1234",
};

const OFFICIAL_MOBILE_CONFIG = JSON.parse(readFileSync(
  new URL("../public/assets/primal-runtime/mobile/config/config_mobile.json", import.meta.url),
  "utf8",
)) as {
  bundle: Array<{
    data?: {
      layouts?: Record<string, {
        content?: Record<string, {
          minBound?: string;
          halign?: string;
          valign?: string;
        }>;
      }>;
    };
  }>;
};

function officialFreeSpinNode(
  profile: "pt" | "iPad_pt" | "ls",
  handMode: "left" | "right",
  key: "fsCounter" | "freespinRetrigger",
): { minBound: { left: number; top: number; width: number; height: number }; horizontalAlign: number; verticalAlign: number } {
  const handLayout = OFFICIAL_MOBILE_CONFIG.bundle
    .find((entry) => entry.data?.layouts?.[`${profile}_${handMode}`])
    ?.data?.layouts?.[`${profile}_${handMode}`]?.content?.[key];
  const baseLayout = OFFICIAL_MOBILE_CONFIG.bundle
    .find((entry) => entry.data?.layouts?.[profile])
    ?.data?.layouts?.[profile]?.content?.[key];
  const node = handLayout ?? baseLayout;
  if (!node?.minBound || node.halign === undefined || node.valign === undefined) {
    throw new Error(`Missing official ${profile}_${handMode}/${key} layout`);
  }
  const [left, top, width, height] = node.minBound.split(",").map(Number);
  if ([left, top, width, height].some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid official ${profile}_${handMode}/${key} minBound`);
  }
  return {
    minBound: { left: left!, top: top!, width: width!, height: height! },
    horizontalAlign: Number(node.halign),
    verticalAlign: Number(node.valign),
  };
}

interface SpineStub {
  readonly state: {
    readonly clearTracks: ReturnType<typeof vi.fn>;
    readonly clearTrack: ReturnType<typeof vi.fn>;
    readonly setAnimation: ReturnType<typeof vi.fn>;
    readonly addAnimation: ReturnType<typeof vi.fn>;
  };
  readonly update: ReturnType<typeof vi.fn>;
}

function createSpineStub(): SpineStub {
  return {
    state: {
      clearTracks: vi.fn(),
      clearTrack: vi.fn(),
      setAnimation: vi.fn(),
      addAnimation: vi.fn(),
    },
    update: vi.fn(),
  };
}

function attachLoadedArtwork(hud: FreeSpinHudView): {
  readonly counter: SpineStub;
  readonly retrigger: SpineStub;
} {
  const counter = createSpineStub();
  const retrigger = createSpineStub();
  Object.assign(hud as unknown as Record<string, unknown>, {
    counterView: counter,
    retriggerView: retrigger,
    loadPromise: Promise.resolve(),
  });
  return { counter, retrigger };
}

function clearSpineStub(stub: SpineStub): void {
  stub.state.clearTracks.mockClear();
  stub.state.clearTrack.mockClear();
  stub.state.setAnimation.mockClear();
  stub.state.addAnimation.mockClear();
  stub.update.mockClear();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function loadFreeSpinAtlas(text: string): Promise<TextureAtlas> {
  return new Promise((resolveAtlas, reject) => {
    new TextureAtlas(
      text,
      (_page, complete) => complete(new BaseTexture()),
      (atlas) => atlas
        ? resolveAtlas(atlas)
        : reject(new Error("Free Spin Spine atlas parse failed")),
    );
  });
}

describe("native Free Spins HUD", () => {
  it("registers the two captured Spine 4.1 skeletons", () => {
    expect(PRIMAL_SPINE_SPECS.freeSpinCounter).toEqual({
      group: "spine_ui",
      skeleton: "freespin_counter",
      idleAnimation: "hidden",
    });
    expect(PRIMAL_SPINE_SPECS.freeSpinRetrigger).toEqual({
      group: "spine_ui",
      skeleton: "freespin_retrigger",
      idleAnimation: "hidden",
    });
    expect(primalSpineSkeletonUrl("freeSpinCounter"))
      .toContain("/spine_ui/freespin_counter.skel");
    expect(primalSpineSkeletonUrl("freeSpinRetrigger"))
      .toContain("/spine_ui/freespin_retrigger.skel");
  });

  it("keeps the measured clips on the original three counter tracks", () => {
    expect(FREE_SPIN_HUD_TRACK).toEqual({ base: 0, glow: 1, sweep: 2 });
    expect(FREE_SPIN_HUD_ANIMATION.counter).toEqual({
      hidden: "hidden",
      stop: "stop",
      show: "show",
      glow: "Glow_loop",
      sweep: "sweep_Loop",
      win: "win_vfx",
      hide: "hide",
    });
    expect(FREE_SPIN_HUD_ANIMATION_MS.counter).toEqual({
      show: 833.333,
      glow: 2_666.7,
      sweep: 600,
      win: 766.7,
      hide: 333.3,
    });
    expect(FREE_SPIN_HUD_ANIMATION_MS.retrigger).toEqual({
      show: 733.3,
      hold: 4_166.667,
      hide: 733.333,
    });
  });

  it("uses only authored text slots and captured desktop root transforms", () => {
    expect(FREE_SPIN_HUD_TEXT_SLOTS).toEqual({
      label: { name: "fsCounterFreespin", width: 228.77, height: 36.63 },
      counter: { name: "fsCounterValue", width: 227.66, height: 56.11 },
      retrigger: { name: "retriggerText", width: 935.55, height: 315.65 },
    });
    expect(FREE_SPIN_HUD_DESKTOP_LAYOUT).toEqual({
      counter: { x: 260, y: 124, scale: 0.8 },
      retrigger: { x: 640, y: 280, scale: 0.8 },
    });
  });

  it("contains the verified stop core at the 1440x900 crop without containing VFX bleed", async () => {
    const atlas = await loadFreeSpinAtlas(readFileSync(
      new URL(
        "../public/assets/primal-runtime/spine/spine_ui/spine_ui.atlas",
        import.meta.url,
      ),
      "utf8",
    ));
    try {
      const bytes = readFileSync(new URL(
        "../public/assets/primal-runtime/spine/spine_ui/freespin_counter.skel",
        import.meta.url,
      ));
      const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas))
        .readSkeletonData(new Uint8Array(bytes));
      const animationBounds = (animation: "stop" | "Glow_loop") => {
        const skeleton = new Skeleton(data);
        const state = new AnimationState(new AnimationStateData(data));
        state.setAnimation(0, animation, animation === "Glow_loop");
        state.apply(skeleton);
        skeleton.updateWorldTransform();
        const offset = new Vector2();
        const size = new Vector2();
        skeleton.getBounds(offset, size, []);
        return { left: offset.x, right: offset.x + size.x };
      };

      const stop = animationBounds("stop");
      expect(stop.left).toBeCloseTo(FREE_SPIN_HUD_COUNTER_STOP_BOUNDS_X.left, 10);
      expect(stop.right).toBeCloseTo(FREE_SPIN_HUD_COUNTER_STOP_BOUNDS_X.right, 10);

      const canonical = freeSpinHudDesktopCounterLayout(0);
      const previousStopLeft = canonical.x + stop.left * canonical.scale;
      expect(previousStopLeft).toBeCloseTo(149.79584185582576, 10);
      expect(canonical).toBe(FREE_SPIN_HUD_DESKTOP_LAYOUT.counter);

      const croppedSnapshot = computeResponsiveLayoutSnapshot(1_440, 900, {
        channel: "desktop",
      });
      expect(croppedSnapshot.frame.visibleInsetX)
        .toBe(FREE_SPIN_HUD_DESKTOP_CONTAINMENT_INSET_X);
      const cropped = freeSpinHudResponsiveLayout(croppedSnapshot).counter;
      const stopLeft = cropped.x + stop.left * cropped.scale;
      const stopRight = cropped.x + stop.right * cropped.scale;
      expect(cropped.x).toBeCloseTo(270.20415814417424, 10);
      expect(stopLeft).toBeCloseTo(FREE_SPIN_HUD_DESKTOP_CORE_REGION_X.left, 10);
      expect(stopRight).toBeCloseTo(387.39200474697255, 10);
      expect(stopRight).toBeLessThanOrEqual(FREE_SPIN_HUD_DESKTOP_CORE_REGION_X.right);

      const glow = animationBounds("Glow_loop");
      const glowLeft = cropped.x + glow.left * cropped.scale;
      expect(glowLeft).toBeCloseTo(133.28272293255442, 10);
      expect(glowLeft).toBeLessThan(FREE_SPIN_HUD_DESKTOP_CORE_REGION_X.left);
    } finally {
      atlas.dispose();
    }
  });

  it("adopts desktop core containment continuously and leaves mobile projection untouched", () => {
    const canonical = freeSpinHudDesktopCounterLayout(0);
    const half = freeSpinHudDesktopCounterLayout(
      FREE_SPIN_HUD_DESKTOP_CONTAINMENT_INSET_X / 2,
    );
    const contained = freeSpinHudDesktopCounterLayout(
      FREE_SPIN_HUD_DESKTOP_CONTAINMENT_INSET_X,
    );
    const severeCrop = freeSpinHudDesktopCounterLayout(160);

    expect(canonical).toEqual({ x: 260, y: 124, scale: 0.8 });
    expect(half.x).toBeCloseTo((canonical.x + contained.x) / 2, 10);
    expect(contained.x).toBeCloseTo(270.20415814417424, 10);
    expect(severeCrop).toEqual(contained);
    for (const layout of [half, contained, severeCrop]) {
      expect(layout.y).toBe(canonical.y);
      expect(layout.scale).toBe(canonical.scale);
    }

    const mobile = computeResponsiveLayoutSnapshot(390, 844, { channel: "mobile" });
    const officialMobile = officialFreeSpinNode("pt", "right", "fsCounter");
    expect(freeSpinHudResponsiveLayout(mobile).counter).toEqual(
      resolveResponsiveMinBound(
        mobile.gameplayRegion,
        officialMobile.minBound,
        officialMobile.horizontalAlign,
        officialMobile.verticalAlign,
      ),
    );
  });

  it("projects the captured mobile HUD nodes into every continuous gameplay surface", () => {
    for (const handMode of ["left", "right"] as const) {
      for (const profile of ["pt", "iPad_pt", "ls"] as const) {
        expect(FREE_SPIN_HUD_MOBILE_LAYOUTS[handMode][profile].counter).toEqual(
          officialFreeSpinNode(profile, handMode, "fsCounter"),
        );
        expect(FREE_SPIN_HUD_MOBILE_LAYOUTS[handMode][profile].retrigger).toEqual(
          officialFreeSpinNode(profile, handMode, "freespinRetrigger"),
        );
      }
    }

    for (const [width, height, profile] of [
      [390, 844, "pt"],
      [844, 390, "ls"],
      [768, 1_024, "iPad_pt"],
      [1_024, 768, "ls"],
    ] as const) {
      const snapshot = computeResponsiveLayoutSnapshot(width, height, { channel: "mobile" });
      const layout = freeSpinHudResponsiveLayout(snapshot);
      expect(snapshot.mobileProfile).toBe(profile);
      expect(layout.counter.scale).toBeGreaterThan(0);
      expect(layout.retrigger.scale).toBeGreaterThan(0);
      expect(layout.counter.x).toBeGreaterThanOrEqual(snapshot.gameplayRegion.left);
      expect(layout.counter.x).toBeLessThanOrEqual(
        snapshot.gameplayRegion.left + snapshot.gameplayRegion.width,
      );
      expect(layout.counter.y).toBeGreaterThanOrEqual(snapshot.gameplayRegion.top);
      expect(layout.counter.y).toBeLessThanOrEqual(
        snapshot.gameplayRegion.top + snapshot.gameplayRegion.height,
      );
      expect(layout.retrigger.x).toBeGreaterThanOrEqual(snapshot.gameplayRegion.left);
      expect(layout.retrigger.x).toBeLessThanOrEqual(
        snapshot.gameplayRegion.left + snapshot.gameplayRegion.width,
      );
      expect(layout.retrigger.y).toBeGreaterThanOrEqual(snapshot.gameplayRegion.top);
      expect(layout.retrigger.y).toBeLessThanOrEqual(
        snapshot.gameplayRegion.top + snapshot.gameplayRegion.height,
      );
    }

    const portraitRight = computeResponsiveLayoutSnapshot(390, 844, {
      channel: "mobile",
      handMode: "right",
    });
    const portraitLeft = computeResponsiveLayoutSnapshot(390, 844, {
      channel: "mobile",
      handMode: "left",
    });
    expect(freeSpinHudResponsiveLayout(portraitLeft).counter.x)
      .not.toBe(freeSpinHudResponsiveLayout(portraitRight).counter.x);
  });

  it("reflows an active HUD across phone and tablet rotation without mutating state", () => {
    const hud = new FreeSpinHudView();
    hud.restoreFeatureState(ACTIVE_STATE);
    const projection = hud.projection;
    const counterHost = hud.children[0]!;
    const retriggerHost = hud.children[1]!;

    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [768, 1_024],
      [1_024, 768],
    ] as const) {
      const snapshot = computeResponsiveLayoutSnapshot(width, height, { channel: "mobile" });
      const expected = freeSpinHudResponsiveLayout(snapshot);
      hud.setResponsiveLayout(snapshot);
      expect(counterHost.position).toMatchObject({ x: expected.counter.x, y: expected.counter.y });
      expect(counterHost.scale).toMatchObject({ x: expected.counter.scale, y: expected.counter.scale });
      expect(retriggerHost.position).toMatchObject({
        x: expected.retrigger.x,
        y: expected.retrigger.y,
      });
      expect(retriggerHost.scale).toMatchObject({
        x: expected.retrigger.scale,
        y: expected.retrigger.scale,
      });
      expect(hud.projection).toBe(projection);
      expect(hud.visible).toBe(true);
      expect(counterHost.visible).toBe(true);
    }

    const croppedDesktop = computeResponsiveLayoutSnapshot(1_440, 900, {
      channel: "desktop",
    });
    hud.setResponsiveLayout(croppedDesktop);
    expect(counterHost.position.x).toBeCloseTo(270.20415814417424, 10);
    expect(counterHost.position.y).toBe(124);
    expect(counterHost.scale).toMatchObject({ x: 0.8, y: 0.8 });
    expect(retriggerHost.position).toMatchObject({ x: 640, y: 280 });
    expect(hud.projection).toBe(projection);
    expect(counterHost.visible).toBe(true);

    hud.setResponsiveLayout(computeResponsiveLayoutSnapshot(1_280, 720));
    expect(counterHost.position).toMatchObject({ x: 260, y: 124 });
    expect(counterHost.scale).toMatchObject({ x: 0.8, y: 0.8 });
    expect(hud.projection).toBe(projection);
    hud.destroy({ children: true });
  });

  it("projects current, remaining, total, and running win from FeatureState", () => {
    const projection = projectFreeSpinHud(ACTIVE_STATE);
    expect(projection).toEqual({
      active: true,
      remaining: 7,
      played: 2,
      totalAwarded: 9,
      currentSpin: 3,
      cumulativeWinMinor: "1234",
    });
    expect(formatFreeSpinCounter(projection)).toBe("3 / 9");
  });

  it("restores an active reconnect snapshot on stop without starting the unused Glow_loop", () => {
    const onProjection = vi.fn();
    const hud = new FreeSpinHudView({ onProjection });
    const { counter } = attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    expect(hud.visible).toBe(true);
    expect(hud.projection.remaining).toBe(7);
    expect(hud.projection.cumulativeWinMinor).toBe("1234");
    expect(onProjection).toHaveBeenLastCalledWith(hud.projection);
    expect(counter.state.setAnimation).toHaveBeenCalledWith(
      FREE_SPIN_HUD_TRACK.base,
      FREE_SPIN_HUD_ANIMATION.counter.stop,
      false,
    );
    expect(counter.state.setAnimation).not.toHaveBeenCalledWith(
      FREE_SPIN_HUD_TRACK.glow,
      FREE_SPIN_HUD_ANIMATION.counter.glow,
      true,
    );
    hud.destroy({ children: true });
  });

  it("starts show without waiting for its 833ms clip and never starts Glow_loop", async () => {
    const wait = vi.fn(async (_durationMs: number) => undefined);
    const hud = new FreeSpinHudView({ wait });
    const { counter } = attachLoadedArtwork(hud);

    await hud.show(ACTIVE_STATE);

    expect(hud.visible).toBe(true);
    expect(wait).not.toHaveBeenCalled();
    expect(counter.state.setAnimation).toHaveBeenCalledWith(
      FREE_SPIN_HUD_TRACK.base,
      FREE_SPIN_HUD_ANIMATION.counter.show,
      false,
    );
    expect(counter.state.setAnimation).not.toHaveBeenCalledWith(
      FREE_SPIN_HUD_TRACK.glow,
      FREE_SPIN_HUD_ANIMATION.counter.glow,
      true,
    );
    hud.destroy({ children: true });
  });

  it("keeps the HUD visible until the original 400ms hide barrier completes", async () => {
    let releaseWait!: () => void;
    const wait = vi.fn((_durationMs: number) => new Promise<void>((resolve) => {
      releaseWait = resolve;
    }));
    const hud = new FreeSpinHudView({ wait });
    const { counter } = attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);
    clearSpineStub(counter);

    const hiding = hud.hide();

    expect(wait).toHaveBeenCalledWith(400);
    expect(hud.visible).toBe(true);
    expect(counter.state.setAnimation).toHaveBeenCalledWith(
      FREE_SPIN_HUD_TRACK.base,
      FREE_SPIN_HUD_ANIMATION.counter.hide,
      false,
    );

    releaseWait();
    await hiding;
    expect(hud.visible).toBe(false);
    hud.destroy({ children: true });
  });

  it("applies an award batch from server state and plays one win plus one sweep", () => {
    const hud = new FreeSpinHudView();
    const { counter } = attachLoadedArtwork(hud);
    hud.restoreFeatureState({
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 5,
      freeSpinsWinMinor: "800",
    });
    expect(formatFreeSpinCounter(hud.projection)).toBe("6 / 7");
    clearSpineStub(counter);
    const projection = hud.applyFreeSpinAwardBatch(
      [
        { type: "free_spin.awarded", count: 1, reel: 1, row: 1 },
        { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
      ],
      {
        mode: "EXPANSION",
        freeSpinsRemaining: 4,
        freeSpinsPlayed: 5,
        freeSpinsWinMinor: "800",
      },
    );

    expect(formatFreeSpinCounter(projection)).toBe("6 / 9");
    expect(projection.totalAwarded).toBe(9);
    expect(projection.remaining).toBe(4);
    expect(projection.cumulativeWinMinor).toBe("800");
    expect(counter.state.setAnimation).toHaveBeenCalledTimes(2);
    expect(counter.state.setAnimation).toHaveBeenNthCalledWith(
      1,
      FREE_SPIN_HUD_TRACK.base,
      FREE_SPIN_HUD_ANIMATION.counter.win,
      false,
    );
    expect(counter.state.setAnimation).toHaveBeenNthCalledWith(
      2,
      FREE_SPIN_HUD_TRACK.sweep,
      FREE_SPIN_HUD_ANIMATION.counter.sweep,
      false,
    );
    expect(counter.state.addAnimation).toHaveBeenCalledTimes(1);

    clearSpineStub(counter);
    hud.updateFeatureState({
      ...ACTIVE_STATE,
      freeSpinsWinMinor: "2000",
    });
    expect(counter.state.setAnimation).not.toHaveBeenCalled();
    expect(counter.state.addAnimation).not.toHaveBeenCalled();
    hud.destroy({ children: true });
  });

  it("shows the CAPLIMIT retrigger once with show, hold, and hide timings", async () => {
    const waits: number[] = [];
    const capPhases: string[] = [];
    const closeReasons: string[] = [];
    const wait = vi.fn(async (durationMs: number) => {
      waits.push(durationMs);
    });
    const hud = new FreeSpinHudView({
      wait,
      onCapInteraction: (phase) => capPhases.push(phase),
      onCapClose: (reason) => closeReasons.push(reason),
    });
    const { counter, retrigger } = attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);
    clearSpineStub(counter);
    clearSpineStub(retrigger);
    const capEvent = { type: "free_spin.cap_reached", reel: 1, row: 2 } as const;

    await hud.retriggerCap(capEvent, ACTIVE_STATE);

    expect(FREE_SPIN_CAP_COPY).toBe("Maximum number of FREE SPINS reached!");
    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide,
    ]);
    expect(capPhases).toEqual(["input-ready", "continue"]);
    expect(closeReasons).toEqual(["timeout"]);
    expect(retrigger.state.setAnimation.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [0, FREE_SPIN_HUD_ANIMATION.retrigger.show, false],
      [0, FREE_SPIN_HUD_ANIMATION.retrigger.hide, false],
      [0, FREE_SPIN_HUD_ANIMATION.retrigger.hidden, false],
    ]);
    expect(counter.state.setAnimation).not.toHaveBeenCalled();

    await hud.retriggerCap(capEvent, ACTIVE_STATE);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(retrigger.state.setAnimation).toHaveBeenCalledTimes(3);
    hud.destroy({ children: true });
  });

  it("accepts CONTINUE_SPIN only during the bounded CAPLIMIT hold", async () => {
    let releaseShow!: () => void;
    const waits: number[] = [];
    const phases: string[] = [];
    const closeReasons: string[] = [];
    const wait = vi.fn((durationMs: number) => {
      waits.push(durationMs);
      if (waits.length === 1) {
        return new Promise<void>((resolve) => { releaseShow = resolve; });
      }
      if (waits.length === 2) return new Promise<void>(() => undefined);
      return Promise.resolve();
    });
    const hud = new FreeSpinHudView({
      wait,
      onCapInteraction: (phase) => phases.push(phase),
      onCapClose: (reason) => closeReasons.push(reason),
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    const presentation = hud.retriggerCap(
      // 官方 CAPLIMIT 演出以会话为作用域，并忽略地址元数据。 / English: The official CAPLIMIT gig is session scoped and ignores address metadata.
      { type: "free_spin.cap_reached", reel: -1, row: -1 },
      ACTIVE_STATE,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(hud.requestCapContinue()).toBe(false);
    expect(phases).toEqual([]);

    releaseShow();
    await Promise.resolve();
    await Promise.resolve();
    expect(phases).toEqual(["input-ready"]);
    expect(hud.requestCapContinue()).toBe(true);
    expect(hud.requestCapContinue()).toBe(false);

    await presentation;
    expect(phases).toEqual(["input-ready", "continue"]);
    expect(closeReasons).toEqual(["continue"]);
    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide,
    ]);
    hud.destroy({ children: true });
  });

  it("holds fixture capture after input-ready and starts the authored CAP hold only on release", async () => {
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const waits: number[] = [];
    const phases: string[] = [];
    const closeReasons: string[] = [];
    const wait = vi.fn((durationMs: number) => {
      waits.push(durationMs);
      if (waits.length === 2) return new Promise<void>(() => undefined);
      return Promise.resolve();
    });
    const hud = new FreeSpinHudView({
      wait,
      onCapInteraction: (phase) => phases.push(phase),
      onCapClose: (reason) => closeReasons.push(reason),
      onCapInputReadyCheckpoint: () => checkpoint,
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    const presentation = hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      ACTIVE_STATE,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(phases).toEqual(["input-ready"]);
    expect(waits).toEqual([FREE_SPIN_HUD_ANIMATION_MS.retrigger.show]);
    expect(closeReasons).toEqual([]);

    releaseCheckpoint();
    await flushMicrotasks();
    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
    ]);
    expect(hud.requestCapContinue()).toBe(true);
    await presentation;

    expect(phases).toEqual(["input-ready", "continue"]);
    expect(closeReasons).toEqual(["continue"]);
    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide,
    ]);
    hud.destroy({ children: true });
  });

  it("takes the natural CAP timeout only after a held checkpoint is released", async () => {
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const waits: number[] = [];
    const closeReasons: string[] = [];
    const hud = new FreeSpinHudView({
      wait: async (durationMs) => { waits.push(durationMs); },
      onCapClose: (reason) => closeReasons.push(reason),
      onCapInputReadyCheckpoint: () => checkpoint,
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    const presentation = hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      ACTIVE_STATE,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(waits).toEqual([FREE_SPIN_HUD_ANIMATION_MS.retrigger.show]);
    expect(closeReasons).toEqual([]);

    releaseCheckpoint();
    await presentation;
    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide,
    ]);
    expect(closeReasons).toEqual(["timeout"]);
    hud.destroy({ children: true });
  });

  it("fails open when the CAP input-ready checkpoint rejects", async () => {
    const waits: number[] = [];
    const closeReasons: string[] = [];
    const hud = new FreeSpinHudView({
      wait: async (durationMs) => { waits.push(durationMs); },
      onCapClose: (reason) => closeReasons.push(reason),
      onCapInputReadyCheckpoint: () => Promise.reject(new Error("fixture checkpoint failed")),
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    await hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      ACTIVE_STATE,
    );

    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide,
    ]);
    expect(closeReasons).toEqual(["timeout"]);
    hud.destroy({ children: true });
  });

  it("cancels a checkpoint-held CAP once on destroy without starting hold or hide", async () => {
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const waits: number[] = [];
    const phases: string[] = [];
    const closeReasons: string[] = [];
    const hud = new FreeSpinHudView({
      wait: async (durationMs) => { waits.push(durationMs); },
      onCapInteraction: (phase) => phases.push(phase),
      onCapClose: (reason) => closeReasons.push(reason),
      onCapInputReadyCheckpoint: () => checkpoint,
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    const presentation = hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      ACTIVE_STATE,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(phases).toEqual(["input-ready"]);

    hud.destroy({ children: true });
    await presentation;
    releaseCheckpoint();

    expect(waits).toEqual([FREE_SPIN_HUD_ANIMATION_MS.retrigger.show]);
    expect(phases).toEqual(["input-ready"]);
    expect(closeReasons).toEqual(["cancelled"]);
  });

  it("takes the natural CAPLIMIT timeout path and rearms only for a new feature session", async () => {
    const pending: Array<{ durationMs: number; resolve(): void }> = [];
    const phases: string[] = [];
    const closeReasons: string[] = [];
    const wait = vi.fn((durationMs: number) => new Promise<void>((resolve) => {
      pending.push({ durationMs, resolve });
    }));
    const hud = new FreeSpinHudView({
      wait,
      onCapInteraction: (phase) => phases.push(phase),
      onCapClose: (reason) => closeReasons.push(reason),
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);
    const capEvent = { type: "free_spin.cap_reached", reel: 1, row: 2 } as const;

    const first = hud.retriggerCap(capEvent, ACTIVE_STATE);
    await Promise.resolve();
    expect(pending.map(({ durationMs }) => durationMs)).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
    ]);
    pending[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(phases).toEqual(["input-ready"]);
    expect(pending[1]?.durationMs).toBe(FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold);

    // 没有用户手势：预设的有限停留本身会关闭门控。 / English: No user gesture: the preset limited dwell itself closes the gate.
    pending[1]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(hud.requestCapContinue()).toBe(false);
    expect(phases).toEqual(["input-ready", "continue"]);
    expect(closeReasons).toEqual(["timeout"]);
    expect(pending[2]?.durationMs).toBe(FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide);
    pending[2]?.resolve();
    await first;

    // 同一个 Feature 会话仍然只展示一次。 / English: The same Feature session is still only displayed once.
    await hud.retriggerCap(capEvent, ACTIVE_STATE);
    expect(wait).toHaveBeenCalledTimes(3);

    // BASE 快照会结束旧会话；后续 Feature 会话可以再次展示一次。 / English: The BASE snapshot ends the old session; subsequent Feature sessions can be shown again.
    hud.restoreFeatureState({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      freeSpinsWinMinor: "0",
    });
    hud.restoreFeatureState(ACTIVE_STATE);
    const second = hud.retriggerCap(capEvent, ACTIVE_STATE);
    await Promise.resolve();
    pending[3]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending[4]?.durationMs).toBe(FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold);
    expect(hud.requestCapContinue()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending[5]?.durationMs).toBe(FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide);
    pending[5]?.resolve();
    await second;
    expect(wait).toHaveBeenCalledTimes(6);
    expect(closeReasons).toEqual(["timeout", "continue"]);
    hud.destroy({ children: true });
  });

  it("cancels a pending CAPLIMIT hold on BASE restore without playing the stale hide", async () => {
    const pending: Array<{ durationMs: number; resolve(): void }> = [];
    const phases: string[] = [];
    const closeReasons: string[] = [];
    const wait = vi.fn((durationMs: number) => new Promise<void>((resolve) => {
      pending.push({ durationMs, resolve });
    }));
    const hud = new FreeSpinHudView({
      wait,
      onCapInteraction: (phase) => phases.push(phase),
      onCapClose: (reason) => closeReasons.push(reason),
    });
    const { retrigger } = attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);
    clearSpineStub(retrigger);

    const presentation = hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      ACTIVE_STATE,
    );
    await Promise.resolve();
    pending[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(phases).toEqual(["input-ready"]);

    hud.restoreFeatureState({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      freeSpinsWinMinor: "0",
    });
    await presentation;

    expect(hud.requestCapContinue()).toBe(false);
    expect(phases).toEqual(["input-ready"]);
    expect(closeReasons).toEqual(["cancelled"]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(retrigger.state.setAnimation.mock.calls.map((call) => call[1])).not.toContain(
      FREE_SPIN_HUD_ANIMATION.retrigger.hide,
    );
    expect(hud.visible).toBe(false);
    hud.destroy({ children: true });
  });

  it("finishes terminal CAPLIMIT from the retained active projection after BASE arrives", async () => {
    const waits: number[] = [];
    const hud = new FreeSpinHudView({
      wait: async (durationMs) => { waits.push(durationMs); },
    });
    const { retrigger } = attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);
    clearSpineStub(retrigger);

    await hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      {
        mode: "BASE",
        freeSpinsRemaining: 0,
        freeSpinsPlayed: 0,
        freeSpinsWinMinor: "0",
      },
    );

    expect(hud.projection).toMatchObject({
      active: true,
      remaining: ACTIVE_STATE.freeSpinsRemaining,
      played: ACTIVE_STATE.freeSpinsPlayed,
    });
    expect(waits).toEqual([
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.show,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hold,
      FREE_SPIN_HUD_ANIMATION_MS.retrigger.hide,
    ]);
    expect(retrigger.state.setAnimation.mock.calls.map((call) => call[1])).toEqual([
      FREE_SPIN_HUD_ANIMATION.retrigger.show,
      FREE_SPIN_HUD_ANIMATION.retrigger.hide,
      FREE_SPIN_HUD_ANIMATION.retrigger.hidden,
    ]);
    hud.destroy({ children: true });
  });

  it("compresses terminal retrigger and HUD hide without changing their order", async () => {
    const waits: number[] = [];
    const hud = new FreeSpinHudView({
      wait: async (durationMs) => { waits.push(durationMs); },
      prefersReducedMotion: () => true,
    });
    attachLoadedArtwork(hud);
    hud.restoreFeatureState(ACTIVE_STATE);

    await hud.retriggerCap(
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      ACTIVE_STATE,
    );
    await hud.hide();

    expect(waits).toEqual([
      FREE_SPIN_HUD_REDUCED_MOTION_MS.retrigger.show,
      FREE_SPIN_HUD_REDUCED_MOTION_MS.retrigger.hold,
      FREE_SPIN_HUD_REDUCED_MOTION_MS.retrigger.hide,
      FREE_SPIN_HUD_REDUCED_MOTION_MS.counterHide,
    ]);
    expect(hud.visible).toBe(false);
    hud.destroy({ children: true });
  });

  it("restores BASE mode hidden and fails closed for malformed authority data", async () => {
    const hud = new FreeSpinHudView();
    hud.restoreFeatureState({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      freeSpinsWinMinor: "0",
    });
    expect(hud.visible).toBe(false);
    expect(hud.projection.active).toBe(false);

    expect(() => projectFreeSpinHud({
      ...ACTIVE_STATE,
      freeSpinsRemaining: -1,
    })).toThrow(/freeSpinsRemaining/);
    expect(() => projectFreeSpinHud({
      ...ACTIVE_STATE,
      freeSpinsWinMinor: "12.34",
    })).toThrow(/minor units/);
    expect(() => hud.applyFreeSpinAwardBatch(
      [{ type: "free_spin.awarded", count: 0 }],
      ACTIVE_STATE,
    )).toThrow(/positive safe integer/);
    await expect(hud.retriggerCap(
      { type: "free_spin.awarded", count: 1 } as never,
      ACTIVE_STATE,
    )).rejects.toThrow(/free_spin\.cap_reached/);
    hud.destroy({ children: true });
  });
});
