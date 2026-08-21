import { describe, expect, it, vi } from "vitest";
import type { FeatureEvent, FeatureState, Win } from "../src/app/state/types";
import {
  LOGO_GAME_ANIMATION,
  LOGO_GAME_ANIMATION_MS,
  LOGO_GAME_DESKTOP_LAYOUT,
  LOGO_GAME_IDLE_TIMING,
  LOGO_GAME_SHOW_DELAY_MS,
  LOGO_GAME_SPINE_HOST,
  LogoGameView,
  logoGameResponsiveLayout,
  logoGameAnimationSequence,
  logoGameIdleDelayMs,
} from "../src/renderer/LogoGameView";
import { computeResponsiveFrameGeometry } from "../src/renderer/ResponsiveLayout";
import {
  PRIMAL_SPINE_SPECS,
  primalSpineSkeletonUrl,
} from "../src/renderer/spine/PrimalSpineAssets";
import {
  PixiRenderer,
  type CharacterWinPresentation,
} from "../src/renderer/PixiRenderer";
import {
  createSpinEnvironmentState,
  type SpinEnvironmentState,
} from "../src/renderer/spinEnvironmentMotion";

describe("native base-game logo", () => {
  it("registers the captured logo_game skeleton and clip contract", () => {
    expect(PRIMAL_SPINE_SPECS.logoGame).toEqual({
      group: "spine_ui",
      skeleton: "logo_game",
      idleAnimation: "idle",
    });
    expect(primalSpineSkeletonUrl("logoGame"))
      .toBe("/assets/primal-runtime/spine/spine_ui/logo_game.skel");
    expect(LOGO_GAME_ANIMATION).toEqual({
      hidden: "hidden",
      show: "show",
      idle: "idle",
      hide: "hide",
      win: "win",
    });
    expect(LOGO_GAME_ANIMATION_MS).toEqual({
      show: 1_033.333,
      idle: 1_500,
      hide: 333.333,
      win: 1_066.667,
    });
  });

  it("keeps transitions one-shot and reserves idle for the sparse source timer", () => {
    expect(logoGameAnimationSequence("show")).toEqual([
      { animation: "show", loop: false },
    ]);
    expect(logoGameAnimationSequence("win")).toEqual([
      { animation: "win", loop: false },
    ]);
    expect(logoGameAnimationSequence("hide")).toEqual([
      { animation: "hide", loop: false },
      { animation: "hidden", loop: false },
    ]);
    expect(LOGO_GAME_SHOW_DELAY_MS).toBe(250);
    expect(LOGO_GAME_IDLE_TIMING).toEqual({ fps: 24, minFrames: 100, maxFrames: 200 });
    expect(logoGameIdleDelayMs(() => 0)).toBeCloseTo(100_000 / 24, 10);
    expect(logoGameIdleDelayMs(() => 0.5)).toBeCloseTo(150_000 / 24, 10);
    expect(logoGameIdleDelayMs(() => 1)).toBeCloseTo(200_000 / 24, 10);
  });

  it("owns the measured 1280x720 desktop transform", () => {
    expect(LOGO_GAME_DESKTOP_LAYOUT).toEqual({
      x: -232,
      y: 104,
      scale: 0.8,
      minBound: [460, -130, 1_260, 900],
    });
    expect(LOGO_GAME_SPINE_HOST).toEqual({ x: 600, y: 74 });
    expect(LOGO_GAME_DESKTOP_LAYOUT.x + LOGO_GAME_SPINE_HOST.x * LOGO_GAME_DESKTOP_LAYOUT.scale)
      .toBeCloseTo(248, 10);
    expect(LOGO_GAME_DESKTOP_LAYOUT.y + LOGO_GAME_SPINE_HOST.y * LOGO_GAME_DESKTOP_LAYOUT.scale)
      .toBeCloseTo(163.2, 10);
    const view = new LogoGameView();
    expect(view.position.x).toBe(-232);
    expect(view.position.y).toBe(104);
    expect(view.scale.x).toBeCloseTo(0.8, 10);
    expect(view.scale.y).toBeCloseTo(0.8, 10);
    view.destroy({ children: true });
  });

  it("reprojects the official logo host at tablet and portrait widths", () => {
    const cases = [
      { viewport: [1_024, 768] as const, x: 113.778, y: 184.076, scale: 0.812698 },
      { viewport: [390, 844] as const, x: 43.333, y: 345.857, scale: 0.309524 },
    ];

    for (const { viewport: [width, height], x, y, scale } of cases) {
      const frame = computeResponsiveFrameGeometry(width, height);
      const layout = logoGameResponsiveLayout(frame.visibleInsetX);
      expect(frame.x + (layout.x + LOGO_GAME_SPINE_HOST.x * layout.scale) * frame.scale)
        .toBeCloseTo(x, 3);
      expect(frame.y + (layout.y + LOGO_GAME_SPINE_HOST.y * layout.scale) * frame.scale)
        .toBeCloseTo(y, 3);
      expect(layout.scale * frame.scale).toBeCloseTo(scale, 6);
    }
  });

  it("keeps the height-limited desktop root while applying the width-limited root", () => {
    expect(logoGameResponsiveLayout(64)).toMatchObject({
      x: -232,
      y: 104,
      scale: 0.8,
    });

    const view = new LogoGameView();
    view.setResponsiveLayout(160);
    expect(view.position.x).toBeCloseTo(-190.4761904762, 10);
    expect(view.position.y).toBeCloseTo(116.1904761905, 10);
    expect(view.scale.x).toBeCloseTo(0.7619047619, 10);
    view.destroy({ children: true });
  });

  it("retains show/hide intent across lazy artwork loading", () => {
    const view = new LogoGameView();
    expect(view.presentation).toBe("hidden");
    expect(view.visible).toBe(false);

    view.show();
    expect(view.presentation).toBe("shown");
    expect(view.visible).toBe(true);

    view.hide();
    expect(view.presentation).toBe("hidden");
    expect(view.visible).toBe(false);
    view.destroy({ children: true });
  });
});

