import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container, Point, Texture } from "pixi.js";

interface RecordedAnimation {
  readonly method: "set" | "add";
  readonly track: number;
  readonly animation: string;
  readonly loop: boolean;
}

interface RecordingSpine extends Container {
  readonly animations: RecordedAnimation[];
  readonly activeTracks: ReadonlyMap<number, string>;
  readonly state: { timeScale: number };
  readonly spineKey?: string;
}

const spineRecorder = vi.hoisted(() => ({ instances: [] as RecordingSpine[] }));

vi.mock("pixi.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("pixi.js")>();

  class TestGraphics extends original.Container {
    beginFill(): this { return this; }
    drawRect(): this { return this; }
    drawRoundedRect(): this { return this; }
    drawCircle(): this { return this; }
    drawEllipse(): this { return this; }
    drawPolygon(): this { return this; }
    endFill(): this { return this; }
    lineStyle(): this { return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
  }

  class TestTextStyle {
    constructor(readonly options: unknown = {}) {}
  }

  class TestText extends original.Container {
    readonly anchor = { set: vi.fn() };
    private measuredWidth = 1;
    private measuredHeight = 32;

    constructor(public text: string, readonly style?: unknown) {
      super();
      this.measuredWidth = Math.max(1, text.length * 16);
    }

    override get width(): number { return this.measuredWidth; }
    override set width(value: number) { this.measuredWidth = value; }
    override get height(): number { return this.measuredHeight; }
    override set height(value: number) { this.measuredHeight = value; }
  }

  return {
    ...original,
    Graphics: TestGraphics,
    Text: TestText,
    TextStyle: TestTextStyle,
  };
});

vi.mock("../src/renderer/spine/PrimalSpineAssets", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/renderer/spine/PrimalSpineAssets")>();
  return {
    ...original,
    loadPrimalSpineSet: vi.fn(async (keys: readonly string[]) => Object.fromEntries(
      keys.map((key) => [key, { testSpineData: key }]),
    )),
  };
});

vi.mock("../src/renderer/spine/SpineAdapter", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/renderer/spine/SpineAdapter")>();
  const pixi = await import("pixi.js");

  class TestSpine extends pixi.Container implements RecordingSpine {
    readonly animations: RecordedAnimation[] = [];
    readonly activeTracks = new Map<number, string>();
    constructor(readonly spineKey?: string) {
      super();
    }
    autoUpdate = false;
    private readonly rotationBone = {
      x: 0,
      y: 0,
      rotation: 0,
      worldToLocal: vi.fn((point: { x: number; y: number }) => {
        point.y = -point.y;
        return point;
      }),
    };
    readonly skeleton = {
      color: { a: 1 },
      setToSetupPose: vi.fn(),
      updateWorldTransform: vi.fn(),
      findSlot: vi.fn(() => null),
      findBone: vi.fn(() => this.rotationBone),
      getAttachment: vi.fn(() => null),
    };
    readonly state = {
      timeScale: 1,
      hasAnimation: vi.fn(() => true),
      clearTrack: vi.fn((track: number) => {
        this.activeTracks.delete(track);
      }),
      clearTracks: vi.fn(() => {
        this.activeTracks.clear();
      }),
      setAnimation: vi.fn((track: number, animation: string, loop: boolean) => {
        this.animations.push({ method: "set", track, animation, loop });
        this.activeTracks.set(track, animation);
        return { timeScale: 1 };
      }),
      addAnimation: vi.fn((track: number, animation: string, loop: boolean) => {
        this.animations.push({ method: "add", track, animation, loop });
        return { timeScale: 1 };
      }),
    };
    readonly update = vi.fn();

    override destroy(options?: Parameters<Container["destroy"]>[0]): void {
      this.activeTracks.clear();
      super.destroy(options);
    }
  }

  return {
    ...original,
    createSpineView: vi.fn((data?: { testSpineData?: string }) => {
      const spine = new TestSpine(data?.testSpineData);
      spineRecorder.instances.push(spine);
      return spine;
    }),
  };
});

import type { FeatureEvent } from "../src/app/state/types";
import { PRIMAL_FEATURE_ANIMATION_MS } from "../src/reels/primalAnimationTiming";
import {
  FeatureEffects,
  FREE_SPIN_NO_WIN_COPY,
  FREE_SPIN_SUMMARY_TIMELINE_MS,
  PRIMAL_WHEEL_TIMELINE_MS,
  RAGE_COLLECT_ABSORBING_MS,
  RAGE_COLLECT_HIDE_START_MS,
  RAGE_COLLECT_FULLY_HIDDEN_MS,
  RAGE_COLLECT_SYMBOL_MS,
  RAGE_COLLECT_TRAIL_MS,
  featureEffectDuration,
  loadFeatureTextures,
  type FeatureEffectsHooks,
  type RageCascadeCellOrderSource,
  type RageCascadeEffectMilestone,
  type RageCollectionEffectMilestone,
  type WheelStopOffsetSource,
} from "../src/renderer/FeatureEffects";
import {
  VisualTelemetryReporter,
  type VisualTelemetryEvent,
} from "../src/renderer/VisualTelemetry";
import type { ReelSetView } from "../src/reels/ReelSetView";

class ManualAnimationFrameClock {
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;
  now = 10_000;

  get pendingFrames(): number {
    return this.callbacks.size;
  }

  install(): void {
    vi.stubGlobal("performance", { now: () => this.now });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.callbacks.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      this.callbacks.delete(handle);
    });
  }

  frameAt(timeMs: number): void {
    if (timeMs < this.now) throw new Error("Manual RAF clock cannot move backwards");
    this.now = timeMs;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(timeMs));
  }
}

function createEffects(
  hooks: FeatureEffectsHooks = {},
  wheelStopOffsetSource?: WheelStopOffsetSource,
  visualTelemetry: VisualTelemetryReporter | null = null,
  rageCascadeCellOrderSource?: RageCascadeCellOrderSource,
): {
  readonly effects: FeatureEffects;
  readonly reels: Container;
} {
  const host = new Container();
  const reels = new Container();
  Object.assign(reels, { activeRows: 3 });
  return {
    effects: new FeatureEffects(
      host,
      reels as ReelSetView,
      null,
      hooks,
      wheelStopOffsetSource,
      visualTelemetry,
      rageCascadeCellOrderSource,
    ),
    reels,
  };
}

function installRageCascadeReels(
  reels: Container,
  activation: Readonly<{ attempted: number; played: number }> = { attempted: 3, played: 3 },
): Readonly<{
  prepare: ReturnType<typeof vi.fn>;
  frame: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
}> {
  const prepare = vi.fn();
  const frame = vi.fn(() => true);
  const reveal = vi.fn(() => true);
  const activate = vi.fn(() => activation);
  const complete = vi.fn();
  Object.assign(reels, {
    prepareRageCascade: prepare,
    playAuthoredFrame: frame,
    revealRageCascadeCell: reveal,
    activateRageCascade: activate,
    completeRageCascade: complete,
  });
  return { prepare, frame, reveal, activate, complete };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function newestSpine(): RecordingSpine {
  const spine = spineRecorder.instances.at(-1);
  if (!spine) throw new Error("Expected the renderer to create an authored Spine view");
  return spine;
}

function animations(spine: RecordingSpine, name: string): RecordedAnimation[] {
  return spine.animations.filter(({ animation }) => animation === name);
}

function wheelSpineSince(firstSpine: number): RecordingSpine {
  const spine = spineRecorder.instances.slice(firstSpine).find((candidate) => (
    animations(candidate, "anticipation/anticipation_loop").length > 0
  ));
  if (!spine) throw new Error("Expected an active authored Wheel Spine view");
  return spine;
}

function wheelScenePointerTarget(root: Container): Container {
  const pending = [...root.children];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate) continue;
    if (candidate.listenerCount("pointertap") > 0) return candidate as Container;
    if (candidate instanceof Container) pending.push(...candidate.children);
  }
  throw new Error("Expected the Wheel scene to expose its authored pointer target");
}

function expectDestroyedWheelCleanup(options: {
  readonly effects: FeatureEffects;
  readonly reels: Container;
  readonly clock: ManualAnimationFrameClock;
  readonly pointerTarget: Container;
  readonly spines: readonly RecordingSpine[];
}): void {
  const { effects, reels, clock, pointerTarget, spines } = options;
  expect(effects.requestWheelInteraction()).toBeNull();
  expect(effects.requestWheelSummaryContinue()).toBe(false);
  expect(reels.alpha).toBe(1);
  expect(effects.view.children).toHaveLength(0);
  expect(clock.pendingFrames).toBe(0);
  expect(pointerTarget.destroyed).toBe(true);
  expect(pointerTarget.interactive).toBe(false);
  expect(pointerTarget.listenerCount("pointertap")).toBe(0);
  expect(spines.length).toBeGreaterThan(0);
  for (const spine of spines) {
    expect(spine.destroyed).toBe(true);
    expect(spine.activeTracks.size).toBe(0);
  }
}

type WheelAward = Extract<FeatureEvent, { readonly type: "wheel.awarded" }>;

const MINI_WHEEL_AWARD: WheelAward = {
  type: "wheel.awarded",
  outcome: "INSTANT",
  prize: "MINI",
  multiplier: 10,
  amountMinor: "1000",
};

