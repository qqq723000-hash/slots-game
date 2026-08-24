import { describe, expect, it, vi } from "vitest";
import {
  BIG_WIN_ANIMATION,
  BIG_WIN_ANIMATION_MS,
  BIG_WIN_CONTROLLER_LEAD_IN_MS,
  BIG_WIN_DEFAULT_HOLD_MS,
  BIG_WIN_DESKTOP_LAYOUT,
  BIG_WIN_FAST_HOLD_MS,
  BIG_WIN_MAX_COUNT_MS,
  BIG_WIN_MIN_COUNT_MS,
  BIG_WIN_TIER_THRESHOLDS,
  BIG_WIN_VALUE_BASELINE_OFFSET,
  BIG_WIN_VALUE_BITMAP_HEIGHT,
  BIG_WIN_VALUE_FONT_SIZE,
  BIG_WIN_VALUE_SLOT,
  BigWinView,
  bigWinAmountAt,
  bigWinResponsiveTransform,
  bigWinTierFor,
  bigWinTransitionAnimation,
  bigWinVerifiedArtworkFromPackage,
  loadBigWinSharedAtlas,
  planBigWin,
  type BigWinPlan,
  type BigWinTier,
  uprightBigWinSiblingTransform,
} from "../src/renderer/BigWinView";
import {
  PRIMAL_BITMAP_FONT_BASE,
  PRIMAL_BITMAP_FONT_DISPLAY_SIZE,
  PRIMAL_BITMAP_FONT_LINE_HEIGHT,
  PRIMAL_BITMAP_FONT_NAME,
  PRIMAL_BITMAP_FONT_PAGE_URL,
  PRIMAL_BITMAP_FONT_SIZE,
  PRIMAL_BITMAP_FONT_URL,
} from "../src/renderer/PrimalBitmapFont";
import { BIG_WIN_COIN_MANIFEST_URL } from "../src/renderer/BigWinCoinShower";
import {
  PRIMAL_SPINE_SPECS,
  primalSpineSkeletonUrl,
} from "../src/renderer/spine/PrimalSpineAssets";

function mountedBigWin(
  plan: BigWinPlan,
  onMilestone: (type: string) => unknown = () => undefined,
) {
  const view = new BigWinView({
    formatAmount: (amount) => `£${amount}`,
    onMilestone: (milestone) => onMilestone(milestone.type),
  });
  const spine = {
    update: vi.fn(),
    skeleton: {
      setToSetupPose: vi.fn(),
      findSlot: vi.fn(() => null),
      findBone: vi.fn(() => null),
    },
    state: {
      clearTracks: vi.fn(),
      hasAnimation: vi.fn(() => true),
      setAnimation: vi.fn(),
      addAnimation: vi.fn(),
    },
  };
  const amountText = {
    text: "",
    width: 100,
    height: 50,
    visible: false,
    scale: { set: vi.fn() },
  };
  const resolve = vi.fn();
  const harness = view as unknown as {
    spine: typeof spine;
    amountText: typeof amountText;
    coinShower: {
      setTier(tier: number): void;
      stop(): void;
      update(durationMs: number): void;
      killAll(): void;
    };
    active: {
      plan: BigWinPlan;
      resolve: typeof resolve;
      elapsedMs: number;
      nextMilestone: number;
      tier: BigWinTier;
      countStarted: boolean;
      countEnded: boolean;
      hideStarted: boolean;
      checkpointPending: boolean;
      quickView: { hideAtMs: number; completeAtMs: number } | null;
    } | null;
    drainMilestonesAt(atMs: number): void;
  };
  harness.spine = spine;
  harness.amountText = amountText;
  const setTier = vi.spyOn(harness.coinShower, "setTier").mockImplementation(() => undefined);
  vi.spyOn(harness.coinShower, "stop").mockImplementation(() => undefined);
  vi.spyOn(harness.coinShower, "update").mockImplementation(() => undefined);
  vi.spyOn(harness.coinShower, "killAll").mockImplementation(() => undefined);
  harness.active = {
    plan,
    resolve,
    elapsedMs: 0,
    nextMilestone: 0,
    tier: "bigwin",
    countStarted: false,
    countEnded: false,
    hideStarted: false,
    checkpointPending: false,
    quickView: null,
  };
  view.visible = true;
  view.interactive = false;
  harness.drainMilestonesAt(0);
  return { view, harness, spine, amountText, resolve, setTier };
}

