import { afterEach, describe, expect, it, vi } from "vitest";
import type { GridCell } from "../src/app/state/types";
import { PRIMAL_REEL_ANTICIPATION_TRANSITION_MS } from "../src/reels/primalAnimationTiming";
import {
  PRIMAL_ANTICIPATION_COPY_CLEAR_LEAD_MS,
  PRIMAL_ANTICIPATION_RELEASE_DELAY_MS,
  PRIMAL_SURGE_ACTIVATION_OUTRO_MS,
  PRIMAL_WILD_REVEAL_OUTRO_MS,
  REEL_IMPACT_PROGRESS,
  StopSequencer,
  StopPresentationCancelledError,
  createAnticipationTriggerPlan,
  createPostStopActivationPlan,
  type ReelStopTarget,
} from "../src/reels/StopSequencer";

const grid: GridCell[][] = Array.from({ length: 3 }, () => [
  { symbol: "ORBIT" },
  { symbol: "PRISM" },
  { symbol: "PULSE" },
]);

afterEach(() => {
  vi.useRealTimers();
});

describe("StopSequencer fast-forward", () => {
  it("emits all-stopped at the third impact without waiting for bounce promises", async () => {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((reel: number) => new Promise<void>((resolve) => {
        order.push(`physical-start:${reel}`);
        releases[reel] = resolve;
      })),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      {
        onReelStopStart: ({ reel }) => order.push(`state-start:${reel}`),
        onAllReelsStopped: () => order.push("all-stopped"),
      },
    );

    const presentation = sequencer.present(grid);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([
      "state-start:0", "physical-start:0",
      "state-start:1", "physical-start:1",
      "state-start:2", "physical-start:2",
      "all-stopped",
    ]);

    releases[0]?.();
    releases[1]?.();
    await Promise.resolve();
    expect(order.filter((entry) => entry === "all-stopped")).toHaveLength(1);
    releases[2]?.();
    await presentation;
    expect(order.filter((entry) => entry === "all-stopped")).toHaveLength(1);
  });

  it("propagates core lifecycle hook failures and never reports all-stopped", async () => {
    const allStopped = vi.fn();
    const failure = new Error("invalid reel state transition");
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      cancelPresentation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      {
        onReelStopStart: () => { throw failure; },
        onAllReelsStopped: allStopped,
      },
    );

    await expect(sequencer.present(grid)).rejects.toBe(failure);
    expect(target.stopReel).not.toHaveBeenCalled();
    expect(allStopped).not.toHaveBeenCalled();
    expect(target.cancelPresentation).toHaveBeenCalledTimes(1);
  });

  it("plans the exclusive post-stop Wild/Rage branches without changing cells", () => {
    const threeSurgesAndWild: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "WILD", multiplier: 5 }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "SURGE" }],
    ];
    const before = structuredClone(threeSurgesAndWild);
    expect(createPostStopActivationPlan(threeSurgesAndWild)).toEqual({
      kind: "wild-reveal",
      cells: [{ reel: 0, row: 1 }],
      delayMs: PRIMAL_WILD_REVEAL_OUTRO_MS,
    });
    expect(threeSurgesAndWild).toEqual(before);

    const exactlyThreeSurges: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "WILD", multiplier: 1 }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "SURGE" }, { symbol: "PRISM" }, { symbol: "SURGE" }],
    ];
    expect(createPostStopActivationPlan(exactlyThreeSurges)).toEqual({
      kind: "surge-feature-activation",
      cells: [{ reel: 0, row: 0 }, { reel: 2, row: 0 }, { reel: 2, row: 2 }],
      delayMs: PRIMAL_SURGE_ACTIVATION_OUTRO_MS,
    });
    expect(createPostStopActivationPlan([
      exactlyThreeSurges[0]!,
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      exactlyThreeSurges[2]!,
    ])).toBeNull();
    expect(createPostStopActivationPlan(grid)).toBeNull();
  });

  it("holds completion for the exact 1000ms Wild reveal stop-outro", async () => {
    vi.useFakeTimers();
    const wildGrid: GridCell[][] = structuredClone(grid);
    wildGrid[1]![1] = { symbol: "WILD", multiplier: 2 };
    const starts = vi.fn();
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      playPostStopActivation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      { onPostStopActivation: starts },
    );

    let completed = false;
    const presentation = sequencer.present(wildGrid).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveBeenCalledWith({
      kind: "wild-reveal",
      cells: [{ reel: 1, row: 1 }],
      delayMs: 1_000,
      fastForward: false,
    });
    expect(target.playPostStopActivation).toHaveBeenCalledWith({
      kind: "wild-reveal",
      cells: [{ reel: 1, row: 1 }],
      delayMs: 1_000,
    });
    expect(sequencer.requestFastForward()).toBe(false);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(PRIMAL_WILD_REVEAL_OUTRO_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await presentation;
    expect(completed).toBe(true);
  });

  it("gates both Wild reveal observations around the official 1000ms outro", async () => {
    vi.useFakeTimers();
    const wildGrid: GridCell[][] = structuredClone(grid);
    wildGrid[1]![1] = { symbol: "WILD", multiplier: 100 };
    let releasePre: () => void = () => undefined;
    let releaseComplete: () => void = () => undefined;
    const preGate = new Promise<void>((resolve) => { releasePre = resolve; });
    const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve; });
    const starts = vi.fn(() => preGate);
    const completes = vi.fn(() => completeGate);
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      playPostStopActivation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      {
        onPostStopActivation: starts,
        onPostStopActivationComplete: completes,
      },
    );

    let completed = false;
    const presentation = sequencer.present(wildGrid).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveBeenCalledOnce();
    expect(target.playPostStopActivation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(completes).not.toHaveBeenCalled();
    expect(completed).toBe(false);

    releasePre();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.playPostStopActivation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PRIMAL_WILD_REVEAL_OUTRO_MS - 1);
    expect(completes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completes).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    releaseComplete();
    await presentation;
    expect(completed).toBe(true);
  });

  it("keeps the 1250ms Rage activation barrier after a pre-stop Quick Stop", async () => {
    vi.useFakeTimers();
    const surgeGrid: GridCell[][] = [
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
      [{ symbol: "SURGE" }, { symbol: "SURGE" }, { symbol: "SURGE" }],
    ];
    const starts = vi.fn();
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      playPostStopActivation: vi.fn(),
      requestFastForward: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      { onPostStopActivation: starts },
    );
    sequencer.markSpinStart(Date.now() - 600);
    expect(sequencer.requestFastForward()).toBe(true);

    let completed = false;
    const presentation = sequencer.present(surgeGrid).then(() => { completed = true; });
    const expectedPlan = {
      kind: "surge-feature-activation",
      cells: [{ reel: 2, row: 0 }, { reel: 2, row: 1 }, { reel: 2, row: 2 }],
      delayMs: PRIMAL_SURGE_ACTIVATION_OUTRO_MS,
    } as const;
    await vi.advanceTimersByTimeAsync(299);
    expect(target.playPostStopActivation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target.playPostStopActivation).toHaveBeenCalledTimes(1);
    expect(target.playPostStopActivation).toHaveBeenCalledWith(expectedPlan);
    expect(starts).toHaveBeenCalledWith({ ...expectedPlan, fastForward: true });
    expect(sequencer.isPresenting).toBe(true);
    expect(sequencer.requestFastForward()).toBe(false);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(PRIMAL_SURGE_ACTIVATION_OUTRO_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await presentation;
    expect(completed).toBe(true);
    expect(target.requestFastForward).not.toHaveBeenCalled();
    expect(target.stopReel).toHaveBeenCalledTimes(3);
    for (const [reel, cells] of vi.mocked(target.stopReel).mock.calls) {
      expect(cells).toBe(surgeGrid[reel]);
    }
    expect(sequencer.isPresenting).toBe(false);
  });

  it("plans third-reel anticipation only from SURGE symbols on both leading reels", () => {
    const firstTwoSurges: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
    ];
    expect(createAnticipationTriggerPlan(firstTwoSurges)).toEqual({
      reel: 2,
      triggerReels: [0, 1],
      slowStopMs: 3_000,
    });

    // 第三个转轴的结果刻意设为与门控无关。 / English: The results of the third reel are deliberately made independent of gating.
    firstTwoSurges[2] = [{ symbol: "SURGE" }, { symbol: "SURGE" }, { symbol: "SURGE" }];
    expect(createAnticipationTriggerPlan(firstTwoSurges)).not.toBeNull();
    expect(createAnticipationTriggerPlan([
      firstTwoSurges[0]!,
      grid[1]!,
      firstTwoSurges[2]!,
    ])).toBeNull();
    expect(createAnticipationTriggerPlan([
      grid[0]!,
      firstTwoSurges[1]!,
      firstTwoSurges[2]!,
    ])).toBeNull();
    expect(createAnticipationTriggerPlan([
      grid[0]!,
      grid[1]!,
      firstTwoSurges[2]!,
    ])).toBeNull();
  });

  it("starts reel 2 at reel-1 impact and applies a continuous 3000ms SLOW stop", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const calls: Array<{ type: string; elapsedMs: number; reason?: string }> = [];
    const hideComplete = vi.fn();
    const anticipationGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
    ];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((reel: number, _cells: GridCell[], durationMs: number) => new Promise<void>((resolve) => {
        calls.push({ type: `release-${reel}`, elapsedMs: Date.now() - startedAt });
        setTimeout(resolve, durationMs);
      })),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 300, settleMs: 650 },
      {
        onAnticipationStart: () => {
          calls.push({ type: "anticipation-start", elapsedMs: Date.now() - startedAt });
        },
        onAnticipationStop: (event) => {
          calls.push({
            type: "anticipation-stop",
            elapsedMs: Date.now() - startedAt,
            reason: event.reason,
          });
        },
        onAnticipationHideComplete: hideComplete,
      },
    );

    let completed = false;
    const presentation = sequencer.present(anticipationGrid).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(599);
    expect(calls.some((call) => call.type === "anticipation-start")).toBe(false);
    expect(calls.some((call) => call.type === "release-2")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toContainEqual({ type: "anticipation-start", elapsedMs: 600 });
    expect(calls).toContainEqual({ type: "release-2", elapsedMs: 600 });

    await vi.advanceTimersByTimeAsync(PRIMAL_ANTICIPATION_RELEASE_DELAY_MS - 1);
    expect(calls.some((call) => call.type === "anticipation-stop")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toContainEqual({
      type: "anticipation-stop",
      elapsedMs: 3_600,
      reason: "reel-impact",
    });
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(Math.floor(
      PRIMAL_REEL_ANTICIPATION_TRANSITION_MS
        - PRIMAL_ANTICIPATION_COPY_CLEAR_LEAD_MS,
    ) - 1);
    expect(completed).toBe(false);
    expect(hideComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hideComplete).toHaveBeenCalledOnce();
    expect(hideComplete).toHaveBeenCalledWith({
      reel: 2,
      triggerReels: [0, 1],
      slowStopMs: 3_000,
      fastForward: false,
    });
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(PRIMAL_ANTICIPATION_COPY_CLEAR_LEAD_MS - 1);
    expect(completed).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await presentation;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    expect(target.stopReel).toHaveBeenNthCalledWith(
      3,
      2,
      anticipationGrid[2],
      3_000,
      "SLOW",
    );
    expect(calls.filter(({ type }) => type === "anticipation-stop")).toEqual([{
      type: "anticipation-stop",
      elapsedMs: 3_600,
      reason: "reel-impact",
    }]);
  });

  it("finishes the anticipation hide before exact-three Rage activation", async () => {
    vi.useFakeTimers();
    const exactThreeGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "SURGE" }],
    ];
    const transitionStart = vi.fn();
    const activation = vi.fn();
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      playPostStopActivation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      {
        onPostStopTransitionStart: transitionStart,
        onPostStopActivation: activation,
      },
    );

    const presentation = sequencer.present(exactThreeGrid);
    await vi.advanceTimersByTimeAsync(PRIMAL_ANTICIPATION_RELEASE_DELAY_MS);
    expect(transitionStart).toHaveBeenCalledOnce();
    expect(activation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(Math.floor(PRIMAL_REEL_ANTICIPATION_TRANSITION_MS) - 1);
    expect(activation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(activation).toHaveBeenCalledOnce();
    expect(target.playPostStopActivation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PRIMAL_SURGE_ACTIVATION_OUTRO_MS);
    await presentation;
  });

  it("lets the next user quick-stop terminate an active SLOW tease", async () => {
    vi.useFakeTimers();
    const starts = vi.fn();
    const stops = vi.fn();
    const hideComplete = vi.fn();
    const anticipationGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
    ];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      requestFastForward: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 300, settleMs: 650 },
      {
        onAnticipationStart: starts,
        onAnticipationStop: stops,
        onAnticipationHideComplete: hideComplete,
      },
    );

    let completed = false;
    const presentation = sequencer.present(anticipationGrid).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    expect(sequencer.requestFastForward()).toBe(true);
    expect(stops).toHaveBeenCalledWith(expect.objectContaining({
      reel: 2,
      reason: "fast-forward",
      fastForward: true,
    }));
    expect(stops).toHaveBeenCalledTimes(1);
    expect(target.requestFastForward).toHaveBeenCalledTimes(1);
    expect(target.requestFastForward).toHaveBeenCalledWith("SLOW");
    await vi.advanceTimersByTimeAsync(0);
    await presentation;
    expect(completed).toBe(true);
    expect(hideComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    for (const [reel, cells] of vi.mocked(target.stopReel).mock.calls) {
      expect(cells).toBe(anticipationGrid[reel]);
    }
  });

  it("cancels immediately inside the no-plan anticipation hide barrier", async () => {
    vi.useFakeTimers();
    const hideComplete = vi.fn();
    const allStopped = vi.fn();
    const anticipationGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
    ];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      cancelPresentation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 0, settleMs: 0 },
      {
        onAllReelsStopped: allStopped,
        onAnticipationHideComplete: hideComplete,
      },
    );

    const presentation = sequencer.present(anticipationGrid).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PRIMAL_ANTICIPATION_RELEASE_DELAY_MS);
    expect(allStopped).toHaveBeenCalledOnce();
    expect(hideComplete).not.toHaveBeenCalled();
    expect(sequencer.isPresenting).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    expect(sequencer.cancel()).toBe(true);
    expect(await presentation).toBeInstanceOf(StopPresentationCancelledError);
    expect(hideComplete).not.toHaveBeenCalled();
    expect(target.cancelPresentation).toHaveBeenCalledOnce();
    expect(sequencer.isPresenting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an active anticipation when presentation is cancelled", async () => {
    vi.useFakeTimers();
    const starts = vi.fn();
    const stops = vi.fn();
    const anticipationGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
    ];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((_reel: number, _cells: GridCell[], durationMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, durationMs))),
      cancelPresentation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 300, settleMs: 650 },
      { onAnticipationStart: starts, onAnticipationStop: stops },
    );

    const presentation = sequencer.present(anticipationGrid).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(950);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(sequencer.cancel()).toBe(true);
    expect(stops).toHaveBeenCalledWith(expect.objectContaining({
      reason: "cancelled",
      fastForward: false,
    }));
    expect(stops).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(await presentation).toBeInstanceOf(StopPresentationCancelledError);
    expect(target.cancelPresentation).toHaveBeenCalledTimes(1);
  });

  it("clears an active anticipation exactly once when the anticipated reel fails", async () => {
    vi.useFakeTimers();
    const starts = vi.fn();
    const stops = vi.fn();
    const anticipationGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
    ];
    const failure = new Error("synthetic third-reel failure");
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((reel: number) => {
        if (reel === 2) return Promise.reject(failure);
        return Promise.resolve();
      }),
      cancelPresentation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 300, settleMs: 650 },
      { onAnticipationStart: starts, onAnticipationStop: stops },
    );

    const presentation = sequencer.present(anticipationGrid);
    const observedFailure = presentation.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(950);
    expect(starts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PRIMAL_ANTICIPATION_RELEASE_DELAY_MS - 650);
    expect(await observedFailure).toBe(failure);

    expect(stops).toHaveBeenCalledTimes(1);
    expect(stops).toHaveBeenCalledWith(expect.objectContaining({
      reel: 2,
      reason: "error",
      fastForward: false,
    }));
    expect(target.cancelPresentation).toHaveBeenCalledTimes(1);
    expect(sequencer.isPresenting).toBe(false);
  });

  it("queues Quick Stop before the result and enforces the 600ms floor", async () => {
    vi.useFakeTimers();
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
    };
    const sequencer = new StopSequencer(target);

    expect(sequencer.requestFastForward()).toBe(false);
    sequencer.markSpinStart();
    expect(sequencer.requestFastForward()).toBe(true);
    const presentation = sequencer.present(grid);
    expect(sequencer.isPresenting).toBe(true);
    await vi.advanceTimersByTimeAsync(599);
    expect(target.stopReel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target.stopReel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300);
    await presentation;

    expect(target.setRows).toHaveBeenCalledWith(3);
    expect(target.stopReel).toHaveBeenCalledTimes(3);
    expect(vi.mocked(target.stopReel).mock.calls.map((call) => call[2])).toEqual([550, 550, 550]);
    expect(vi.mocked(target.stopReel).mock.calls.map((call) => call[3])).toEqual([
      "FAST", "FAST", "FAST",
    ]);
    expect(sequencer.isPresenting).toBe(false);
    expect(sequencer.requestFastForward()).toBe(false);
  });

  it("rejects malformed grids before entering presentation state", async () => {
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
    };
    const sequencer = new StopSequencer(target);

    await expect(sequencer.present([[{ symbol: "ORBIT" }]])).rejects.toThrow("malformed server grid");
    expect(sequencer.isPresenting).toBe(false);
    expect(target.stopReel).not.toHaveBeenCalled();
  });

  it("anchors reel starts to one absolute timeline and overlaps settle animations", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const starts: Array<{ reel: number; elapsedMs: number }> = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((reel: number) => {
        starts.push({ reel, elapsedMs: Date.now() - startedAt });
        return new Promise<void>((resolve) => setTimeout(resolve, 200));
      }),
    };
    const sequencer = new StopSequencer(target, {
      firstDelayMs: 100,
      reelGapMs: 150,
      settleMs: 200,
    });

    const presentation = sequencer.present(grid);
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toEqual([{ reel: 0, elapsedMs: 100 }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(starts).toEqual([
      { reel: 0, elapsedMs: 100 },
      { reel: 1, elapsedMs: 250 },
    ]);
    await vi.advanceTimersByTimeAsync(150);
    expect(starts[2]).toEqual({ reel: 2, elapsedMs: 400 });
    await vi.advanceTimersByTimeAsync(200);
    await presentation;
  });

  it("emits each normal cosmetic impact after the exact 300ms brake", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const impacts: Array<{
      reel: number;
      cells: readonly GridCell[];
      elapsedMs: number;
      settleMs: number;
      impactMs: number;
      mode: "NORMAL" | "FAST" | "SLOW";
      fastForward: boolean;
    }> = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 650))),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 20, settleMs: 650 },
      { onReelImpact: (event) => impacts.push({ ...event, elapsedMs: Date.now() - startedAt }) },
    );

    expect(REEL_IMPACT_PROGRESS).toBeCloseTo(300 / 650, 12);
    const presentation = sequencer.present(grid);
    await vi.advanceTimersByTimeAsync(299);
    expect(impacts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(impacts).toEqual([{
      reel: 0, cells: grid[0], elapsedMs: 300, settleMs: 650,
      impactMs: 300, mode: "NORMAL", fastForward: false,
    }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(impacts[1]).toEqual({
      reel: 1, cells: grid[1], elapsedMs: 320, settleMs: 650,
      impactMs: 300, mode: "NORMAL", fastForward: false,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(impacts[2]).toEqual({
      reel: 2, cells: grid[2], elapsedMs: 340, settleMs: 650,
      impactMs: 300, mode: "NORMAL", fastForward: false,
    });
    await vi.advanceTimersByTimeAsync(650);
    await presentation;
  });

  it("anchors the first brake to the spin request and keeps late-response reel gaps", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const starts: Array<{ reel: number; elapsedMs: number }> = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async (reel: number) => {
        starts.push({ reel, elapsedMs: Date.now() - startedAt });
      }),
    };
    const sequencer = new StopSequencer(target);
    sequencer.markSpinStart();
    await vi.advanceTimersByTimeAsync(2_000);
    const presentation = sequencer.present(grid);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([{ reel: 0, elapsedMs: 2_000 }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(starts[1]).toEqual({ reel: 1, elapsedMs: 2_300 });
    await vi.advanceTimersByTimeAsync(300);
    expect(starts[2]).toEqual({ reel: 2, elapsedMs: 2_600 });
    await vi.advanceTimersByTimeAsync(300);
    await presentation;
  });

  it("fires ALLSTOPPED at 2400ms while the final NORMAL bounce continues to 2750ms", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const allStoppedAt: number[] = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((_reel: number, _cells: GridCell[], durationMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, durationMs))),
    };
    const sequencer = new StopSequencer(target, {}, {
      onAllReelsStopped: () => allStoppedAt.push(Date.now() - startedAt),
    });
    sequencer.markSpinStart();

    let completed = false;
    const presentation = sequencer.present(grid).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(2_399);
    expect(allStoppedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(allStoppedAt).toEqual([2_400]);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(349);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await presentation;
    expect(completed).toBe(true);
  });

  it("uses the captured Fast Play cadence and suppresses Rage suspense", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const starts: Array<{ reel: number; elapsedMs: number; mode: string }> = [];
    const impacts: Array<{ reel: number; elapsedMs: number }> = [];
    const allStoppedAt: number[] = [];
    const anticipation = vi.fn();
    const fastPlayGrid: GridCell[][] = [
      [{ symbol: "SURGE" }, { symbol: "ORBIT" }, { symbol: "PULSE" }],
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      grid[2]!,
    ];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((reel: number, _cells: GridCell[], durationMs: number, mode) => {
        starts.push({ reel, elapsedMs: Date.now() - startedAt, mode: mode ?? "" });
        return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
      }),
    };
    const sequencer = new StopSequencer(target, {}, {
      onReelImpact: ({ reel }) => impacts.push({ reel, elapsedMs: Date.now() - startedAt }),
      onAllReelsStopped: () => allStoppedAt.push(Date.now() - startedAt),
      onAnticipationStart: anticipation,
    });
    sequencer.markSpinStart();

    const presentation = sequencer.present(fastPlayGrid, { fastPlay: true });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(starts).toEqual([
      { reel: 0, elapsedMs: 600, mode: "FAST" },
      { reel: 1, elapsedMs: 750, mode: "FAST" },
      { reel: 2, elapsedMs: 900, mode: "FAST" },
    ]);
    expect(impacts).toEqual([
      { reel: 0, elapsedMs: 900 },
      { reel: 1, elapsedMs: 1_050 },
      { reel: 2, elapsedMs: 1_200 },
    ]);
    expect(allStoppedAt).toEqual([1_200]);
    expect(anticipation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await presentation;
  });

  it("starts all FAST brakes together and impacts after the captured 300ms brake", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const impacts: Array<{
      reel: number;
      cells: readonly GridCell[];
      elapsedMs: number;
      settleMs: number;
      impactMs: number;
      mode: "NORMAL" | "FAST" | "SLOW";
      fastForward: boolean;
    }> = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 550))),
      requestFastForward: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 500, reelGapMs: 500, settleMs: 380 },
      { onReelImpact: (event) => impacts.push({ ...event, elapsedMs: Date.now() - startedAt }) },
    );

    const presentation = sequencer.present(grid);
    expect(sequencer.requestFastForward()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(impacts).toEqual([]);
    await vi.advanceTimersByTimeAsync(599);
    expect(impacts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(target.stopReel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(299);
    expect(impacts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(impacts).toEqual([
      { reel: 0, cells: grid[0], elapsedMs: 900, settleMs: 550,
        impactMs: 300, mode: "FAST", fastForward: true },
      { reel: 1, cells: grid[1], elapsedMs: 900, settleMs: 550,
        impactMs: 300, mode: "FAST", fastForward: true },
      { reel: 2, cells: grid[2], elapsedMs: 900, settleMs: 550,
        impactMs: 300, mode: "FAST", fastForward: true },
    ]);
    await vi.advanceTimersByTimeAsync(250);
    await presentation;
  });

  it("preserves an active brake impact barrier while fast-stop releases future reels", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const starts: Array<{
      reel: number;
      elapsedMs: number;
      settleMs: number;
    }> = [];
    const impacts: Array<{
      reel: number;
      cells: readonly GridCell[];
      elapsedMs: number;
      settleMs: number;
      impactMs: number;
      mode: "NORMAL" | "FAST" | "SLOW";
      fastForward: boolean;
    }> = [];
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((reel: number, _cells: GridCell[], settleMs: number) => {
        starts.push({ reel, elapsedMs: Date.now() - startedAt, settleMs });
        return new Promise<void>((resolve) => setTimeout(resolve, settleMs));
      }),
      requestFastForward: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 500, settleMs: 650 },
      { onReelImpact: (event) => impacts.push({ ...event, elapsedMs: Date.now() - startedAt }) },
    );

    const presentation = sequencer.present(grid);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([{ reel: 0, elapsedMs: 0, settleMs: 650 }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(sequencer.requestFastForward()).toBe(true);
    await vi.advanceTimersByTimeAsync(199);
    expect(starts).toEqual([{ reel: 0, elapsedMs: 0, settleMs: 650 }]);
    expect(impacts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(impacts).toEqual([{
      reel: 0,
      cells: grid[0],
      elapsedMs: 300,
      settleMs: 650,
      impactMs: 300,
      mode: "NORMAL",
      fastForward: false,
    }]);

    await vi.advanceTimersByTimeAsync(300);
    expect(starts).toEqual([
      { reel: 0, elapsedMs: 0, settleMs: 650 },
      { reel: 1, elapsedMs: 600, settleMs: 550 },
      { reel: 2, elapsedMs: 600, settleMs: 550 },
    ]);
    await vi.advanceTimersByTimeAsync(299);
    expect(impacts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(impacts).toEqual([
      {
        reel: 0,
        cells: grid[0],
        elapsedMs: 300,
        settleMs: 650,
        impactMs: 300,
        mode: "NORMAL",
        fastForward: false,
      },
      {
        reel: 1,
        cells: grid[1],
        elapsedMs: 900,
        settleMs: 550,
        impactMs: 300,
        mode: "FAST",
        fastForward: true,
      },
      {
        reel: 2,
        cells: grid[2],
        elapsedMs: 900,
        settleMs: 550,
        impactMs: 300,
        mode: "FAST",
        fastForward: true,
      },
    ]);

    await vi.advanceTimersByTimeAsync(250);
    await presentation;
    expect(impacts.map(({ reel }) => reel)).toEqual([0, 1, 2]);
  });

  it("does not emit a stale impact after cancellation releases its timer", async () => {
    vi.useFakeTimers();
    const impacts = vi.fn();
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 100))),
      cancelPresentation: vi.fn(),
    };
    const sequencer = new StopSequencer(
      target,
      { firstDelayMs: 0, reelGapMs: 500, settleMs: 100 },
      { onReelImpact: impacts },
    );

    const presentation = sequencer.present(grid).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(40);
    expect(sequencer.cancel()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(await presentation).toBeInstanceOf(StopPresentationCancelledError);
    expect(impacts).not.toHaveBeenCalled();
  });

  it("keeps an active NORMAL brake on its clock and makes only future reels FAST", async () => {
    vi.useFakeTimers();
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn((_reel: number, _cells: GridCell[], durationMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, durationMs))),
      requestFastForward: vi.fn(),
    };
    const sequencer = new StopSequencer(target, {
      firstDelayMs: 0,
      reelGapMs: 500,
      settleMs: 260,
    });

    const presentation = sequencer.present(grid);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.stopReel).toHaveBeenCalledWith(0, grid[0], 260, "NORMAL");
    await vi.advanceTimersByTimeAsync(100);
    expect(sequencer.requestFastForward()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_050);
    await presentation;

    expect(target.requestFastForward).not.toHaveBeenCalled();
    expect(vi.mocked(target.stopReel).mock.calls.map((call) => call[2])).toEqual([260, 550, 550]);
    expect(vi.mocked(target.stopReel).mock.calls.map((call) => call[3])).toEqual([
      "NORMAL", "FAST", "FAST",
    ]);
  });

  it("cancels pending absolute timers and resets the target", async () => {
    const target: ReelStopTarget = {
      setRows: vi.fn(),
      stopReel: vi.fn(async () => undefined),
      cancelPresentation: vi.fn(),
    };
    const sequencer = new StopSequencer(target, { firstDelayMs: 1000 });

    const presentation = sequencer.present(grid).catch((error: unknown) => error);
    expect(sequencer.cancel()).toBe(true);
    expect(await presentation).toBeInstanceOf(StopPresentationCancelledError);

    expect(target.cancelPresentation).toHaveBeenCalledTimes(1);
    expect(target.stopReel).not.toHaveBeenCalled();
    expect(sequencer.isPresenting).toBe(false);
  });
});