const WHEEL_AWARD_CASES: readonly {
  readonly label: string;
  readonly event: WheelAward;
  readonly highlight: string;
}[] = [
  {
    label: "MEGA",
    event: {
      type: "wheel.awarded", outcome: "INSTANT", prize: "MEGA",
      multiplier: 250, amountMinor: "25000",
    },
    highlight: "highlights/highlight0",
  },
  {
    label: "KONG QUEST",
    event: { type: "wheel.awarded", outcome: "EXPANSION" },
    highlight: "highlights/highlight1",
  },
  {
    label: "MINOR",
    event: {
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINOR",
      multiplier: 30, amountMinor: "3000",
    },
    highlight: "highlights/highlight2",
  },
  {
    label: "GRAND",
    event: {
      type: "wheel.awarded", outcome: "INSTANT", prize: "GRAND",
      multiplier: 1_000, amountMinor: "100000",
    },
    highlight: "highlights/highlight3",
  },
  {
    label: "KING SPIN",
    event: { type: "wheel.awarded", outcome: "OVERDRIVE" },
    highlight: "highlights/highlight4",
  },
  {
    label: "MAJOR",
    event: {
      type: "wheel.awarded", outcome: "INSTANT", prize: "MAJOR",
      multiplier: 75, amountMinor: "7500",
    },
    highlight: "highlights/highlight5",
  },
  {
    label: "MINI",
    event: MINI_WHEEL_AWARD,
    highlight: "highlights/highlight6",
  },
];

function textValues(root: unknown): string[] {
  const values: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const candidate = node as { text?: unknown; children?: readonly unknown[] };
    if (typeof candidate.text === "string") values.push(candidate.text);
    candidate.children?.forEach(visit);
  };
  visit(root);
  return values;
}

async function finishCurrentAnimation(
  clock: ManualAnimationFrameClock,
  durationMs: number,
): Promise<void> {
  const start = clock.now;
  clock.frameAt(start);
  await flushAsync();
  clock.frameAt(start + durationMs + 0.001);
  await flushAsync();
}

