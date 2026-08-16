import { describe, expect, it, vi } from "vitest";
import {
  PixiRenderer,
  type FeaturePresentationBranch,
  type FeaturePresentationBranchListener,
  type RageCascadePresentationMilestone,
  type RageCascadePresentationMilestoneListener,
  type RageCollectionPresentationMilestone,
  type RageCollectionPresentationMilestoneListener,
} from "../src/renderer/PixiRenderer";
import type { RageCascadeEffectMilestoneListener } from "../src/renderer/FeatureEffects";
import { createSpinEnvironmentState } from "../src/renderer/spinEnvironmentMotion";

interface PresentationBranchHarness {
  featurePresentationBranchListener: FeaturePresentationBranchListener | null;
  notifyFeaturePresentationBranch(branch: FeaturePresentationBranch): void;
}

function harness(
  listener: FeaturePresentationBranchListener | null,
): PresentationBranchHarness {
  const renderer = Object.create(PixiRenderer.prototype) as PresentationBranchHarness;
  renderer.featurePresentationBranchListener = listener;
  return renderer;
}

describe("PixiRenderer bounded-gate branch observer", () => {
  it("forwards immutable CAP and summary close reasons without remapping them", () => {
    const observed: FeaturePresentationBranch[] = [];
    const renderer = harness((branch) => observed.push(branch));

    renderer.notifyFeaturePresentationBranch({
      type: "free-spin-cap.closed",
      reason: "continue",
    });
    renderer.notifyFeaturePresentationBranch({
      type: "free-spins.summary.closed",
      reason: "timeout",
    });

    expect(observed).toEqual([
      { type: "free-spin-cap.closed", reason: "continue" },
      { type: "free-spins.summary.closed", reason: "timeout" },
    ]);
    expect(observed.every(Object.isFrozen)).toBe(true);
  });

  it("fails open when the optional observer is absent or throws", () => {
    expect(() => harness(null).notifyFeaturePresentationBranch({
      type: "free-spin-cap.closed",
      reason: "cancelled",
    })).not.toThrow();

    const listener = vi.fn(() => {
      throw new Error("diagnostic observer failure");
    });
    expect(() => harness(listener).notifyFeaturePresentationBranch({
      type: "free-spins.summary.closed",
      reason: "continue",
    })).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
  });
});

interface RageCollectionHarness {
  rageCollectionPresentationMilestoneListener: RageCollectionPresentationMilestoneListener | null;
  activeRageCollectionCharacter: Readonly<{
    bodyClip: "idle_breaker2" | "chest_pound" | "win";
    started: boolean;
  }> | null;
  rageCollectionPresentationPaused: boolean;
  cueFeatureEnvironment: PixiRenderer["cueFeatureEnvironment"];
  setRageCollectionPresentationMilestoneListener:
    PixiRenderer["setRageCollectionPresentationMilestoneListener"];
  setRageCollectionPresentationPaused: PixiRenderer["setRageCollectionPresentationPaused"];
  playCharacterCollect(sourceEvent: string): boolean;
  notifyRageCollectionPresentationMilestone(milestone: {
    readonly phase: "started" | "absorbing" | "source-hidden" | "complete";
    readonly cells: readonly Readonly<{ reel: number; row: number }>[];
    readonly elapsedMs: number;
    readonly authoredAtMs: number;
    readonly reducedMotion: boolean;
    readonly activated: boolean;
    readonly hidden: boolean;
    readonly towerReactionStarted: boolean;
  }): void;
}

function rageHarness(parts: Record<string, unknown>): RageCollectionHarness {
  const renderer = Object.create(PixiRenderer.prototype) as RageCollectionHarness;
  Object.defineProperties(renderer, Object.fromEntries(
    Object.entries({
      environmentState: createSpinEnvironmentState(),
      characterCollectRandomSource: () => 0,
      rageCollectionPresentationMilestoneListener: null,
      activeRageCollectionCharacter: null,
      rageCollectionPresentationPaused: false,
      ...parts,
    }).map(([key, value]) => [key, { configurable: true, writable: true, value }]),
  ));
  return renderer;
}