describe("responsive Pixi node routing", () => {
  it("routes the frame visible inset to both authored minBound views", () => {
    const setLaunchComposition = vi.fn();
    const setLogoLayout = vi.fn();
    const setJackpotLayout = vi.fn();
    const syncAnticipationComposition = vi.fn();
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer as unknown as Record<string, unknown>, {
      canvasHost: {
        parentElement: {
          style: { getPropertyValue: vi.fn(() => "160px") },
        },
      },
      launchScene: { setResponsiveComposition: setLaunchComposition },
      gameLogo: { setResponsiveLayout: setLogoLayout },
      jackpotTower: { setResponsiveLayout: setJackpotLayout },
      syncAnticipationComposition,
    });

    renderer.setResponsiveComposition(960 / 1_100);

    expect(setLaunchComposition).toHaveBeenCalledWith(960 / 1_100);
    expect(setLogoLayout).toHaveBeenCalledWith(160);
    expect(setJackpotLayout).toHaveBeenCalledWith(160);
    expect(syncAnticipationComposition).toHaveBeenCalledTimes(1);
  });
});

interface LogoRoutingHarness {
  completeIntro(skipped: boolean): void;
  reactToWin(wins: readonly Win[], presentation: CharacterWinPresentation): Promise<void>;
  cueFeatureEnvironment(event: FeatureEvent, reducedMotion?: boolean): void;
  exitFeatureMode(state: FeatureState, reducedMotion?: boolean): Promise<void>;
  introCompleted: boolean;
  featureMode: FeatureState["mode"];
  environmentState: SpinEnvironmentState;
}

interface FeatureExitBarrierHarness {
  exitFeatureMode(state: FeatureState, reducedMotion?: boolean): Promise<void>;
  beginFeatureExitAtSummaryHide: ReturnType<typeof vi.fn>;
  pendingFeatureExit: Promise<void> | null;
  featureMode: FeatureState["mode"];
  backdrop: { settleFeatureExit: ReturnType<typeof vi.fn> };
  launchScene: { settleFeatureExit: ReturnType<typeof vi.fn> };
}

const BASE_FEATURE_STATE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
};