describe("rare-state renderer replay", () => {
  beforeEach(() => {
    spineRecorder.instances.length = 0;
    vi.spyOn(Texture, "from").mockReturnValue(Texture.EMPTY);
    vi.spyOn(Texture, "fromURL").mockResolvedValue(Texture.EMPTY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not replay PPS cascade after the exact-three stop-outro activation", async () => {
    const onRageRespin = vi.fn();
    const onRagePound = vi.fn();
    const onRageBackdropShake = vi.fn();
    const { effects, reels } = createEffects({
      onRageRespin,
      onRagePound,
      onRageBackdropShake,
    });
    const prepareRageCascade = vi.fn();
    const playAuthoredFrame = vi.fn(() => true);
    const revealRageCascadeCell = vi.fn(() => true);
    const activateRageCascade = vi.fn(() => ({ attempted: 3, played: 3 }));
    const completeRageCascade = vi.fn();
    const activateRageCells = vi.fn(() => ({ attempted: 3, played: 3 }));
    Object.assign(reels, {
      prepareRageCascade,
      playAuthoredFrame,
      revealRageCascadeCell,
      activateRageCascade,
      completeRageCascade,
      activateRageCells,
    });

    await effects.presentAfterReels({
      type: "surge.collected",
      count: 3,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 0 }, { reel: 2, row: 2 }],
      triggered: true,
      guaranteed: true,
      level: 1,
      total: 0,
    }, false);

    expect(prepareRageCascade).not.toHaveBeenCalled();
    expect(playAuthoredFrame).not.toHaveBeenCalled();
    expect(revealRageCascadeCell).not.toHaveBeenCalled();
    expect(activateRageCascade).not.toHaveBeenCalled();
    expect(completeRageCascade).not.toHaveBeenCalled();
    expect(activateRageCells).not.toHaveBeenCalled();
    expect(onRageRespin).not.toHaveBeenCalled();
    expect(onRagePound).not.toHaveBeenCalled();
    expect(onRageBackdropShake).not.toHaveBeenCalled();
    expect(effects.view.children).toHaveLength(0);
  });

  it("replays the complete 4120ms Rage cascade through immutable authored milestones", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const traversal = [8, 0, 7, 1, 6, 2, 5, 3, 4] as const;
    const traversalSource = vi.fn(() => traversal);
    const onRageRespin = vi.fn();
    const onRagePound = vi.fn();
    const onRageBackdropShake = vi.fn();
    const { effects, reels } = createEffects(
      { onRageRespin, onRagePound, onRageBackdropShake },
      undefined,
      null,
      traversalSource,
    );
    const reelCalls = installRageCascadeReels(reels);
    const milestones: Readonly<RageCascadeEffectMilestone>[] = [];
    const cleanupCountAtMilestone: number[] = [];
    effects.setRageCascadeMilestoneListener((milestone) => {
      milestones.push(milestone);
      cleanupCountAtMilestone.push(reelCalls.complete.mock.calls.length);
    });

    const presentation = effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, false);
    const startedAt = clock.now;

    expect(milestones.map(({ phase }) => phase)).toEqual(["started"]);
    expect(milestones[0]).toMatchObject({
      authoredAtMs: 0,
      elapsedMs: 0,
      transformedCells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      shuffledCells: [],
      activationAttempted: 0,
      activationPlayed: 0,
      shakePhase: null,
      shakeAuthoredAtMs: null,
      shakeElapsedMs: null,
      hidden: false,
    });
    expect(Object.isFrozen(milestones[0])).toBe(true);
    expect(Object.isFrozen(milestones[0]?.transformedCells)).toBe(true);
    expect(Object.isFrozen(milestones[0]?.transformedCells[0])).toBe(true);

    clock.frameAt(startedAt);
    for (const authoredAtMs of [
      390, 400, 450, 510, 570, 630, 690, 750, 810, 870,
      930, 1_430, 1_820, 1_930, 3_986.7,
    ]) {
      clock.frameAt(startedAt + authoredAtMs);
    }

    const exploding = milestones.find(({ phase }) => phase === "exploding");
    const shuffled = exploding?.shuffledCells ?? [];
    expect(shuffled.map(({ cellIndex }) => cellIndex)).toEqual(traversal);
    expect(shuffled.map(({ orderIndex }) => orderIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffled.map(({ transformsToRage }) => transformsToRage))
      .toEqual([false, false, true, false, false, false, false, false, true]);
    expect(new Set(shuffled.map(({ cellIndex }) => cellIndex)).size).toBe(9);
    expect(Object.isFrozen(shuffled)).toBe(true);
    expect(shuffled.every(Object.isFrozen)).toBe(true);
    expect(shuffled.every(({ address }) => Object.isFrozen(address))).toBe(true);
    expect(reelCalls.reveal.mock.calls).toEqual(traversal.map((cellIndex) => [{
      reel: Math.floor(cellIndex / 3),
      row: cellIndex % 3,
    }, cellIndex === 4 || cellIndex === 7]));
    // 转轴优先索引 1 上已稳定的 Rage 仍是普通 Symbol7，只会作为一次成功且
    // 不发生变换的遍历空操作参与流程。
    expect(reelCalls.reveal).toHaveBeenCalledWith({ reel: 0, row: 1 }, false);
    expect(onRageRespin).toHaveBeenCalledOnce();
    expect(onRagePound).toHaveBeenCalledOnce();
    expect(onRageBackdropShake.mock.calls).toEqual([["respin"], ["pound"]]);
    expect(reelCalls.frame.mock.calls).toEqual([["respin"], ["pound"]]);
    expect(reelCalls.activate).toHaveBeenCalledOnce();

    const authoredCellTimes = shuffled.map(({ authoredAtMs }) => authoredAtMs);
    expect(authoredCellTimes).toEqual([390, 450, 510, 570, 630, 690, 750, 810, 870]);
    expect(milestones.map(({ phase }) => phase)).toEqual([
      "started", "exploding", "placed", "pound", "activation", "source-hidden",
    ]);
    expect(milestones.filter(({ shakePhase }) => shakePhase !== null).map((milestone) => ({
      at: milestone.shakeAuthoredAtMs,
      shake: milestone.shakePhase,
    }))).toEqual([
      { at: 400, shake: "respin" },
      { at: 1_930, shake: "pound" },
    ]);
    expect(milestones.find(({ phase }) => phase === "activation")).toMatchObject({
      authoredAtMs: 1_820,
      activationAttempted: 3,
      activationPlayed: 3,
      hidden: false,
    });
    expect(milestones.find(({ phase }) => phase === "source-hidden")).toMatchObject({
      authoredAtMs: 3_986.7,
      activationAttempted: 3,
      activationPlayed: 3,
      hidden: true,
    });
    expect(reelCalls.complete).not.toHaveBeenCalled();

    clock.frameAt(startedAt + 4_120);
    await presentation;

    expect(milestones.map(({ phase, authoredAtMs }) => ({ phase, authoredAtMs }))).toEqual([
      { phase: "started", authoredAtMs: 0 },
      { phase: "exploding", authoredAtMs: 390 },
      { phase: "placed", authoredAtMs: 930 },
      { phase: "pound", authoredAtMs: 1_430 },
      { phase: "activation", authoredAtMs: 1_820 },
      { phase: "source-hidden", authoredAtMs: 3_986.7 },
      { phase: "complete", authoredAtMs: 4_120 },
    ]);
    expect(milestones.at(-1)).toMatchObject({
      phase: "complete",
      authoredAtMs: 4_120,
      elapsedMs: 4_120,
      activationAttempted: 3,
      activationPlayed: 3,
      hidden: true,
    });
    expect(cleanupCountAtMilestone.at(-1)).toBe(1);
    expect(reelCalls.complete).toHaveBeenCalledOnce();
    expect(traversalSource).toHaveBeenCalledOnce();
    effects.destroy();
  });

  it("rejects a capture traversal source that is not a permutation of cells 0..8", async () => {
    const { effects, reels } = createEffects(
      {},
      undefined,
      null,
      () => [0, 1, 2, 3, 4, 5, 6, 7, 7],
    );
    const reelCalls = installRageCascadeReels(reels);

    await expect(effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, false)).rejects.toThrow(/permutation of cells 0\.\.8/);

    expect(reelCalls.prepare).not.toHaveBeenCalled();
    expect(reelCalls.reveal).not.toHaveBeenCalled();
    expect(reelCalls.activate).not.toHaveBeenCalled();
    expect(reelCalls.complete).not.toHaveBeenCalled();
    effects.destroy();
  });

  it("compresses the same ordered Rage cascade milestones to 120ms", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const { effects, reels } = createEffects(
      {},
      undefined,
      null,
      () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    const reelCalls = installRageCascadeReels(reels);
    const milestones: Readonly<RageCascadeEffectMilestone>[] = [];
    effects.setRageCascadeMilestoneListener((milestone) => milestones.push(milestone));

    const presentation = effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, true);
    const startedAt = clock.now;
    clock.frameAt(startedAt);
    clock.frameAt(startedAt + 120);
    await presentation;

    expect(milestones.map(({ phase }) => phase)).toEqual([
      "started", "exploding", "placed", "pound", "activation", "source-hidden", "complete",
    ]);
    expect(milestones.at(-1)).toMatchObject({
      authoredAtMs: 4_120,
      elapsedMs: 120,
      reducedMotion: true,
      activationAttempted: 3,
      activationPlayed: 3,
      hidden: true,
    });
    expect(reelCalls.reveal).toHaveBeenCalledTimes(9);
    expect(reelCalls.complete).toHaveBeenCalledOnce();
    effects.destroy();
  });

  it("holds the Rage cascade authored clock without crossing the next semantic phase", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const { effects, reels } = createEffects(
      {},
      undefined,
      null,
      () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    installRageCascadeReels(reels);
    const milestones: Readonly<RageCascadeEffectMilestone>[] = [];
    effects.setRageCascadeMilestoneListener((milestone) => {
      milestones.push(milestone);
      if (milestone.phase === "exploding") effects.setRageCascadePlaybackPaused(true);
    });

    const presentation = effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, false);
    const startedAt = clock.now;
    clock.frameAt(startedAt);
    // 刻意延迟的一帧会使剩余所有预设边界都到期。发生异常的检查点仍必须立即
    // 停止当前同一个回调。
    clock.frameAt(startedAt + 4_120);
    expect(milestones.map(({ phase }) => phase)).toEqual(["started", "exploding"]);

    clock.frameAt(startedAt + 8_000);
    expect(milestones.map(({ phase }) => phase)).toEqual(["started", "exploding"]);

    effects.setRageCascadePlaybackPaused(false);
    clock.frameAt(startedAt + 8_001);
    await presentation;
    expect(milestones.map(({ phase }) => phase)).toEqual([
      "started", "exploding", "placed", "pound", "activation", "source-hidden", "complete",
    ]);
    effects.destroy();
  });

  it("holds the cleaned complete checkpoint until resume before resolving the cascade", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const { effects, reels } = createEffects(
      {},
      undefined,
      null,
      () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    const reelCalls = installRageCascadeReels(reels);
    const milestones: Readonly<RageCascadeEffectMilestone>[] = [];
    effects.setRageCascadeMilestoneListener((milestone) => {
      milestones.push(milestone);
      if (milestone.phase === "complete") effects.setRageCascadePlaybackPaused(true);
    });
    let resolved = false;
    const presentation = effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, false).then(() => { resolved = true; });
    const startedAt = clock.now;
    clock.frameAt(startedAt);
    clock.frameAt(startedAt + 4_120);
    await flushAsync();

    expect(milestones.at(-1)?.phase).toBe("complete");
    expect(reelCalls.complete).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);
    expect(clock.pendingFrames).toBe(0);

    effects.setRageCascadePlaybackPaused(false);
    await presentation;
    expect(resolved).toBe(true);
    expect(effects.cancelRageCascadePresentation()).toBe(false);
    effects.destroy();
  });

  it.each(["cancel", "destroy"] as const)(
    "%s releases a held complete checkpoint and rejects before the queued owner continues",
    async (exit) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const { effects, reels } = createEffects(
        {},
        undefined,
        null,
        () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
      );
      const reelCalls = installRageCascadeReels(reels);
      const milestones: Readonly<RageCascadeEffectMilestone>[] = [];
      effects.setRageCascadeMilestoneListener((milestone) => {
        milestones.push(milestone);
        if (milestone.phase === "complete") effects.setRageCascadePlaybackPaused(true);
      });
      const presentation = effects.presentAfterReels({
        type: "rage.transformed",
        count: 2,
        cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
        level: 1,
        total: 1,
      }, false);
      const startedAt = clock.now;
      clock.frameAt(startedAt);
      clock.frameAt(startedAt + 4_120);
      await flushAsync();
      expect(milestones.filter(({ phase }) => phase === "complete")).toHaveLength(1);
      expect(reelCalls.complete).toHaveBeenCalledOnce();

      if (exit === "cancel") expect(effects.cancelRageCascadePresentation()).toBe(true);
      else effects.destroy();

      await expect(presentation).rejects.toThrow(/cancelled/);
      expect(milestones.filter(({ phase }) => phase === "complete")).toHaveLength(1);
      expect(reelCalls.complete).toHaveBeenCalledOnce();
      if (exit === "cancel") effects.destroy();
    },
  );

  it("fails authored visual telemetry unless Rage activation is exactly 3/3", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const reporter = new VisualTelemetryReporter();
    const telemetry: VisualTelemetryEvent[] = [];
    reporter.setListener((event) => { telemetry.push(event); });
    const { effects, reels } = createEffects(
      {},
      undefined,
      reporter,
      () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    installRageCascadeReels(reels, { attempted: 2, played: 2 });

    const presentation = effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, false);
    const startedAt = clock.now;
    clock.frameAt(startedAt);
    clock.frameAt(startedAt + 4_120);
    await presentation;

    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: "fail",
      id: "rage.cascade",
      stage: "animation",
      code: "missing-animation",
    }));
    effects.destroy();
  });

  it.each(["cancel", "destroy"] as const)(
    "%s cleans a live Rage cascade, rejects its owner, and emits no late phase",
    async (exit) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const { effects, reels } = createEffects(
        {},
        undefined,
        null,
        () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
      );
      const reelCalls = installRageCascadeReels(reels);
      const milestones: Readonly<RageCascadeEffectMilestone>[] = [];
      effects.setRageCascadeMilestoneListener((milestone) => milestones.push(milestone));
      const presentation = effects.presentAfterReels({
        type: "rage.transformed",
        count: 2,
        cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
        level: 1,
        total: 1,
      }, false);
      const startedAt = clock.now;
      clock.frameAt(startedAt);
      clock.frameAt(startedAt + 450);
      const phasesBeforeExit = milestones.map(({ phase }) => phase);

      if (exit === "cancel") expect(effects.cancelRageCascadePresentation()).toBe(true);
      else effects.destroy();

      await expect(presentation).rejects.toThrow(/Rage cascade presentation cancelled/);
      expect(reelCalls.complete).toHaveBeenCalledOnce();
      expect(clock.pendingFrames).toBe(0);
      clock.frameAt(startedAt + 8_000);
      await flushAsync();
      expect(milestones.map(({ phase }) => phase)).toEqual(phasesBeforeExit);
      expect(milestones.some(({ phase }) => phase === "complete")).toBe(false);
      if (exit === "cancel") {
        expect(effects.cancelRageCascadePresentation()).toBe(false);
        effects.destroy();
      }
    },
  );

  it("treats the reusable round boundary as a cancelled Rage visual, not a failure", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const reporter = new VisualTelemetryReporter();
    const telemetry: VisualTelemetryEvent[] = [];
    reporter.setListener((event) => { telemetry.push(event); });
    const { effects, reels } = createEffects(
      {},
      undefined,
      reporter,
      () => [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    installRageCascadeReels(reels);
    const presentation = effects.presentAfterReels({
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    }, false);
    const startedAt = clock.now;
    clock.frameAt(startedAt);
    clock.frameAt(startedAt + 450);

    effects.cancelActivePresentation();
    await presentation;

    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: "complete",
      id: "rage.cascade",
      outcome: "cancelled",
    }));
    expect(telemetry).not.toContainEqual(expect.objectContaining({
      kind: "fail",
      id: "rage.cascade",
    }));
    expect(clock.pendingFrames).toBe(0);
    effects.destroy();
  });

  it("keeps the one-Rage collect in ACTIVATED through collect, crosses the 1ms tower barrier, and exposes pausable authored milestones", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = new ManualAnimationFrameClock();
    clock.install();
    await loadFeatureTextures();

    const order: string[] = [];
    const milestones: Readonly<RageCollectionEffectMilestone>[] = [];
    let activated = false;
    let hidden = false;
    const { effects, reels } = createEffects({
      onRageCollectionCommitted: () => order.push("tower"),
      onRageCollectionMilestone: (milestone) => milestones.push(milestone),
    });
    const begin = vi.fn(() => {
      activated = true;
      order.push("symbol+trail-start");
      return true;
    });
    const restore = vi.fn(() => {
      if (!activated) return false;
      activated = false;
      order.push("symbol-layer-restored");
      return true;
    });
    const complete = vi.fn(() => {
      if (hidden) return false;
      hidden = true;
      order.push("source-hidden");
      return true;
    });
    const symbolPause = vi.fn();
    Object.assign(reels, {
      getCellCenter: vi.fn(() => new Point(640, 306)),
      beginSurgeCollection: begin,
      restoreSurgeCollectionLayer: restore,
      completeSurgeCollection: complete,
      areSurgeCollectionsActivated: vi.fn(() => activated),
      setSymbolPlaybackPaused: symbolPause,
    });

    let featureTurnSettled = false;
    const presentation = effects.presentAfterReels({
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    }, false).then(() => { featureTurnSettled = true; });
    await flushAsync();

    expect(begin).toHaveBeenCalledOnce();
    expect(activated).toBe(true);
    expect(order).toEqual(["symbol+trail-start"]);
    expect(featureTurnSettled).toBe(false);
    expect(milestones.map(({ phase }) => phase)).toEqual(["started"]);
    expect(milestones[0]).toMatchObject({
      elapsedMs: 0,
      authoredAtMs: 0,
      activated: true,
      hidden: false,
      towerReactionStarted: false,
    });
    expect(Object.isFrozen(milestones[0])).toBe(true);
    expect(Object.isFrozen(milestones[0]?.cells)).toBe(true);
    expect(Object.isFrozen(milestones[0]?.cells[0])).toBe(true);

    await vi.advanceTimersByTimeAsync(0.999);
    expect(order).toEqual(["symbol+trail-start"]);
    expect(featureTurnSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(0.001);
    await presentation;
    expect(featureTurnSettled).toBe(true);
    expect(order).toEqual(["symbol+trail-start", "tower"]);

    const trail = newestSpine();
    const startedAt = clock.now;
    clock.frameAt(startedAt);
    clock.frameAt(startedAt + RAGE_COLLECT_ABSORBING_MS - 0.001);
    expect(milestones.map(({ phase }) => phase)).toEqual(["started"]);
    clock.frameAt(startedAt + RAGE_COLLECT_ABSORBING_MS);
    expect(milestones.map(({ phase }) => phase)).toEqual(["started", "absorbing"]);
    expect(milestones.at(-1)).toMatchObject({
      authoredAtMs: RAGE_COLLECT_ABSORBING_MS,
      activated: true,
      hidden: false,
      towerReactionStarted: true,
    });

    effects.setRageCollectionPlaybackPaused(true);
    expect(symbolPause).toHaveBeenLastCalledWith([{ reel: 1, row: 0 }], true);
    expect(trail.state.timeScale).toBe(0);
    clock.frameAt(startedAt + 5_000);
    expect(restore).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    effects.setRageCollectionPlaybackPaused(false);
    expect(symbolPause).toHaveBeenLastCalledWith([{ reel: 1, row: 0 }], false);
    expect(trail.state.timeScale).toBe(1);
    clock.frameAt(startedAt + 5_000 + RAGE_COLLECT_SYMBOL_MS - RAGE_COLLECT_ABSORBING_MS);
    expect(restore).toHaveBeenCalledOnce();
    expect(activated).toBe(false);
    expect(complete).not.toHaveBeenCalled();

    expect(RAGE_COLLECT_HIDE_START_MS).toBe(850);
    const hideAt = 5_000 + RAGE_COLLECT_FULLY_HIDDEN_MS
      - RAGE_COLLECT_ABSORBING_MS;
    clock.frameAt(startedAt + hideAt - 0.001);
    expect(complete).not.toHaveBeenCalled();
    clock.frameAt(startedAt + hideAt);
    expect(complete).toHaveBeenCalledOnce();
    expect(hidden).toBe(true);
    expect(milestones.map(({ phase }) => phase)).toEqual([
      "started", "absorbing", "source-hidden",
    ]);
    expect(milestones.at(-1)).toMatchObject({
      authoredAtMs: RAGE_COLLECT_FULLY_HIDDEN_MS,
      activated: false,
      hidden: true,
      towerReactionStarted: true,
    });

    const completeAt = 5_000 + RAGE_COLLECT_TRAIL_MS - RAGE_COLLECT_ABSORBING_MS;
    clock.frameAt(startedAt + completeAt);
    await flushAsync();
    expect(restore).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(milestones.map(({ phase }) => phase)).toEqual([
      "started", "absorbing", "source-hidden", "complete",
    ]);
    expect(milestones.at(-1)).toMatchObject({
      elapsedMs: RAGE_COLLECT_TRAIL_MS,
      authoredAtMs: RAGE_COLLECT_TRAIL_MS,
      activated: false,
      hidden: true,
      towerReactionStarted: true,
    });
    expect(order).toEqual([
      "symbol+trail-start", "tower", "symbol-layer-restored", "source-hidden",
    ]);
    expect(effects.view.children).toHaveLength(0);
    effects.destroy();
  });

  it("launches two settled Rage sources as one synchronous collect batch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = new ManualAnimationFrameClock();
    clock.install();
    await loadFeatureTextures();

    const cells = [{ reel: 0, row: 1 }, { reel: 1, row: 1 }] as const;
    const towerCommit = vi.fn();
    const begin = vi.fn(() => true);
    const restore = vi.fn(() => true);
    const complete = vi.fn();
    const { effects, reels } = createEffects({
      onRageCollectionCommitted: towerCommit,
    });
    Object.assign(reels, {
      getCellCenter: vi.fn(({ reel }: { reel: number }) => (
        reel === 0 ? new Point(470, 390) : new Point(640, 390)
      )),
      beginSurgeCollection: begin,
      restoreSurgeCollectionLayer: restore,
      completeSurgeCollection: complete,
      areSurgeCollectionsActivated: vi.fn(() => true),
      setSymbolPlaybackPaused: vi.fn(),
    });

    const firstSpine = spineRecorder.instances.length;
    const presentation = effects.presentAfterReels({
      type: "surge.collected",
      count: 2,
      cells,
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 2,
    }, false);
    await flushAsync();

    expect(begin.mock.calls).toEqual(cells.map((cell) => [cell]));
    const trails = spineRecorder.instances.slice(firstSpine);
    expect(trails).toHaveLength(2);
    for (const trail of trails) {
      expect(animations(trail, "collect")).toHaveLength(1);
      expect(animations(trail, "hidden")).toHaveLength(1);
    }
    expect(towerCommit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await presentation;
    expect(towerCommit).toHaveBeenCalledOnce();

    const startedAt = clock.now;
    clock.frameAt(startedAt);
    clock.frameAt(startedAt + RAGE_COLLECT_SYMBOL_MS);
    expect(restore.mock.calls).toEqual(cells.map((cell) => [cell]));

    clock.frameAt(startedAt + RAGE_COLLECT_FULLY_HIDDEN_MS);
    expect(complete.mock.calls).toEqual(cells.map((cell) => [cell]));

    clock.frameAt(startedAt + RAGE_COLLECT_TRAIL_MS);
    await flushAsync();
    expect(begin).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(towerCommit).toHaveBeenCalledTimes(1);
    expect(effects.view.children).toHaveLength(0);
    effects.destroy();
  });

  it("replays King and Kong intros through the real renderer gate without carrying state", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onFreeSpinsReady: () => milestones.push("input-ready"),
      onFreeSpinsContinue: () => milestones.push("continue"),
    });

    const kingEvent: FeatureEvent = {
      type: "free_spins.started",
      mode: "OVERDRIVE",
      awarded: 12,
    };
    const king = effects.presentAfterReels(kingEvent, false);
    await flushAsync();
    const kingSpine = newestSpine();

    expect(textValues(effects.view)).toEqual(expect.arrayContaining([
      "8 FREE SPINS awarded!",
      "All VAULT BONUS are unlocked in KING SPIN!",
      "PRESS SPIN TO BEGIN",
    ]));
    expect(animations(kingSpine, "show")).toHaveLength(1);
    expect(animations(kingSpine, "rags_loop")).toEqual([
      { method: "set", track: 1, animation: "rags_loop", loop: true },
    ]);
    expect(effects.requestFreeSpinContinue()).toBe(false);

    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show);
    expect(milestones).toEqual(["input-ready"]);
    expect(effects.requestFreeSpinContinue()).toBe(true);
    expect(effects.requestFreeSpinContinue()).toBe(false);
    expect(milestones).toEqual(["input-ready", "continue"]);
    await flushAsync();
    expect(animations(kingSpine, "hide")).toHaveLength(1);
    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.hide);
    await king;

    expect(effects.view.children).toHaveLength(0);
    expect(reels.alpha).toBe(1);
    expect(effects.requestFreeSpinContinue()).toBe(false);

    milestones.length = 0;
    const kongEvent: FeatureEvent = {
      type: "free_spins.started",
      mode: "EXPANSION",
      awarded: 11,
    };
    const kong = effects.presentAfterReels(kongEvent, false);
    await flushAsync();
    const kongSpine = newestSpine();
    expect(textValues(effects.view)).toEqual(expect.arrayContaining([
      "8 FREE SPINS awarded!",
      "Reels can expand in KONG QUEST!",
      "PRESS SPIN TO BEGIN",
    ]));
    expect(animations(kongSpine, "rags_loop")).toEqual([
      { method: "set", track: 1, animation: "rags_loop", loop: true },
    ]);
    expect(animations(kongSpine, "Fire_loop")).toEqual([
      { method: "set", track: 2, animation: "Fire_loop", loop: true },
    ]);
    expect(animations(kongSpine, "Fire_loop_2")).toEqual([
      { method: "set", track: 3, animation: "Fire_loop_2", loop: true },
    ]);
    expect(animations(kongSpine, "fire_glow_Loop")).toEqual([
      { method: "set", track: 4, animation: "fire_glow_Loop", loop: true },
    ]);

    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show);
    expect(milestones).toEqual(["input-ready"]);
    expect(effects.requestFreeSpinContinue()).toBe(true);
    await flushAsync();
    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.hide);
    await kong;

    expect(effects.view.children).toHaveLength(0);
    expect(reels.alpha).toBe(1);
    effects.destroy();
  });

  it("settles an infinite intro gate on teardown without reporting a Continue", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const { effects } = createEffects({
      onFreeSpinsReady: () => milestones.push("input-ready"),
      onFreeSpinsContinue: () => milestones.push("continue"),
    });
    const presentation = effects.presentAfterReels({
      type: "free_spins.started",
      mode: "OVERDRIVE",
      awarded: 8,
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show);
    expect(milestones).toEqual(["input-ready"]);

    effects.destroy();
    await presentation;

    expect(effects.requestFreeSpinContinue()).toBe(false);
    expect(milestones).toEqual(["input-ready"]);
  });

  it("cancels a live summary gate without firing a stale hide-start callback", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const { effects } = createEffects({
      onFreeSpinSummaryReady: () => milestones.push("ready"),
      onFreeSpinSummaryClose: (reason) => milestones.push(reason),
      onFreeSpinSummaryHideStart: () => milestones.push("hide"),
    });
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "12345",
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.show);
    expect(milestones).toEqual(["ready"]);

    effects.destroy();
    await summary;

    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);
    expect(milestones).toEqual(["ready", "cancelled"]);
  });

  it("cancels a live Free summary as a reusable round boundary", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onFreeSpinSummaryReady: () => milestones.push("ready"),
      onFreeSpinSummaryClose: (reason) => milestones.push(reason),
      onFreeSpinSummaryHideStart: () => milestones.push("hide"),
    });
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "12345",
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.show);
    expect(milestones).toEqual(["ready"]);
    expect(effects.view.children).toHaveLength(1);
    expect(reels.alpha).toBeCloseTo(0.2, 6);

    effects.cancelActivePresentation();
    await summary;

    expect(clock.pendingFrames).toBe(0);
    expect(effects.view.children).toHaveLength(0);
    expect(reels.alpha).toBe(1);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);
    expect(milestones).toEqual(["ready", "cancelled"]);

    // 取消回合并不等于销毁渲染器：同一个 effects 实例必须仍可供下一个权威
    // Feature 事件使用。
    const nextIntro = effects.presentAfterReels({
      type: "free_spins.started",
      mode: "EXPANSION",
      awarded: 8,
    }, false);
    await flushAsync();
    expect(effects.view.children).toHaveLength(1);
    effects.cancelActivePresentation();
    await nextIntro;
    expect(effects.view.children).toHaveLength(0);
    expect(reels.alpha).toBe(1);
    effects.destroy();
  });

  it("holds a visible summary input gate before starting the authored three-second hold", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const milestones: string[] = [];
    const { effects } = createEffects({
      onFreeSpinSummaryReady: () => milestones.push("ready"),
      onFreeSpinSummaryInputReadyCheckpoint: () => checkpoint,
      onFreeSpinSummaryClose: (reason) => milestones.push(reason),
      onFreeSpinSummaryHideStart: () => milestones.push("hide"),
    });
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "350",
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.show);

    expect(milestones).toEqual(["ready"]);
    expect(clock.pendingFrames).toBe(0);
    releaseCheckpoint();
    await flushAsync();
    expect(clock.pendingFrames).toBe(1);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(true);
    await flushAsync();
    expect(milestones).toEqual(["ready", "continue", "hide"]);

    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.hide);
    await summary;
    effects.destroy();
  });

  it("takes the natural summary timeout only after a held checkpoint is released", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const milestones: string[] = [];
    const { effects } = createEffects({
      onFreeSpinSummaryReady: () => milestones.push("ready"),
      onFreeSpinSummaryInputReadyCheckpoint: () => checkpoint,
      onFreeSpinSummaryClose: (reason) => milestones.push(reason),
      onFreeSpinSummaryHideStart: () => milestones.push("hide"),
    });
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "350",
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.show);
    expect(clock.pendingFrames).toBe(0);
    expect(milestones).toEqual(["ready"]);

    releaseCheckpoint();
    await flushAsync();
    expect(clock.pendingFrames).toBe(1);
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.continueHold);
    expect(milestones).toEqual(["ready", "timeout", "hide"]);
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.hide);
    await summary;
    effects.destroy();
  });

  it("fails open from a rejected summary input-ready checkpoint into the real timeout", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const { effects } = createEffects({
      onFreeSpinSummaryReady: () => milestones.push("ready"),
      onFreeSpinSummaryInputReadyCheckpoint: () => Promise.reject(
        new Error("fixture checkpoint failed"),
      ),
      onFreeSpinSummaryClose: (reason) => milestones.push(reason),
      onFreeSpinSummaryHideStart: () => milestones.push("hide"),
    });
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "350",
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.show);
    expect(milestones).toEqual(["ready"]);
    expect(clock.pendingFrames).toBe(1);

    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.continueHold);
    expect(milestones).toEqual(["ready", "timeout", "hide"]);
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.hide);
    await summary;
    effects.destroy();
  });

  it("cancels a checkpoint-held summary once on destroy and never starts hold or hide", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const milestones: string[] = [];
    const { effects } = createEffects({
      onFreeSpinSummaryReady: () => milestones.push("ready"),
      onFreeSpinSummaryInputReadyCheckpoint: () => checkpoint,
      onFreeSpinSummaryClose: (reason) => milestones.push(reason),
      onFreeSpinSummaryHideStart: () => milestones.push("hide"),
    });
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "350",
    }, false);
    await flushAsync();
    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.show);
    expect(clock.pendingFrames).toBe(0);

    effects.destroy();
    expect(milestones).toEqual(["ready", "cancelled"]);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);
    expect(clock.pendingFrames).toBe(0);
    await summary;
    releaseCheckpoint();
    expect(milestones).toEqual(["ready", "cancelled"]);
  });

  it("opens the real summary gate after show and starts teardown once on Continue", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onFreeSpinsReady: () => milestones.push("input-ready"),
      onFreeSpinsContinue: () => milestones.push("continue"),
      onFreeSpinSummaryReady: () => milestones.push("summary-ready"),
      onFreeSpinSummaryClose: (reason) => milestones.push(`summary-${reason}`),
      onFreeSpinSummaryHideStart: () => milestones.push("summary-hide"),
    });
    let settled = false;
    const summary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "12345",
    }, false).then(() => { settled = true; });
    await flushAsync();
    const summarySpine = newestSpine();
    expect(textValues(effects.view)).toEqual(expect.arrayContaining([
      "CONGRATULATIONS!",
      "123.45",
      "Total Win",
    ]));
    expect(animations(summarySpine, "show")).toHaveLength(1);
    expect(effects.requestFreeSpinContinue()).toBe(false);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);

    const start = clock.now;
    clock.frameAt(start);
    await flushAsync();
    clock.frameAt(start + FREE_SPIN_SUMMARY_TIMELINE_MS.show + 0.001);
    await flushAsync();
    expect(reels.alpha).toBeCloseTo(0.2, 6);
    expect(animations(summarySpine, "hide")).toHaveLength(0);
    expect(milestones).toEqual(["summary-ready"]);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(true);
    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);
    await flushAsync();
    expect(animations(summarySpine, "hide")).toHaveLength(1);
    expect(milestones).toEqual(["summary-ready", "summary-continue", "summary-hide"]);
    expect(settled).toBe(false);

    await finishCurrentAnimation(clock, FREE_SPIN_SUMMARY_TIMELINE_MS.hide);
    await summary;
    expect(effects.view.children).toHaveLength(0);
    expect(reels.alpha).toBe(1);

    const noWinSummary = effects.presentAfterReels({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "0",
    }, true);
    await flushAsync();
    expect(textValues(effects.view)).toContain(FREE_SPIN_NO_WIN_COPY);
    expect(textValues(effects.view)).not.toContain("0.00");
    const reducedScale = featureEffectDuration("summary", true)
      / FREE_SPIN_SUMMARY_TIMELINE_MS.total;
    await finishCurrentAnimation(
      clock,
      FREE_SPIN_SUMMARY_TIMELINE_MS.show * reducedScale,
    );
    expect(milestones.at(-1)).toBe("summary-ready");
    await finishCurrentAnimation(
      clock,
      FREE_SPIN_SUMMARY_TIMELINE_MS.continueHold * reducedScale,
    );
    expect(effects.requestFreeSpinSummaryContinue()).toBe(false);
    await finishCurrentAnimation(
      clock,
      FREE_SPIN_SUMMARY_TIMELINE_MS.hide * reducedScale,
    );
    await noWinSummary;
    expect(effects.view.children).toHaveLength(0);

    const nextIntro = effects.presentAfterReels({
      type: "free_spins.started",
      mode: "EXPANSION",
      awarded: 8,
    }, false);
    await flushAsync();
    expect(effects.view.children).toHaveLength(1);
    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.show);
    expect(milestones).toEqual([
      "summary-ready", "summary-continue", "summary-hide",
      "summary-ready", "summary-timeout", "summary-hide",
      "input-ready",
    ]);
    expect(effects.requestFreeSpinContinue()).toBe(true);
    await flushAsync();
    await finishCurrentAnimation(clock, PRIMAL_FEATURE_ANIMATION_MS.freeSpinIntro.hide);
    await nextIntro;
    expect(effects.view.children).toHaveLength(0);
    effects.destroy();
  });

  it("runs the real natural Wheel through two gestures, one offset sample, and the H+1000 outro", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => 0.125);
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onWheelPopupReady: () => milestones.push("popup-ready"),
      onWheelPopupClose: (reason) => milestones.push(`popup-${reason}`),
      onWheelReady: () => milestones.push("wheel-ready"),
      onWheelSpinStart: () => milestones.push("spin-start"),
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelSpinAbort: () => milestones.push("spin-abort"),
      onWheelSummaryReady: () => milestones.push("summary-ready"),
      onWheelSummaryClose: (reason) => milestones.push(`summary-${reason}`),
      onWheelBonusLabelReady: () => milestones.push("bonus-label"),
    }, offsetSource);
    let presentationSettled = false;
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false)
      .then(() => { presentationSettled = true; });
    await flushAsync();

    expect(milestones).toEqual(["popup-ready"]);
    expect(offsetSource).not.toHaveBeenCalled();
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    // 弹窗手势不能在同一轮处理中继续穿透到 Ready 门控。
    expect(effects.requestWheelInteraction()).toBeNull();
    expect(offsetSource).not.toHaveBeenCalled();
    await flushAsync();

    expect(milestones).toEqual([
      "popup-ready", "popup-continue", "wheel-ready",
    ]);
    // 无界的 Ready RAF 可以任意延迟运行，且不消耗 RNG。
    clock.frameAt(clock.now);
    await flushAsync();
    clock.frameAt(clock.now + 10_000);
    await flushAsync();
    expect(offsetSource).not.toHaveBeenCalled();
    expect(milestones).not.toContain("spin-start");

    expect(effects.requestWheelInteraction()).toBe("spin-started");
    expect(milestones.at(-1)).toBe("spin-start");
    await flushAsync();
    expect(offsetSource).toHaveBeenCalledTimes(1);

    const spinStartedAt = clock.now;
    clock.frameAt(spinStartedAt);
    await flushAsync();
    clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.landing - 0.001);
    await flushAsync();
    expect(milestones).not.toContain("spin-finish");
    clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.landing + 0.001);
    await flushAsync();
    expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);

    clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.summaryShowAt + 0.001);
    await flushAsync();
    expect(milestones).toContain("summary-ready");
    expect(effects.requestWheelSummaryContinue()).toBe(true);
    expect(effects.requestWheelSummaryContinue()).toBe(false);
    await flushAsync();

    expect(reels.alpha).toBe(0);
    expect(milestones).not.toContain("bonus-label");
    expect(presentationSettled).toBe(false);
    const outroStartedAt = clock.now;
    clock.frameAt(outroStartedAt);
    await flushAsync();
    clock.frameAt(outroStartedAt + PRIMAL_WHEEL_TIMELINE_MS.wheelHide + 0.001);
    await flushAsync();

    // Wheel 隐藏是流程屏障。Layer B 从此处开始，而转轴淡出和场景仍占有
    // 剩余半秒。
    expect(milestones.filter((value) => value === "bonus-label")).toHaveLength(1);
    expect(presentationSettled).toBe(true);
    expect(reels.alpha).toBeCloseTo(0.5, 3);
    expect(effects.view.children).toHaveLength(1);
    expect(offsetSource).toHaveBeenCalledTimes(1);

    clock.frameAt(outroStartedAt + PRIMAL_WHEEL_TIMELINE_MS.reelFade + 0.001);
    await flushAsync();
    await presentation;
    expect(reels.alpha).toBe(1);
    expect(effects.view.children).toHaveLength(0);
    expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
    expect(milestones).not.toContain("spin-abort");
    effects.destroy();
  });

  it("cancels the unbounded Wheel Ready gate without a late spin or scene tail", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => 0.125);
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onWheelPopupReady: () => milestones.push("popup-ready"),
      onWheelPopupClose: (reason) => milestones.push(`popup-${reason}`),
      onWheelReady: () => milestones.push("wheel-ready"),
      onWheelSpinStart: () => milestones.push("spin-start"),
      onWheelSpinAbort: () => milestones.push("spin-abort"),
    }, offsetSource);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(milestones).toEqual([
      "popup-ready", "popup-continue", "wheel-ready",
    ]);
    expect(clock.pendingFrames).toBe(1);
    expect(effects.view.children).toHaveLength(1);

    effects.cancelActivePresentation();
    await flushAsync();
    await presentation;

    expect(clock.pendingFrames).toBe(0);
    expect(effects.view.children).toHaveLength(0);
    expect(reels.alpha).toBe(1);
    expect(effects.requestWheelInteraction()).toBeNull();
    expect(offsetSource).not.toHaveBeenCalled();
    expect(milestones).not.toContain("spin-start");
    expect(milestones).not.toContain("spin-abort");
    effects.destroy();
  });

  it("keeps the raw Wheel hyperspin Spine out of the Wheel canvas scene", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const firstSpine = spineRecorder.instances.length;
    const { effects } = createEffects({}, () => 0);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();

    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(spineRecorder.instances.slice(firstSpine).some((candidate) => (
      candidate.spineKey === "wheelHyperspin"
    ))).toBe(false);

    expect(effects.requestWheelInteraction()).toBe("spin-started");
    await flushAsync();
    effects.destroy();
    await flushAsync();
    await presentation;
  });

  it("holds Wheel continuation at S0 until the post-chest-install checkpoint releases", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => 0.125);
    const calls: string[] = [];
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const { effects } = createEffects({
      onWheelSpinStart: () => calls.push("spin-start"),
      onWheelSpinStartCheckpoint: () => {
        calls.push("checkpoint");
        return checkpoint;
      },
      onWheelSpinFinish: () => calls.push("spin-finish"),
      onWheelSummaryReady: () => calls.push("summary-ready"),
    }, offsetSource);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();

    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("spin-started");
    expect(calls).toEqual(["spin-start", "checkpoint"]);
    expect(offsetSource).not.toHaveBeenCalled();

    // 先前存在的 Ready RAF 可以完成，但在夹具持有屏障期间，它不得再渲染一个
    // Ready 样本，也不得进入 BEGIN_SPIN。
    clock.frameAt(clock.now + 5_000);
    await flushAsync();
    expect(clock.pendingFrames).toBe(0);
    expect(offsetSource).not.toHaveBeenCalled();
    expect(calls).toEqual(["spin-start", "checkpoint"]);

    releaseCheckpoint();
    await flushAsync();
    expect(offsetSource).toHaveBeenCalledOnce();
    expect(calls).not.toContain("spin-finish");
    expect(calls).not.toContain("summary-ready");

    effects.destroy();
    await presentation;
  });

  it("fails open rejected Wheel checkpoints without losing popup or landing overshoot", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const popupCheckpoint = vi.fn(() => Promise.reject(new Error("popup observer failed")));
    const inputCheckpoint = vi.fn(() => Promise.reject(new Error("input observer failed")));
    const startCheckpoint = vi.fn(() => Promise.reject(new Error("start observer failed")));
    const landingCheckpoint = vi.fn(() => Promise.reject(new Error("landing observer failed")));
    const { effects } = createEffects({
      onWheelPopupInputReadyCheckpoint: popupCheckpoint,
      onWheelInputReadyCheckpoint: inputCheckpoint,
      onWheelSpinStartCheckpoint: startCheckpoint,
      onWheelLandingCheckpoint: landingCheckpoint,
      onWheelReady: () => milestones.push("wheel-ready"),
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelSummaryReady: () => milestones.push("summary-ready"),
    }, () => 0);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();

    const popupStartedAt = clock.now;
    clock.frameAt(popupStartedAt);
    await flushAsync();
    clock.frameAt(popupStartedAt + 1_000.001);
    await flushAsync();
    expect(popupCheckpoint).toHaveBeenCalledOnce();
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(inputCheckpoint).toHaveBeenCalledOnce();
    expect(milestones).toContain("wheel-ready");

    expect(effects.requestWheelInteraction()).toBe("spin-started");
    await flushAsync();
    expect(startCheckpoint).toHaveBeenCalledOnce();
    const spinStartedAt = clock.now;
    clock.frameAt(spinStartedAt);
    await flushAsync();
    clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.summaryShowAt + 0.001);
    await flushAsync();
    expect(landingCheckpoint).toHaveBeenCalledOnce();
    expect(milestones).toEqual(expect.arrayContaining(["spin-finish", "summary-ready"]));

    effects.destroy();
    await presentation;
  });

  it("runs the complete reduced-motion Wheel through Popup, Ready, landing, summary, and outro", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => 0.149_999);
    const milestones: string[] = [];
    const firstSpine = spineRecorder.instances.length;
    const { effects, reels } = createEffects({
      onWheelPopupReady: () => milestones.push("popup-ready"),
      onWheelPopupClose: (reason) => milestones.push(`popup-${reason}`),
      onWheelReady: () => milestones.push("wheel-ready"),
      onWheelSpinStart: () => milestones.push("spin-start"),
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelSpinAbort: () => milestones.push("spin-abort"),
      onWheelSummaryReady: () => milestones.push("summary-ready"),
      onWheelSummaryClose: (reason) => milestones.push(`summary-${reason}`),
      onWheelBonusLabelReady: () => milestones.push("bonus-label"),
    }, offsetSource);
    let settled = false;
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, true)
      .then(() => { settled = true; });
    await flushAsync();
    const pointerTarget = wheelScenePointerTarget(effects.view);

    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("spin-started");
    await flushAsync();
    // 无障碍精简只移除墙上时钟等待和装饰性偏移 RNG；流程仍会完整经过生产
    // 生命周期和权威落定阶段。
    expect(offsetSource).not.toHaveBeenCalled();

    const timelineScale = featureEffectDuration("wheel", true)
      / (2_500 + PRIMAL_WHEEL_TIMELINE_MS.total);
    const spinStartedAt = clock.now;
    clock.frameAt(spinStartedAt);
    await flushAsync();
    clock.frameAt(
      spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.landing * timelineScale + 0.001,
    );
    await flushAsync();
    expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
    expect(animations(wheelSpineSince(firstSpine), "highlights/highlight6")).toHaveLength(1);

    clock.frameAt(
      spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.summaryShowAt * timelineScale + 0.002,
    );
    await flushAsync();
    expect(milestones.at(-1)).toBe("summary-ready");
    expect(effects.requestWheelSummaryContinue()).toBe(true);
    await flushAsync();

    const outroStartedAt = clock.now;
    clock.frameAt(outroStartedAt);
    await flushAsync();
    clock.frameAt(
      outroStartedAt + PRIMAL_WHEEL_TIMELINE_MS.wheelHide * timelineScale + 0.001,
    );
    await flushAsync();
    expect(settled).toBe(true);
    expect(milestones.filter((value) => value === "bonus-label")).toHaveLength(1);
    expect(reels.alpha).toBeCloseTo(0.5, 2);
    expect(effects.view.children).toHaveLength(1);

    clock.frameAt(
      outroStartedAt + PRIMAL_WHEEL_TIMELINE_MS.reelFade * timelineScale + 0.002,
    );
    await flushAsync();
    await presentation;
    expect(milestones).toEqual([
      "popup-ready",
      "popup-continue",
      "wheel-ready",
      "spin-start",
      "spin-finish",
      "summary-ready",
      "summary-continue",
      "bonus-label",
    ]);
    expectDestroyedWheelCleanup({
      effects,
      reels,
      clock,
      pointerTarget,
      spines: spineRecorder.instances.slice(firstSpine),
    });
  });

  it("resynchronizes authored Wheel geometry and layout during spin, landing, summary, and outro", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const milestones: string[] = [];
    const firstSpine = spineRecorder.instances.length;
    const { effects, reels } = createEffects({
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelSummaryReady: () => milestones.push("summary-ready"),
      onWheelBonusLabelReady: () => milestones.push("bonus-label"),
    }, () => 0);
    let settled = false;
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false)
      .then(() => { settled = true; });
    await flushAsync();
    const pointerTarget = wheelScenePointerTarget(effects.view);
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    const wheelSpine = wheelSpineSince(firstSpine);
    const summarySpine = spineRecorder.instances.slice(firstSpine).at(-1);
    if (!summarySpine) throw new Error("Expected an authored Wheel summary Spine view");
    const logicalGeometry = {
      x: wheelSpine.position.x,
      y: wheelSpine.position.y,
      scaleX: wheelSpine.scale.x,
      scaleY: wheelSpine.scale.y,
    };
    expect(effects.requestWheelInteraction()).toBe("spin-started");
    await flushAsync();

    const spinStartedAt = clock.now;
    clock.frameAt(spinStartedAt);
    await flushAsync();
    effects.setResponsiveLayoutTrack("layout/vertical");
    clock.frameAt(spinStartedAt + 2_600);
    await flushAsync();
    expect(animations(wheelSpine, "layout/vertical")).toHaveLength(1);
    expect(reels.alpha).toBe(0);

    effects.setResponsiveLayoutTrack("layout/horizontal");
    clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.landing + 0.001);
    await flushAsync();
    expect(milestones).toEqual(["spin-finish"]);
    expect(animations(wheelSpine, "layout/horizontal")).toHaveLength(2);
    expect(reels.alpha).toBe(0);

    effects.setResponsiveLayoutTrack("layout/vertical");
    clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.summaryShowAt + 0.001);
    await flushAsync();
    expect(milestones).toEqual(["spin-finish", "summary-ready"]);
    expect(animations(wheelSpine, "layout/vertical")).toHaveLength(2);
    expect(animations(summarySpine, "layout/vertical")).toHaveLength(2);
    expect(reels.alpha).toBe(0);
    expect(effects.requestWheelSummaryContinue()).toBe(true);
    await flushAsync();

    const outroStartedAt = clock.now;
    effects.setResponsiveLayoutTrack("layout/horizontal");
    clock.frameAt(outroStartedAt);
    await flushAsync();
    expect(animations(wheelSpine, "layout/horizontal")).toHaveLength(3);
    expect(animations(summarySpine, "layout/horizontal")).toHaveLength(3);
    expect({
      x: wheelSpine.position.x,
      y: wheelSpine.position.y,
      scaleX: wheelSpine.scale.x,
      scaleY: wheelSpine.scale.y,
    }).toEqual(logicalGeometry);
    expect(clock.pendingFrames).toBe(3);

    clock.frameAt(outroStartedAt + PRIMAL_WHEEL_TIMELINE_MS.wheelHide + 0.001);
    await flushAsync();
    expect(settled).toBe(true);
    expect(milestones).toEqual(["spin-finish", "summary-ready", "bonus-label"]);
    expect(reels.alpha).toBeCloseTo(0.5, 3);
    expect(clock.pendingFrames).toBe(2);
    expect(effects.view.children).toHaveLength(1);

    clock.frameAt(outroStartedAt + PRIMAL_WHEEL_TIMELINE_MS.reelFade + 0.001);
    await flushAsync();
    await presentation;
    expectDestroyedWheelCleanup({
      effects,
      reels,
      clock,
      pointerTarget,
      spines: spineRecorder.instances.slice(firstSpine),
    });
  });

  it("quick-stops the real Wheel into exactly one landing without skipping its reserve", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => -0.15);
    const milestones: string[] = [];
    const { effects } = createEffects({
      onWheelSpinStart: () => milestones.push("spin-start"),
      onWheelQuickStop: () => milestones.push("quick-stop"),
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelSpinAbort: () => milestones.push("spin-abort"),
      onWheelSummaryReady: () => milestones.push("summary-ready"),
      onWheelBonusLabelReady: () => milestones.push("bonus-label"),
    }, offsetSource);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("spin-started");
    await flushAsync();
    expect(offsetSource).toHaveBeenCalledTimes(1);
    expect(effects.requestWheelInteraction()).toBe("quick-stop");
    expect(effects.requestWheelInteraction()).toBeNull();

    const quickStopStartedAt = clock.now;
    clock.frameAt(quickStopStartedAt);
    await flushAsync();
    clock.frameAt(quickStopStartedAt + PRIMAL_WHEEL_TIMELINE_MS.selectionReserve - 0.001);
    await flushAsync();
    expect(milestones).toEqual(["spin-start", "quick-stop"]);
    clock.frameAt(quickStopStartedAt + PRIMAL_WHEEL_TIMELINE_MS.selectionReserve + 0.001);
    await flushAsync();
    expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);

    const quickSummaryAt = PRIMAL_WHEEL_TIMELINE_MS.selectionReserve
      + PRIMAL_WHEEL_TIMELINE_MS.highlightHold
      + PRIMAL_WHEEL_TIMELINE_MS.postHighlightHold;
    clock.frameAt(quickStopStartedAt + quickSummaryAt + 0.001);
    await flushAsync();
    expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
    expect(milestones).toContain("summary-ready");

    effects.destroy();
    await presentation;
    expect(effects.view.children).toHaveLength(0);
    expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
    expect(milestones).not.toContain("spin-abort");
    expect(milestones).not.toContain("bonus-label");
  });

  it.each([4_400, 8_799])(
    "accepts a real Quick-stop at S=%ims and still lands exactly once after its full reserve",
    async (quickStopAt) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const milestones: string[] = [];
      const { effects } = createEffects({
        onWheelQuickStop: () => milestones.push("quick-stop"),
        onWheelSpinFinish: () => milestones.push("spin-finish"),
        onWheelSpinAbort: () => milestones.push("spin-abort"),
        onWheelSummaryReady: () => milestones.push("summary-ready"),
      }, () => 0.149_999);
      const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("popup-continued");
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("spin-started");
      await flushAsync();

      const spinStartedAt = clock.now;
      clock.frameAt(spinStartedAt);
      await flushAsync();
      clock.frameAt(spinStartedAt + quickStopAt);
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("quick-stop");
      clock.frameAt(clock.now);
      await flushAsync();
      clock.frameAt(spinStartedAt + quickStopAt
        + PRIMAL_WHEEL_TIMELINE_MS.selectionReserve - 0.001);
      await flushAsync();
      expect(milestones).toEqual(["quick-stop"]);
      clock.frameAt(spinStartedAt + quickStopAt
        + PRIMAL_WHEEL_TIMELINE_MS.selectionReserve + 0.001);
      await flushAsync();
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);

      const summaryAt = quickStopAt
        + PRIMAL_WHEEL_TIMELINE_MS.selectionReserve
        + PRIMAL_WHEEL_TIMELINE_MS.highlightHold
        + PRIMAL_WHEEL_TIMELINE_MS.postHighlightHold;
      clock.frameAt(spinStartedAt + summaryAt + 0.001);
      await flushAsync();
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
      expect(milestones).toContain("summary-ready");

      effects.destroy();
      await presentation;
      expect(milestones).not.toContain("spin-abort");
      expect(effects.view.children).toHaveLength(0);
    },
  );

  it.each([
    { popupElapsedMs: 1_250, closeReason: "continue" },
    { popupElapsedMs: 2_500, closeReason: "timeout" },
  ])(
    "keeps offset RNG untouched through the $popupElapsedMs ms Popup path",
    async ({ popupElapsedMs, closeReason }) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const offsetSource = vi.fn(() => 0);
      const milestones: string[] = [];
      const { effects, reels } = createEffects({
        onWheelPopupClose: (reason) => milestones.push(`popup-${reason}`),
        onWheelReady: () => milestones.push("wheel-ready"),
        onWheelSpinFinish: () => milestones.push("spin-finish"),
        onWheelSpinAbort: () => milestones.push("spin-abort"),
        onWheelBonusLabelReady: () => milestones.push("bonus-label"),
      }, offsetSource);
      const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
      await flushAsync();

      const popupStartedAt = clock.now;
      clock.frameAt(popupStartedAt);
      await flushAsync();
      clock.frameAt(popupStartedAt + popupElapsedMs + (closeReason === "timeout" ? 0.001 : 0));
      await flushAsync();
      if (closeReason === "continue") {
        expect(effects.requestWheelInteraction()).toBe("popup-continued");
        await flushAsync();
      }
      expect(milestones).toEqual([`popup-${closeReason}`, "wheel-ready"]);
      expect(offsetSource).not.toHaveBeenCalled();

      effects.destroy();
      await presentation;
      expect(offsetSource).not.toHaveBeenCalled();
      expect(milestones).not.toContain("spin-finish");
      expect(milestones).not.toContain("bonus-label");
      expect(milestones.filter((value) => value === "spin-abort")).toHaveLength(1);
      expect(reels.alpha).toBe(1);
      expect(effects.view.children).toHaveLength(0);
    },
  );

  it.each(WHEEL_AWARD_CASES)(
    "runs the authored $label slice through Fast Play landing and Layer A exactly once",
    async ({ event, highlight }) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const offsetSource = vi.fn(() => 0);
      const milestones: string[] = [];
      const firstSpine = spineRecorder.instances.length;
      const { effects, reels } = createEffects({
        onWheelSpinFinish: () => milestones.push("spin-finish"),
        onWheelSpinAbort: () => milestones.push("spin-abort"),
        onWheelSummaryReady: () => milestones.push("summary-ready"),
      }, offsetSource);
      effects.setWheelFastPlay(true);
      const presentation = effects.presentAfterReels(event, false);
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("popup-continued");
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("spin-started");
      await flushAsync();
      expect(offsetSource).toHaveBeenCalledTimes(1);

      const wheelSpine = spineRecorder.instances.slice(firstSpine).find((spine) => (
        animations(spine, "layout/horizontal").length > 0
        || animations(spine, "layout/vertical").length > 0
      ));
      expect(wheelSpine).toBeDefined();
      const spinStartedAt = clock.now;
      clock.frameAt(spinStartedAt);
      await flushAsync();
      clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.fastLanding + 0.001);
      await flushAsync();
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
      expect(animations(wheelSpine!, highlight)).toHaveLength(1);

      const summaryAt = PRIMAL_WHEEL_TIMELINE_MS.fastLanding
        + PRIMAL_WHEEL_TIMELINE_MS.highlightHold
        + PRIMAL_WHEEL_TIMELINE_MS.postHighlightHold;
      clock.frameAt(spinStartedAt + summaryAt + 0.001);
      await flushAsync();
      expect(milestones).toEqual(["spin-finish", "summary-ready"]);

      effects.destroy();
      await presentation;
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
      expect(milestones).not.toContain("spin-abort");
      expect(reels.alpha).toBe(1);
      expect(effects.view.children).toHaveLength(0);
    },
  );

  it("cancels the real Wheel during Popup without sampling or publishing an award", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => 0);
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onWheelPopupClose: (reason) => milestones.push(`popup-${reason}`),
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelBonusLabelReady: () => milestones.push("bonus-label"),
    }, offsetSource);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();

    effects.destroy();
    await presentation;
    expect(milestones).toEqual(["popup-cancelled"]);
    expect(offsetSource).not.toHaveBeenCalled();
    expect(reels.alpha).toBe(1);
    expect(effects.view.children).toHaveLength(0);
  });

  it.each([{ stage: "landing" }, { stage: "summary" }] as const)(
    "settles and fully cleans a real Wheel destroyed during $stage",
    async ({ stage }) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const milestones: string[] = [];
      const firstSpine = spineRecorder.instances.length;
      const { effects, reels } = createEffects({
        onWheelSpinStart: () => milestones.push("spin-start"),
        onWheelSpinFinish: () => milestones.push("spin-finish"),
        onWheelSpinAbort: () => milestones.push("spin-abort"),
        onWheelSummaryReady: () => milestones.push("summary-ready"),
        onWheelSummaryClose: (reason) => milestones.push(`summary-${reason}`),
        onWheelBonusLabelReady: () => milestones.push("bonus-label"),
      }, () => 0);
      let settled = false;
      const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false)
        .then(() => { settled = true; });
      await flushAsync();
      const pointerTarget = wheelScenePointerTarget(effects.view);
      expect(effects.requestWheelInteraction()).toBe("popup-continued");
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("spin-started");
      await flushAsync();

      const spinStartedAt = clock.now;
      clock.frameAt(spinStartedAt);
      await flushAsync();
      clock.frameAt(
        spinStartedAt + (stage === "landing"
          ? PRIMAL_WHEEL_TIMELINE_MS.landing
          : PRIMAL_WHEEL_TIMELINE_MS.summaryShowAt) + 0.001,
      );
      await flushAsync();
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
      expect(effects.requestWheelInteraction()).toBeNull();
      if (stage === "summary") {
        expect(milestones.at(-1)).toBe("summary-ready");
      } else {
        expect(effects.requestWheelSummaryContinue()).toBe(false);
      }
      expect(clock.pendingFrames).toBeGreaterThan(0);

      effects.destroy();
      await presentation;
      await flushAsync();
      expect(settled).toBe(true);
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
      expect(milestones).not.toContain("spin-abort");
      expect(milestones).not.toContain("bonus-label");
      if (stage === "summary") expect(milestones).toContain("summary-cancelled");
      expectDestroyedWheelCleanup({
        effects,
        reels,
        clock,
        pointerTarget,
        spines: spineRecorder.instances.slice(firstSpine),
      });
    },
  );

  it.each([
    { label: "H+0", elapsedMs: 0 },
    { label: "H+499", elapsedMs: 499 },
    { label: "H+500", elapsedMs: 500.001 },
    { label: "H+667", elapsedMs: 667 },
    { label: "H+999", elapsedMs: 999 },
  ])(
    "releases every remaining Wheel owner when destroyed at $label",
    async ({ elapsedMs }) => {
      const clock = new ManualAnimationFrameClock();
      clock.install();
      const milestones: string[] = [];
      const firstSpine = spineRecorder.instances.length;
      const { effects, reels } = createEffects({
        onWheelSpinFinish: () => milestones.push("spin-finish"),
        onWheelSpinAbort: () => milestones.push("spin-abort"),
        onWheelSummaryReady: () => milestones.push("summary-ready"),
        onWheelSummaryClose: (reason) => milestones.push(`summary-${reason}`),
        onWheelBonusLabelReady: () => milestones.push("bonus-label"),
      }, () => 0);
      let settled = false;
      const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false)
        .then(() => { settled = true; });
      await flushAsync();
      const pointerTarget = wheelScenePointerTarget(effects.view);
      expect(effects.requestWheelInteraction()).toBe("popup-continued");
      await flushAsync();
      expect(effects.requestWheelInteraction()).toBe("spin-started");
      await flushAsync();

      const spinStartedAt = clock.now;
      clock.frameAt(spinStartedAt);
      await flushAsync();
      clock.frameAt(spinStartedAt + PRIMAL_WHEEL_TIMELINE_MS.summaryShowAt + 0.001);
      await flushAsync();
      expect(effects.requestWheelSummaryContinue()).toBe(true);
      await flushAsync();

      const outroStartedAt = clock.now;
      clock.frameAt(outroStartedAt);
      await flushAsync();
      if (elapsedMs > 0) {
        clock.frameAt(outroStartedAt + elapsedMs);
        await flushAsync();
      }
      expect(clock.pendingFrames).toBeGreaterThan(0);
      expect(settled).toBe(elapsedMs >= PRIMAL_WHEEL_TIMELINE_MS.wheelHide);
      expect(milestones.filter((value) => value === "bonus-label")).toHaveLength(
        elapsedMs >= PRIMAL_WHEEL_TIMELINE_MS.wheelHide ? 1 : 0,
      );

      effects.destroy();
      await presentation;
      await flushAsync();
      expect(settled).toBe(true);
      expect(milestones.filter((value) => value === "spin-finish")).toHaveLength(1);
      expect(milestones).toContain("summary-continue");
      expect(milestones).not.toContain("summary-cancelled");
      expect(milestones).not.toContain("spin-abort");
      expectDestroyedWheelCleanup({
        effects,
        reels,
        clock,
        pointerTarget,
        spines: spineRecorder.instances.slice(firstSpine),
      });
    },
  );

  it("aborts a destroyed real Wheel without a false landing or award and restores alpha", async () => {
    const clock = new ManualAnimationFrameClock();
    clock.install();
    const offsetSource = vi.fn(() => 0);
    const milestones: string[] = [];
    const { effects, reels } = createEffects({
      onWheelSpinStart: () => milestones.push("spin-start"),
      onWheelSpinFinish: () => milestones.push("spin-finish"),
      onWheelSpinAbort: () => milestones.push("spin-abort"),
      onWheelBonusLabelReady: () => milestones.push("bonus-label"),
    }, offsetSource);
    const presentation = effects.presentAfterReels(MINI_WHEEL_AWARD, false);
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("popup-continued");
    await flushAsync();
    expect(effects.requestWheelInteraction()).toBe("spin-started");
    await flushAsync();
    expect(offsetSource).toHaveBeenCalledTimes(1);

    clock.frameAt(clock.now);
    await flushAsync();
    effects.destroy();
    await presentation;

    expect(milestones).toEqual(["spin-start", "spin-abort"]);
    expect(reels.alpha).toBe(1);
    expect(effects.view.children).toHaveLength(0);
    expect(effects.requestWheelInteraction()).toBeNull();
  });
});