describe("PixiRenderer Rage collection observer", () => {
  it("samples only the injected cosmetic body source and leaves the jackpot tower to the post-launch barrier", () => {
    const randomSource = vi.fn(() => 0.5);
    const blockSymbolIdle = vi.fn();
    const playCharacterCollect = vi.fn(() => true);
    const reactToCollection = vi.fn();
    const renderer = rageHarness({
      characterCollectRandomSource: randomSource,
      reels: { activeRows: 3, blockSymbolIdle },
      launchScene: { playCharacterCollect },
      jackpotTower: { reactToCollection },
    });
    const event = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    } as const;

    renderer.cueFeatureEnvironment(event, false);

    expect(blockSymbolIdle).toHaveBeenCalledWith(event.cells);
    expect(randomSource).toHaveBeenCalledOnce();
    expect(playCharacterCollect).toHaveBeenCalledWith(0.5);
    expect(renderer.activeRageCollectionCharacter).toEqual({
      bodyClip: "chest_pound",
      started: true,
    });
    expect(reactToCollection).not.toHaveBeenCalled();
  });

  it("forwards immutable body/tower facts, fails open, and clears the body after complete", () => {
    const observed: Readonly<RageCollectionPresentationMilestone>[] = [];
    const listener = vi.fn((milestone: Readonly<RageCollectionPresentationMilestone>) => {
      observed.push(milestone);
      if (milestone.phase === "absorbing") throw new Error("fixture observer failure");
    });
    const renderer = rageHarness({
      rageCollectionPresentationMilestoneListener: listener,
      activeRageCollectionCharacter: { bodyClip: "win", started: true },
    });
    const milestone = (phase: "started" | "absorbing" | "complete") => ({
      phase,
      cells: [{ reel: 1, row: 0 }],
      elapsedMs: phase === "started" ? 0 : phase === "absorbing" ? 500 : 1_200,
      authoredAtMs: phase === "started" ? 0 : phase === "absorbing" ? 500 : 1_200,
      reducedMotion: false,
      activated: phase !== "complete",
      hidden: phase === "complete",
      towerReactionStarted: phase !== "started",
    } as const);

    renderer.notifyRageCollectionPresentationMilestone(milestone("started"));
    expect(() => renderer.notifyRageCollectionPresentationMilestone(
      milestone("absorbing"),
    )).not.toThrow();
    renderer.notifyRageCollectionPresentationMilestone(milestone("complete"));

    expect(observed).toHaveLength(3);
    expect(observed[0]).toMatchObject({
      phase: "started",
      bodyClip: "win",
      characterStarted: true,
      towerReactionStarted: false,
    });
    expect(observed[1]).toMatchObject({
      phase: "absorbing",
      bodyClip: "win",
      characterStarted: true,
      towerReactionStarted: true,
    });
    expect(observed.every(Object.isFrozen)).toBe(true);
    expect(observed.every(({ cells }) => Object.isFrozen(cells))).toBe(true);
    expect(renderer.activeRageCollectionCharacter).toBeNull();
  });

  it("forwards the screenshot hold only to the local Rage presentation clock", () => {
    const setRageCollectionPlaybackPaused = vi.fn();
    const renderer = rageHarness({
      featureEffects: { setRageCollectionPlaybackPaused },
    });

    renderer.setRageCollectionPresentationPaused(true);
    renderer.setRageCollectionPresentationPaused(true);
    renderer.setRageCollectionPresentationPaused(false);

    expect(setRageCollectionPlaybackPaused.mock.calls).toEqual([[true], [false]]);
  });
});

interface RageCascadeHarness {
  rageCascadePresentationMilestoneListener: RageCascadePresentationMilestoneListener | null;
  rageCascadePresentationPaused: boolean;
  featureEffects: {
    setRageCascadeMilestoneListener(listener: RageCascadeEffectMilestoneListener | null): void;
    setRageCascadePlaybackPaused(active: boolean): void;
  };
  setRageCascadePresentationMilestoneListener:
    PixiRenderer["setRageCascadePresentationMilestoneListener"];
  notifyRageCascadePresentationMilestone(milestone: RageCascadePresentationMilestone): void;
  setRageCascadePresentationPaused: PixiRenderer["setRageCascadePresentationPaused"];
}

describe("PixiRenderer Rage cascade observer", () => {
  it("installs the FeatureEffects bridge only while a read-only observer exists", () => {
    const setRageCascadeMilestoneListener = vi.fn();
    const setRageCascadePlaybackPaused = vi.fn();
    const listener = vi.fn(() => {
      throw new Error("fixture observer failure");
    });
    const renderer = Object.create(PixiRenderer.prototype) as RageCascadeHarness;
    Object.defineProperties(renderer, {
      rageCascadePresentationMilestoneListener: {
        configurable: true,
        writable: true,
        value: null,
      },
      rageCascadePresentationPaused: {
        configurable: true,
        writable: true,
        value: false,
      },
      featureEffects: {
        configurable: true,
        value: { setRageCascadeMilestoneListener, setRageCascadePlaybackPaused },
      },
    });

    renderer.setRageCascadePresentationMilestoneListener(listener);
    const bridge = setRageCascadeMilestoneListener.mock.calls[0]?.[0] as
      RageCascadeEffectMilestoneListener | undefined;
    expect(bridge).toBeTypeOf("function");
    const milestone = Object.freeze({
      phase: "exploding",
      authoredAtMs: 390,
      elapsedMs: 390,
      reducedMotion: false,
      transformedCells: Object.freeze([
        Object.freeze({ reel: 1, row: 1 }),
        Object.freeze({ reel: 2, row: 1 }),
      ]),
      shuffledCells: Object.freeze([]),
      activationAttempted: 0,
      activationPlayed: 0,
      shakePhase: "respin",
      shakeAuthoredAtMs: 400,
      shakeElapsedMs: 400,
      hidden: false,
    }) satisfies RageCascadePresentationMilestone;

    expect(() => bridge?.(milestone)).not.toThrow();
    expect(listener).toHaveBeenCalledWith(milestone);

    renderer.setRageCascadePresentationMilestoneListener(null);
    expect(setRageCascadeMilestoneListener.mock.calls.at(-1)?.[0]).toBeNull();

    renderer.setRageCascadePresentationPaused(true);
    renderer.setRageCascadePresentationPaused(true);
    renderer.setRageCascadePresentationPaused(false);
    expect(setRageCascadePlaybackPaused.mock.calls).toEqual([[true], [false]]);
  });
});