describe("PixiRenderer feature-exit final-frame barrier", () => {
  it.each(["EXPANSION", "OVERDRIVE"] as const)(
    "settles %s residue only after row reconciliation and before resolving",
    async (featureMode) => {
      let resolveRows: (() => void) | undefined;
      const pendingRows = new Promise<void>((resolve) => {
        resolveRows = resolve;
      });
      const order: string[] = [];
      void pendingRows.then(() => order.push("rows"));
      const renderer = Object.create(PixiRenderer.prototype) as FeatureExitBarrierHarness;
      Object.assign(renderer, {
        featureMode,
        pendingFeatureExit: pendingRows,
        beginFeatureExitAtSummaryHide: vi.fn(),
        backdrop: {
          settleFeatureExit: vi.fn(() => order.push("settle")),
        },
        launchScene: { settleFeatureExit: vi.fn(() => order.push("character")) },
      });

      const exit = renderer.exitFeatureMode(BASE_FEATURE_STATE);
      await Promise.resolve();
      expect(renderer.backdrop.settleFeatureExit).not.toHaveBeenCalled();

      resolveRows?.();
      await exit;

      expect(order).toEqual(["rows", "settle", "character"]);
      expect(renderer.pendingFeatureExit).toBeNull();
    },
  );

  it("settles and releases the barrier even when row reconciliation rejects", async () => {
    let rejectRows: ((reason?: unknown) => void) | undefined;
    const pendingRows = new Promise<void>((_resolve, reject) => {
      rejectRows = reject;
    });
    const fault = new Error("row reconciliation failed");
    const renderer = Object.create(PixiRenderer.prototype) as FeatureExitBarrierHarness;
    Object.assign(renderer, {
      featureMode: "EXPANSION",
      pendingFeatureExit: pendingRows,
      beginFeatureExitAtSummaryHide: vi.fn(),
      backdrop: { settleFeatureExit: vi.fn() },
      launchScene: { settleFeatureExit: vi.fn() },
    });

    const exit = renderer.exitFeatureMode(BASE_FEATURE_STATE);
    rejectRows?.(fault);

    await expect(exit).rejects.toBe(fault);
    expect(renderer.backdrop.settleFeatureExit).toHaveBeenCalledOnce();
    expect(renderer.launchScene.settleFeatureExit).toHaveBeenCalledOnce();
    expect(renderer.pendingFeatureExit).toBeNull();
  });

  it("still settles the character and releases the barrier when backdrop cleanup throws", async () => {
    const cleanupFault = new Error("backdrop cleanup failed");
    const renderer = Object.create(PixiRenderer.prototype) as FeatureExitBarrierHarness;
    Object.assign(renderer, {
      featureMode: "OVERDRIVE",
      pendingFeatureExit: Promise.resolve(),
      beginFeatureExitAtSummaryHide: vi.fn(),
      backdrop: { settleFeatureExit: vi.fn(() => { throw cleanupFault; }) },
      launchScene: { settleFeatureExit: vi.fn() },
    });

    await expect(renderer.exitFeatureMode(BASE_FEATURE_STATE)).rejects.toBe(cleanupFault);
    expect(renderer.launchScene.settleFeatureExit).toHaveBeenCalledOnce();
    expect(renderer.pendingFeatureExit).toBeNull();
  });
});

describe("PixiRenderer base-logo lifecycle routing", () => {
  it("shows after intro, wins only in base, hides on Free Spins entry, then shows on exit", async () => {
    const renderer = Object.create(PixiRenderer.prototype) as LogoRoutingHarness;
    const gameLogo = { show: vi.fn(), hide: vi.fn(), win: vi.fn() };
    const backdrop = {
      completeAuthoredIntro: vi.fn(),
      reactToWin: vi.fn(async () => undefined),
      transitionAuthoredPalette: vi.fn(),
      setExpansionRows: vi.fn(),
      settleFeatureExit: vi.fn(),
    };
    const launchScene = {
      completeAuthoredIntro: vi.fn(),
      playCharacterAnimation: vi.fn(),
      setCharacterBodyContinuation: vi.fn(),
      setCharacterPersistentPresentation: vi.fn(),
      settleFeatureExit: vi.fn(),
    };
    const reels = {
      activeRows: 3,
      clearHighlights: vi.fn(),
      clearWinMotion: vi.fn(),
      setVisualStripMode: vi.fn(),
    };
    Object.assign(renderer, {
      gameLogo,
      backdrop,
      launchScene,
      reels,
      reducedMotion: null,
      introCompleted: false,
      featureMode: "BASE",
      environmentState: createSpinEnvironmentState(),
    });

    renderer.completeIntro(false);
    expect(gameLogo.show).toHaveBeenCalledTimes(1);

    await renderer.reactToWin([{
      id: "logo-win",
      symbol: "TANK",
      amountMinor: "100",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    }], "base");
    expect(gameLogo.win).toHaveBeenCalledTimes(1);
    expect(launchScene.setCharacterBodyContinuation).toHaveBeenCalledWith("base", false);

    renderer.cueFeatureEnvironment({
      type: "free_spins.started",
      mode: "EXPANSION",
      awarded: 8,
    });
    expect(gameLogo.hide).toHaveBeenCalledWith();
    expect(reels.setVisualStripMode).toHaveBeenLastCalledWith("EXPANSION");

    await renderer.exitFeatureMode({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    });
    expect(gameLogo.show).toHaveBeenCalledTimes(2);
    expect(reels.setVisualStripMode).toHaveBeenLastCalledWith("BASE");
  });
});