describe("native Big Win planning", () => {
  it("binds all four verified target resources to the renderer payload without network I/O", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const spineBytes = Uint8Array.of(1, 2, 3);
    const fontBytes = new TextEncoder().encode("verified descriptor");
    const pageBytes = Uint8Array.of(137, 80, 78, 71);
    const coinBytes = new TextEncoder().encode('{"verified":true}');
    const resource = (
      id: string,
      url: string,
      decoder: "binary" | "text" | "json",
      bytes: Uint8Array,
    ) => Object.freeze({
      spec: Object.freeze({ id, url, decoder, bytes: bytes.byteLength, sha256: "0".repeat(64) }),
      bytes,
      decoded: null,
    });
    const loaded = Object.freeze({
      id: "desktop-feature-big-win",
      version: "test",
      stage: "feature-on-demand" as const,
      resources: new Map([
        ["spine", resource("spine", primalSpineSkeletonUrl("bigWin"), "binary", spineBytes)],
        ["font", resource("font", PRIMAL_BITMAP_FONT_URL, "text", fontBytes)],
        ["page", resource("page", PRIMAL_BITMAP_FONT_PAGE_URL, "binary", pageBytes)],
        ["coins", resource("coins", BIG_WIN_COIN_MANIFEST_URL, "json", coinBytes)],
      ]),
    });

    const payload = bigWinVerifiedArtworkFromPackage(loaded);

    expect(payload).toMatchObject({
      channel: "desktop",
      spineBinary: spineBytes,
      fontDescriptor: "verified descriptor",
      fontPageBytes: pageBytes,
      coinManifest: { verified: true },
    });
    expect(payload.spineBinary).toBe(spineBytes);
    expect(payload.fontPageBytes).toBe(pageBytes);
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("uses the captured 20/100/250/500x tiers with integer comparisons", () => {
    expect(BIG_WIN_TIER_THRESHOLDS).toEqual([
      { tier: "bigwin", multiplier: 20n },
      { tier: "super", multiplier: 100n },
      { tier: "mega", multiplier: 250n },
      { tier: "ultra", multiplier: 500n },
    ]);
    expect(bigWinTierFor(1_999n, 100n)).toBeNull();
    expect(bigWinTierFor(2_000n, 100n)).toBe("bigwin");
    expect(bigWinTierFor(10_000n, 100n)).toBe("super");
    expect(bigWinTierFor(25_000n, 100n)).toBe("mega");
    expect(bigWinTierFor(50_000n, 100n)).toBe("ultra");
    expect(planBigWin(1_999n, 100n)).toBeNull();
  });

  it("keeps the controller's 300ms lead-in outside the native timeline", () => {
    const plan = planBigWin(2_000n, 100n);
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      controllerLeadInMs: BIG_WIN_CONTROLLER_LEAD_IN_MS,
      countStartAtMs: 500,
      countMs: 5_000,
      countEndAtMs: 5_500,
      holdMs: BIG_WIN_DEFAULT_HOLD_MS,
      fastHoldMs: BIG_WIN_FAST_HOLD_MS,
      hideStartAtMs: 9_500,
      hideMs: 933.333,
      completeAtMs: 10_433.333,
      finalTier: "bigwin",
    });
    expect(BIG_WIN_CONTROLLER_LEAD_IN_MS).toBe(300);
  });

  it("uses the active controller's 250ms/x clock with a natural 5..30 second window", () => {
    expect(BIG_WIN_MIN_COUNT_MS).toBe(5_000);
    expect(planBigWin(2_000n, 100n)?.countMs).toBe(BIG_WIN_MIN_COUNT_MS);
    expect(planBigWin(2_050n, 100n)?.countMs).toBe(5_125);
    expect(planBigWin(10_000n, 100n)?.countMs).toBe(25_000);
    expect(planBigWin(11_900n, 100n)?.countMs).toBe(29_750);
    expect(planBigWin(12_000n, 100n)?.countMs).toBe(BIG_WIN_MAX_COUNT_MS);
    expect(planBigWin(25_000n, 100n)?.countMs).toBe(BIG_WIN_MAX_COUNT_MS);
    expect(planBigWin(500_000n, 1n)?.countMs).toBe(BIG_WIN_MAX_COUNT_MS);
  });

  it("plans threshold upgrades on the count clock and orders a terminal upgrade first", () => {
    const plan = planBigWin(25_000n, 100n);
    expect(plan?.upgrades).toEqual([
      {
        fromTier: "bigwin",
        toTier: "super",
        thresholdMultiplier: 100n,
        atCountMs: 12_000,
        atPresentationMs: 12_500,
        animation: "bigwin_to_super",
      },
      {
        fromTier: "super",
        toTier: "mega",
        thresholdMultiplier: 250n,
        atCountMs: 30_000,
        atPresentationMs: 30_500,
        animation: "super_to_mega",
      },
    ]);
    expect(plan?.milestones.filter(({ atMs }) => atMs === 30_500).map(({ type }) => type))
      .toEqual(["level-up", "count-end"]);
  });

  it("retains huge money as BigInt for plans and cosmetic interpolation", () => {
    const bet = 10n ** 40n;
    const win = bet * 123n + bet / 2n;
    const plan = planBigWin(win, bet);
    expect(plan?.multiplierFloor).toBe(123n);
    expect(plan?.finalTier).toBe("super");
    expect(plan?.countMs).toBe(30_000);
    expect(plan && bigWinAmountAt(plan, plan.countStartAtMs)).toBe(0n);
    expect(plan && bigWinAmountAt(plan, plan.countStartAtMs + 15_000))
      .toBe(win / 2n);
    expect(plan && bigWinAmountAt(plan, plan.completeAtMs)).toBe(win);
  });

  it("exposes all real direct level-skip animation names and rejects level-down", () => {
    expect(bigWinTransitionAnimation("bigwin", "super")).toBe("bigwin_to_super");
    expect(bigWinTransitionAnimation("bigwin", "mega")).toBe("bigwin_to_mega");
    expect(bigWinTransitionAnimation("bigwin", "ultra")).toBe("bigwin_to_ultra");
    expect(bigWinTransitionAnimation("super", "ultra")).toBe("super_to_ultra");
    expect(() => bigWinTransitionAnimation("mega", "super")).toThrow(/move upward/);
  });

  it("keeps input closed for 500ms and starts coins only with STARTED", () => {
    const plan = planBigWin(2_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const milestones: string[] = [];
    const { view, setTier } = mountedBigWin(plan, (type) => milestones.push(type));

    expect(milestones).toEqual(["show"]);
    expect(setTier).not.toHaveBeenCalled();
    expect(view.interactive).toBe(false);
    expect(view.requestAdvance()).toBeNull();
    view.update(499);
    expect(view.requestAdvance()).toBeNull();
    expect(setTier).not.toHaveBeenCalled();
    view.update(1);
    expect(milestones).toEqual(["show", "count-start"]);
    expect(setTier).toHaveBeenCalledOnce();
    expect(setTier).toHaveBeenCalledWith(0);
    expect(view.interactive).toBe(true);
    view.destroy({ children: true });
  });

  it("freezes the native Big Win clock while count-start awaits a fixture checkpoint", async () => {
    const plan = planBigWin(2_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const milestones: string[] = [];
    const { view, harness } = mountedBigWin(plan, (type) => {
      milestones.push(type);
      return type === "count-start" ? gate : undefined;
    });

    view.update(plan.countStartAtMs);
    expect(milestones).toEqual(["show", "count-start"]);
    expect(harness.active?.elapsedMs).toBe(plan.countStartAtMs);
    expect(harness.active?.checkpointPending).toBe(true);
    expect(view.requestAdvance()).toBeNull();

    view.update(2_000);
    expect(harness.active?.elapsedMs).toBe(plan.countStartAtMs);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.active?.checkpointPending).toBe(false);
    view.update(1);
    expect(harness.active?.elapsedMs).toBe(plan.countStartAtMs + 1);
    view.destroy({ children: true });
  });

  it("fails open when an async Big Win milestone observer rejects", async () => {
    const plan = planBigWin(2_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const { view, harness } = mountedBigWin(plan, (type) => (
      type === "count-start" ? Promise.reject(new Error("fixture released")) : undefined
    ));

    view.update(plan.countStartAtMs);
    expect(harness.active?.checkpointPending).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.active?.checkpointPending).toBe(false);
    view.update(1);
    expect(harness.active?.elapsedMs).toBe(plan.countStartAtMs + 1);
    view.destroy({ children: true });
  });

  it("one accepted input jumps directly to the final award and owns a 2000ms fast hold", () => {
    const plan = planBigWin(25_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;

    const dispatched: string[] = [];
    const { view, harness, spine, amountText, resolve } = mountedBigWin(
      plan,
      (type) => dispatched.push(type),
    );
    // 自然播放已经到达 SUPER，但尚未到达 MEGA 或计数结束点。
    view.update(15_000);
    expect(harness.active?.tier).toBe("super");
    dispatched.length = 0;

    expect(view.requestAdvance()).toBe("quick-view");
    expect(view.requestAdvance()).toBeNull();
    expect(dispatched).toEqual(["level-up", "count-end"]);
    expect(harness.active?.tier).toBe("mega");
    expect(view.displayedAmount).toBe(plan.winMinor);
    expect(amountText.text).toBe("£25000  ");
    expect(spine.state.setAnimation).toHaveBeenCalledWith(0, "super_to_mega", false);
    expect(harness.active?.quickView).toEqual({
      hideAtMs: 17_000,
      completeAtMs: 17_933.333,
    });
    expect(view.interactive).toBe(false);

    view.update(BIG_WIN_FAST_HOLD_MS - 1);
    expect(dispatched).toEqual(["level-up", "count-end"]);
    view.update(1);
    expect(dispatched).toEqual(["level-up", "count-end", "hide-start"]);
    expect(spine.state.setAnimation).toHaveBeenCalledWith(0, "mega_hide", false);
    view.update(BIG_WIN_ANIMATION_MS.hide);
    expect(dispatched).toEqual(["level-up", "count-end", "hide-start", "complete"]);
    expect(resolve).toHaveBeenCalledWith("complete");
    expect(view.isPresenting).toBe(false);
  });

  it("serializes quick-view level-up and count-end across async fixture barriers", async () => {
    const plan = planBigWin(25_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    let releaseLevelUp: () => void = () => undefined;
    let releaseCountEnd: () => void = () => undefined;
    const levelUpGate = new Promise<void>((resolve) => { releaseLevelUp = resolve; });
    const countEndGate = new Promise<void>((resolve) => { releaseCountEnd = resolve; });
    const dispatched: string[] = [];
    let gateQuickView = false;
    const { view, harness } = mountedBigWin(plan, (type) => {
      dispatched.push(type);
      if (!gateQuickView) return undefined;
      if (type === "level-up") return levelUpGate;
      if (type === "count-end") return countEndGate;
      return undefined;
    });

    view.update(15_000);
    dispatched.length = 0;
    gateQuickView = true;
    expect(view.requestAdvance()).toBe("quick-view");
    expect(dispatched).toEqual(["level-up"]);
    expect(harness.active?.countEnded).toBe(false);
    expect(harness.active?.quickView).toBeNull();
    expect(harness.active?.checkpointPending).toBe(true);

    releaseLevelUp();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toEqual(["level-up", "count-end"]);
    expect(harness.active?.countEnded).toBe(true);
    expect(harness.active?.quickView).toEqual({
      hideAtMs: 17_000,
      completeAtMs: 17_933.333,
    });
    expect(harness.active?.checkpointPending).toBe(true);
    view.update(BIG_WIN_FAST_HOLD_MS);
    expect(harness.active?.elapsedMs).toBe(15_000);

    releaseCountEnd();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.active?.checkpointPending).toBe(false);
    view.update(BIG_WIN_FAST_HOLD_MS);
    expect(dispatched).toContain("hide-start");
    view.destroy({ children: true });
  });

  it("keeps natural terminal LEVEL_UP before STOP when both share a timestamp", () => {
    const plan = planBigWin(10_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const dispatched: string[] = [];
    const { view } = mountedBigWin(plan, (type) => dispatched.push(type));

    view.update(plan.countEndAtMs);
    expect(dispatched).toEqual(["show", "count-start", "level-up", "count-end"]);
    expect(view.displayedAmount).toBe(plan.winMinor);
    view.destroy({ children: true });
  });

  it("finishes the complete natural milestone program and ignores stale next-spin input", () => {
    const plan = planBigWin(10_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const dispatched: string[] = [];
    const { view, spine, resolve } = mountedBigWin(plan, (type) => dispatched.push(type));

    view.update(plan.completeAtMs + 5_000);

    expect(dispatched).toEqual([
      "show",
      "count-start",
      "level-up",
      "count-end",
      "hide-start",
      "complete",
    ]);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith("complete");
    expect(view.isPresenting).toBe(false);
    expect(view.visible).toBe(false);
    expect(view.interactive).toBe(false);
    expect(view.displayedAmount).toBe(plan.winMinor);
    expect(view.requestAdvance()).toBeNull();

    const completedMilestones = [...dispatched];
    const animationCalls = spine.state.setAnimation.mock.calls.length;
    view.update(plan.completeAtMs);
    expect(dispatched).toEqual(completedMilestones);
    expect(spine.state.setAnimation).toHaveBeenCalledTimes(animationCalls);
    view.destroy({ children: true });
  });

  it("keeps the terminal overlay mounted while complete awaits an observer barrier", async () => {
    const plan = planBigWin(10_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    let release: () => void = () => undefined;
    const completeGate = new Promise<void>((resolve) => { release = resolve; });
    const { view, harness, resolve } = mountedBigWin(plan, (type) => (
      type === "complete" ? completeGate : undefined
    ));

    view.update(plan.completeAtMs);
    expect(harness.active?.checkpointPending).toBe(true);
    expect(view.isPresenting).toBe(true);
    expect(view.visible).toBe(true);
    expect(resolve).not.toHaveBeenCalled();

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.isPresenting).toBe(false);
    expect(view.visible).toBe(false);
    expect(resolve).toHaveBeenCalledWith("complete");
  });

  it("cancels an active quick view without dispatching its delayed hide", () => {
    const plan = planBigWin(2_000n, 100n);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const dispatched: string[] = [];
    const { view, resolve } = mountedBigWin(plan, (type) => dispatched.push(type));
    view.update(BIG_WIN_ANIMATION_MS.countStart);
    expect(view.requestAdvance()).toBe("quick-view");

    view.cancel();
    expect(resolve).toHaveBeenCalledWith("cancelled");
    expect(view.isPresenting).toBe(false);
    const atCancel = [...dispatched];
    view.update(BIG_WIN_FAST_HOLD_MS + BIG_WIN_ANIMATION_MS.hide);
    expect(dispatched).toEqual(atCancel);
    view.destroy({ children: true });
  });

  it("registers the shared BMFont before the coin atlas loader reuses its page", async () => {
    const order: string[] = [];
    let finishFont!: (installed: boolean) => void;
    const fontReady = new Promise<boolean>((resolve) => {
      finishFont = resolve;
    });
    const loading = loadBigWinSharedAtlas(
      () => {
        order.push("font-start");
        return fontReady;
      },
      async () => {
        order.push("coins-start");
      },
    );

    expect(order).toEqual(["font-start"]);
    finishFont(true);
    await expect(loading).resolves.toBe(true);
    expect(order).toEqual(["font-start", "coins-start"]);
  });

  it("fails closed for invalid authority data and invalid host timing", () => {
    expect(() => planBigWin(-1n, 100n)).toThrow(/non-negative/);
    expect(() => planBigWin(2_000n, 0n)).toThrow(/positive/);
    expect(() => planBigWin(2_000n, 100n, { holdMs: -1 })).toThrow(/holdMs/);
  });
});

describe("native BigWin.skel view contract", () => {
  const capturedReflectedBoneMatrix = Object.freeze({
    a: 1,
    b: 0,
    c: -6.961530999942724e-8,
    d: -0.9999999999999993,
  });
  const tiltedReflectedBoneMatrix = Object.freeze({
    a: 0.806,
    b: 0.012,
    c: 0.012,
    d: -0.806,
  });

  it("drops the Spine Y reflection while preserving authored sibling rotation and scale", () => {
    const transform = uprightBigWinSiblingTransform(tiltedReflectedBoneMatrix);

    expect(tiltedReflectedBoneMatrix.a * tiltedReflectedBoneMatrix.d
      - tiltedReflectedBoneMatrix.b * tiltedReflectedBoneMatrix.c).toBeLessThan(0);
    expect(transform.rotation).toBeCloseTo(Math.atan2(0.012, 0.806), 12);
    expect(transform.scaleX).toBeCloseTo(Math.hypot(0.806, 0.012), 12);
    expect(transform.scaleY).toBeCloseTo(Math.hypot(0.012, -0.806), 12);
    expect(transform.scaleX).toBeGreaterThan(0);
    expect(transform.scaleY).toBeGreaterThan(0);
  });

  it("keeps the coin-shower sibling upright on the reflected authored bone", () => {
    const view = new BigWinView();
    const bone = {
      matrix: capturedReflectedBoneMatrix,
      worldX: 17,
      worldY: 429.13,
    };
    const harness = view as unknown as {
      spine: { skeleton: { findBone(name: string): typeof bone | null } } | null;
      coinShower: {
        position: { x: number; y: number };
        rotation: number;
        scale: { x: number; y: number };
        visible: boolean;
      };
      syncCoinShowerToAuthoredBone(): void;
    };
    harness.spine = { skeleton: { findBone: () => bone } };
    view.visible = true;

    harness.syncCoinShowerToAuthoredBone();

    expect(harness.coinShower.position).toMatchObject({ x: 17, y: 429.13 });
    expect(harness.coinShower.rotation).toBe(0);
    expect(harness.coinShower.scale.x).toBe(1);
    expect(harness.coinShower.scale.y).toBeCloseTo(1, 12);
    expect(harness.coinShower.scale.y).toBeGreaterThan(0);
    expect(harness.coinShower.visible).toBe(true);
    harness.spine = null;
    view.destroy({ children: true });
  });

  it("keeps fitted amount glyphs upright on the reflected authored slot", () => {
    const view = new BigWinView();
    const localToWorld = vi.fn((point: { x: number; y: number }) => {
      point.x += 100;
      point.y += 200;
    });
    const bone = {
      data: { name: BIG_WIN_VALUE_SLOT.bone },
      matrix: capturedReflectedBoneMatrix,
      worldX: 100,
      worldY: 200,
      localToWorld,
    };
    const attachment = { vertices: [-10, -20, 10, 20] };
    const slot = {
      bone,
      color: { a: 0.75 },
      getAttachment: () => attachment,
    };
    const amount = {
      position: { set: vi.fn() },
      rotation: 0,
      scale: { set: vi.fn() },
      alpha: 0,
      visible: false,
    };
    const harness = view as unknown as {
      spine: {
        skeleton: {
          color: { a: number };
          findSlot(name: string): typeof slot | null;
        };
      } | null;
      amountText: typeof amount;
      amountFitScaleX: number;
      amountFitScaleY: number;
      syncAmountToAuthoredSlot(): void;
    };
    harness.spine = {
      skeleton: {
        color: { a: 0.8 },
        findSlot: () => slot,
      },
    };
    harness.amountText = amount;
    harness.amountFitScaleX = 0.5;
    harness.amountFitScaleY = 0.75;
    view.visible = true;

    harness.syncAmountToAuthoredSlot();

    expect(localToWorld).toHaveBeenCalledOnce();
    expect(amount.position.set).toHaveBeenCalledWith(100, 200);
    expect(amount.rotation).toBe(0);
    expect(amount.scale.set).toHaveBeenCalledWith(
      0.5,
      0.75 * Math.hypot(
        capturedReflectedBoneMatrix.c,
        capturedReflectedBoneMatrix.d,
      ),
    );
    expect(amount.scale.set.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(amount.alpha).toBeCloseTo(0.6, 12);
    expect(amount.visible).toBe(true);
    harness.spine = null;
    view.destroy({ children: true });
  });

  it("registers the captured case-sensitive skeleton and native clips", () => {
    expect(PRIMAL_SPINE_SPECS.bigWin).toEqual({
      group: "spine_ui",
      skeleton: "BigWin",
      idleAnimation: "hidden",
    });
    expect(primalSpineSkeletonUrl("bigWin")).toContain("/spine_ui/BigWin.skel");
    expect(BIG_WIN_ANIMATION).toMatchObject({ hidden: "hidden", show: "bigwin_show" });
    expect(BIG_WIN_ANIMATION.idle("super")).toBe("super_idle");
    expect(BIG_WIN_ANIMATION.hide("ultra")).toBe("ultra_hide");
    expect(BIG_WIN_ANIMATION_MS).toEqual({
      show: 1_000,
      countStart: 500,
      transition: 1_333.333,
      idle: 3_333.333,
      hide: 933.333,
    });
  });

  it("binds value text to the original skeleton slot and bone", () => {
    expect(BIG_WIN_VALUE_SLOT).toEqual({
      name: "bigwinValue",
      bone: "win_value",
      width: 966.36,
      height: 128.95,
    });
    expect(PRIMAL_BITMAP_FONT_NAME).toBe("PrimalRampage");
    expect(PRIMAL_BITMAP_FONT_SIZE).toBe(295);
    expect(PRIMAL_BITMAP_FONT_LINE_HEIGHT).toBe(541);
    expect(PRIMAL_BITMAP_FONT_BASE).toBe(296);
    expect(PRIMAL_BITMAP_FONT_DISPLAY_SIZE).toBe(105);
    expect(BIG_WIN_VALUE_FONT_SIZE).toBe(32);
    expect(PRIMAL_BITMAP_FONT_URL).toContain("/fonts/primal-rampage/PrimalRampage.fnt");
    expect(BIG_WIN_VALUE_BASELINE_OFFSET).toBeCloseTo(-16.054237, 6);
    expect(BIG_WIN_VALUE_BITMAP_HEIGHT).toBeCloseTo(58.684746, 6);
    expect(BIG_WIN_VALUE_SLOT.height / BIG_WIN_VALUE_BITMAP_HEIGHT).toBeGreaterThan(2);
  });

  it("owns the captured desktop root transform", () => {
    expect(BIG_WIN_DESKTOP_LAYOUT).toEqual({
      x: 640,
      y: 309,
      scale: 0.6,
      minBound: [-600, -515, 1_200, 1_200],
    });
    const view = new BigWinView();
    expect(view.position.x).toBe(640);
    expect(view.position.y).toBe(309);
    expect(view.scale.x).toBeCloseTo(0.6, 10);
    expect(view.scale.y).toBeCloseTo(0.6, 10);
    view.destroy({ children: true });
  });

  it("projects the scene-level overlay and hit plane into mobile gameplay regions", () => {
    const phoneRegion = { left: 0, top: 0, width: 390, height: 760 };
    expect(bigWinResponsiveTransform(phoneRegion)).toEqual({
      x: 195,
      y: 352.375,
      scale: 0.325,
    });

    const view = new BigWinView();
    view.setResponsiveLayout(phoneRegion);
    expect(view.position.x).toBe(195);
    expect(view.position.y).toBeCloseTo(352.375, 10);
    expect(view.scale.x).toBeCloseTo(0.325, 10);
    expect(view.hitArea).toMatchObject({
      x: -600,
      width: 1_200,
    });

    view.setResponsiveLayout({ left: 0, top: 0, width: 1_024, height: 732 });
    expect(view.position.x).toBe(512);
    expect(view.position.y).toBeCloseTo(314.15, 10);
    expect(view.scale.x).toBeCloseTo(0.61, 10);
    view.destroy({ children: true });
  });

  it("exposes a host-controlled milestone listener without an audio dependency", () => {
    const view = new BigWinView({ onMilestone: () => undefined });
    expect(view.isPresenting).toBe(false);
    expect(view.displayedAmount).toBe(0n);
    expect(() => view.setMilestoneListener(() => undefined)).not.toThrow();
    expect(view.requestAdvance()).toBeNull();
    expect(view.interactive).toBe(false);
    expect(view.hitArea).not.toBeNull();
    expect(() => view.cancel()).not.toThrow();
    view.destroy({ children: true });
  });
});
