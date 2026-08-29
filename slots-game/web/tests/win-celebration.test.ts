import { describe, expect, it, vi } from "vitest";
import { Container } from "pixi.js";
import type { Win } from "../src/app/state/types";
import { settleBlurStrength, settleBounceOffset } from "../src/reels/ReelView";
import { PRIMAL_REEL_IMPACT_PROGRESS } from "../src/reels/primalAnimationTiming";
import * as PrimalSpineAssets from "../src/renderer/spine/PrimalSpineAssets";
import {
  authoritativeWinLabelText,
  createWinCelebrationPlan,
  normalWinAuthoredEffectTimeScale,
  NORMAL_WIN_AUTHORED_EFFECT_TIME_SCALE,
  primalWinRecordHoldDurationMs,
  PRIMAL_NORMAL_WIN_RECORD_HOLD_MS,
  PRIMAL_WINBOX_POOL_SIZE,
  resolveWinLabelTextAttachment,
  readableWinLabelTextTransform,
  WinCelebration,
  WinLabelAnimationController,
  WIN_LABEL_AUTHORED_TIMELINE_MS,
  WIN_LABEL_TEXT_SLOTS,
  winCelebrationDuration,
  winCelebrationFrame,
  winLabelGoldTextStyle,
  winLabelInfoTextStyle,
  winLabelMergeFrame,
  winLabelValue,
  type WinCelebrationMilestone,
  type WinCelebrationResidentFacts,
  type WinRecordPlan,
} from "../src/renderer/WinCelebration";

const wins: readonly Win[] = [
  {
    id: "server-win-a",
    symbol: "ORBIT",
    nominalAmountMinor: "1000",
    amountMinor: "1000",
    ways: 2,
    multiplier: 5,
    cells: [
      { reel: 0, row: 1 }, { reel: 1, row: 1 },
      { reel: 2, row: 1 }, { reel: 2, row: 2 },
    ],
    pathAwards: [
      {
        multiplier: 5,
        baseAmountMinor: "100",
        nominalAmountMinor: "500",
        amountMinor: "500",
        cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 1 }],
      },
      {
        multiplier: 5,
        baseAmountMinor: "100",
        nominalAmountMinor: "500",
        amountMinor: "500",
        cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }, { reel: 2, row: 2 }],
      },
    ],
  },
];

const plainWins: readonly Win[] = [{
  id: "plain-server-win",
  symbol: "TANK",
  nominalAmountMinor: "100",
  amountMinor: "100",
  ways: 1,
  cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
}];

const multipliedHandoffWins: readonly Win[] = [
  {
    id: "prism-x2",
    symbol: "PRISM",
    nominalAmountMinor: "40",
    amountMinor: "40",
    ways: 2,
    multiplier: 2,
    cells: [
      { reel: 0, row: 0 },
      { reel: 1, row: 0 },
      { reel: 2, row: 0 },
      { reel: 2, row: 1 },
    ],
  },
  {
    id: "orbit-x2",
    symbol: "ORBIT",
    nominalAmountMinor: "60",
    amountMinor: "60",
    ways: 1,
    multiplier: 2,
    cells: [
      { reel: 0, row: 2 },
      { reel: 1, row: 2 },
      { reel: 2, row: 2 },
    ],
  },
];

function createWinLabelProbe(
  record: Readonly<WinRecordPlan>,
  onCommand?: (animation: string) => void,
) {
  const initial = authoritativeWinLabelText(record.baseAmountMinor, record.ways);
  const fields = [
    {
      name: "winLabelValue" as const,
      text: { text: initial.winLabelValue },
      point: {},
      hasAuthoritativeText: true,
    },
    {
      name: "winLabelInfo" as const,
      text: { text: initial.winLabelInfo ?? "" },
      point: {},
      hasAuthoritativeText: initial.winLabelInfo !== null,
    },
    {
      name: "winLabelMultiplier" as const,
      text: { text: initial.winLabelMultiplier ?? "" },
      point: {},
      hasAuthoritativeText: false,
    },
  ];
  const commands: Array<Readonly<{
    animation: string;
    value: string;
    multiplier: string;
  }>> = [];
  const authoredMs = new Map<string, number>();
  let activeAnimation = "";
  const read = (name: (typeof fields)[number]["name"]): string => (
    fields.find((field) => field.name === name)?.text.text ?? ""
  );
  const capture = (animation: string): number => {
    activeAnimation = animation;
    commands.push({
      animation,
      value: read("winLabelValue"),
      multiplier: read("winLabelMultiplier"),
    });
    onCommand?.(animation);
    return 0;
  };
  let multiplierMerged = false;
  capture("show");
  const animations = {
    startMerge: () => {
      multiplierMerged = true;
      return capture("merge_start");
    },
    endMerge: () => capture("merge_end"),
    hide: () => {
      const animation = multiplierMerged ? "hide_merged" : "hide";
      multiplierMerged = false;
      return capture(animation);
    },
  };
  return {
    commands,
    fields,
    label: { group: {}, view: {}, fields, animations },
    read,
    advance: (deltaMs: number): void => {
      authoredMs.set(activeAnimation, (authoredMs.get(activeAnimation) ?? 0) + deltaMs);
    },
    authoredMs: (animation: string): number => authoredMs.get(animation) ?? 0,
    retarget: (nextRecord: Readonly<WinRecordPlan>): void => {
      multiplierMerged = false;
      const next = authoritativeWinLabelText(nextRecord.baseAmountMinor, nextRecord.ways);
      for (const field of fields) {
        const value = next[field.name];
        field.text.text = value ?? "";
        field.hasAuthoritativeText = value !== null && value.length > 0;
      }
      capture("show");
    },
  };
}

function installFakeAnimationFrameClock(invocationAt = 1_000) {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let nowMs = invocationAt;
  vi.stubGlobal("performance", { now: () => nowMs });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextFrame++;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    callbacks.delete(handle);
  });
  return {
    callbacks,
    invocationAt,
    setNow: (timeMs: number): void => { nowMs = timeMs; },
    runFrame: (timeMs: number): void => {
      nowMs = timeMs;
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(timeMs);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function installResidentLifecycleProbe(
  celebration: WinCelebration,
  installAssets = true,
) {
  let labelProbe: ReturnType<typeof createWinLabelProbe> | null = null;
  let labelAllocations = 0;
  let framePoolAllocations = 0;
  const boxAnimationCommands: Array<Readonly<{
    index: number;
    trackIndex: number;
    animation: string;
    loop: boolean;
  }>> = [];
  const boxes = Array.from({ length: PRIMAL_WINBOX_POOL_SIZE }, (_, index) => ({
    active: false,
    ownerGeneration: 0,
    view: {
      state: {
        hasAnimation: (animation: string) => animation === "loop" || animation === "disappear",
        setAnimation: (trackIndex: number, animation: string, loop: boolean) => {
          boxAnimationCommands.push({ index, trackIndex, animation, loop });
          return { animationEnd: 1 / 3, mixDuration: 0.15 };
        },
      },
    },
  }));
  const overrides: Record<string, unknown> = {
    createTargets: () => new Map(),
    createAuthoredBoxes: () => {
      framePoolAllocations += 1;
      return boxes;
    },
    createAuthoredLabel: (_host: unknown, record: Readonly<WinRecordPlan>) => {
      labelAllocations += 1;
      const created = createWinLabelProbe(record);
      labelProbe = created;
      return created.label;
    },
    retargetAuthoredBoxes: (
      residentBoxes: typeof boxes,
      cells: readonly unknown[],
      _targets: unknown,
      _reducedMotion: boolean,
      generation: number,
    ) => {
      for (const [index, box] of residentBoxes.entries()) {
        box.active = index < cells.length;
        if (box.active) box.ownerGeneration = generation;
      }
    },
    retargetAuthoredLabel: (_label: unknown, record: Readonly<WinRecordPlan>) => {
      labelProbe?.retarget(record);
    },
    syncLabelText: () => true,
    updateAuthored: () => undefined,
  };
  if (installAssets) overrides["assets"] = { winBox: {}, winLabel: {} };
  Object.assign(celebration as unknown as Record<string, unknown>, overrides);
  return {
    boxes,
    boxAnimationCommands,
    get labelProbe() { return labelProbe; },
    get labelAllocations() { return labelAllocations; },
    get framePoolAllocations() { return framePoolAllocations; },
  };
}

describe("Primal aggregate win presentation contract", () => {
  it("keeps one visual record, one label fact set, and the union of WinBox cells", () => {
    const plan = createWinCelebrationPlan(wins);

    expect(plan.cells).toEqual([
      { reel: 0, row: 1 },
      { reel: 1, row: 1 },
      { reel: 2, row: 1 },
      { reel: 2, row: 2 },
    ]);
    expect(plan.cells[0]).not.toBe(wins[0]?.cells[0]);
    expect(plan.records).toEqual([{
      id: "server-win-a",
      symbol: "ORBIT",
      ways: 2,
      multiplier: 5,
      baseAmountMinor: "200",
      amountMinor: "1000",
      cells: [
        { reel: 0, row: 1 },
        { reel: 1, row: 1 },
        { reel: 2, row: 1 },
        { reel: 2, row: 2 },
      ],
    }]);
    expect(plan.totalAmountMinor).toBe("1000");
    expect(plan).not.toHaveProperty("lines");
  });

  it("never lets audit pathAwards split or change the aggregate visual record", () => {
    const withoutAuditPaths: Win = { ...wins[0]!, pathAwards: undefined };
    const withDifferentAuditPaths: Win = {
      ...wins[0]!,
      pathAwards: [{
        multiplier: 100,
        baseAmountMinor: "200",
        nominalAmountMinor: "1000",
        amountMinor: "1000",
        cells: [{ reel: 2, row: 2 }],
      }],
    };

    expect(createWinCelebrationPlan([withoutAuditPaths]).records)
      .toEqual(createWinCelebrationPlan([withDifferentAuditPaths]).records);
  });

  it("uses nominal path facts for the label base when the paid amount is cap-clipped", () => {
    const cappedWin: Win = {
      id: "capped-win",
      symbol: "ORBIT",
      ways: 1,
      multiplier: 5,
      nominalAmountMinor: "1000",
      amountMinor: "250",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      pathAwards: [{
        multiplier: 5,
        baseAmountMinor: "200",
        nominalAmountMinor: "1000",
        amountMinor: "250",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
    };

    expect(createWinCelebrationPlan([cappedWin])).toMatchObject({
      totalAmountMinor: "250",
      records: [{ baseAmountMinor: "200", amountMinor: "250" }],
    });
  });

  it("does not merge separately returned records", () => {
    const second: Win = {
      id: "server-win-b",
      symbol: "ORBIT",
      ways: 1,
      multiplier: 1,
      nominalAmountMinor: "300",
      amountMinor: "300",
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    };
    const plan = createWinCelebrationPlan([...wins, second]);

    expect(plan.records.map(({ id }) => id)).toEqual(["server-win-a", "server-win-b"]);
    expect(plan.records).toHaveLength(2);
    expect(plan.totalAmountMinor).toBe("1300");
  });

  it("selects multi-record holds in the official branch order", () => {
    const common = { recordCount: 2, counterDurationMs: 625 };
    expect(PRIMAL_NORMAL_WIN_RECORD_HOLD_MS).toEqual({
      multiPlain: 1_500,
      multiPlainFast: 750,
      multiMultiplier: 4_000,
      multiMultiplierFast: 3_000,
      repeatOrPostBigWinPlain: 2_000,
    });
    expect(primalWinRecordHoldDurationMs({ multiplier: 1 }, common)).toBe(1_500);
    expect(primalWinRecordHoldDurationMs({ multiplier: 5 }, common)).toBe(4_000);
    expect(primalWinRecordHoldDurationMs(
      { multiplier: 1 },
      { ...common, postBigWin: true },
    )).toBe(2_000);
    expect(primalWinRecordHoldDurationMs(
      { multiplier: 5 },
      { ...common, postBigWin: true },
    )).toBe(4_000);
    expect(primalWinRecordHoldDurationMs(
      { multiplier: 1 },
      { ...common, repeat: true },
    )).toBe(2_000);
    expect(primalWinRecordHoldDurationMs(
      { multiplier: 1 },
      { ...common, fastPlay: true },
    )).toBe(750);
    expect(primalWinRecordHoldDurationMs(
      { multiplier: 5 },
      { ...common, fastPlay: true },
    )).toBe(3_000);
    expect(primalWinRecordHoldDurationMs(
      { multiplier: 5 },
      { recordCount: 1, counterDurationMs: 625, postBigWin: true },
    )).toBe(625);
  });

  it("keeps legacy fixtures migratable as unmultiplied aggregate records", () => {
    const legacy: Win = {
      id: "legacy-win",
      symbol: "ORBIT",
      nominalAmountMinor: "500",
      amountMinor: "500",
      cells: [{ reel: 0, row: 2 }, { reel: 1, row: 1 }, { reel: 2, row: 2 }],
    };
    const [record] = createWinCelebrationPlan([legacy]).records;

    expect(record).toMatchObject({
      id: "legacy-win",
      ways: undefined,
      multiplier: 1,
      baseAmountMinor: "500",
      amountMinor: "500",
    });
  });

  it("never creates a cue when the authoritative win list is empty", () => {
    expect(createWinCelebrationPlan([])).toEqual({
      cells: [], records: [], totalAmountMinor: "0",
    });
  });

  it("contains no line or traveling-shine presentation state", () => {
    const frame = winCelebrationFrame();
    expect(frame.labelAlpha).toBe(1);
    expect(frame).not.toHaveProperty("lineAlpha");
    expect(frame).not.toHaveProperty("shineProgress");
  });

  it("runs normal authored effects at 1.0 and makes reduced motion terminal", () => {
    expect(NORMAL_WIN_AUTHORED_EFFECT_TIME_SCALE).toBe(1);
    expect(normalWinAuthoredEffectTimeScale(false)).toBe(1);
    expect(normalWinAuthoredEffectTimeScale(true)).toBe(100);
    expect(normalWinAuthoredEffectTimeScale(false)).toBeGreaterThan(0);
    expect(normalWinAuthoredEffectTimeScale(false)).toBeLessThanOrEqual(1);
  });

  it("drops a negative Spine determinant without mirroring WinLabel glyphs", () => {
    const transform = readableWinLabelTextTransform({
      a: 0.806,
      b: 0.012,
      c: 0.012,
      d: -0.806,
    }, 0.5);
    expect(transform.rotation).toBeCloseTo(Math.atan2(0.012, 0.806), 12);
    expect(transform.scaleX).toBeCloseTo(Math.hypot(0.806, 0.012) * 0.5, 12);
    expect(transform.scaleY).toBeCloseTo(Math.hypot(0.012, -0.806) * 0.5, 12);
    expect(transform.scaleY).toBeGreaterThan(0);
    expect(readableWinLabelTextTransform({ a: 1, b: 0, c: 0, d: -1 }, -0.5).scaleY)
      .toBe(0.5);
  });

  it("formats the authoritative total in minor units without floating point", () => {
    expect(winLabelValue("5")).toBe("0.05");
    expect(winLabelValue("1250")).toBe("12.50");
    expect(winLabelValue("90071992547409931234")).toBe("900719925474099312.34");
  });

  it("uses the captured singular, plural, BONUS, and multiplier copy", () => {
    expect(WIN_LABEL_TEXT_SLOTS).toEqual([
      "winLabelValue",
      "winLabelInfo",
      "winLabelMultiplier",
    ]);
    expect(authoritativeWinLabelText("100", 1, 1)).toEqual({
      winLabelValue: "1.00",
      winLabelInfo: "1 WAY WON",
      winLabelMultiplier: null,
    });
    expect(authoritativeWinLabelText("1000", 2, 5)).toEqual({
      winLabelValue: "10.00",
      winLabelInfo: "2 WAYS WON",
      winLabelMultiplier: " x5",
    });
    expect(authoritativeWinLabelText("1000", -1)).toEqual({
      winLabelValue: "10.00",
      winLabelInfo: "BONUS won!",
      winLabelMultiplier: null,
    });
    expect(authoritativeWinLabelText("1000")).toEqual({
      winLabelValue: "10.00",
      winLabelInfo: null,
      winLabelMultiplier: null,
    });
  });

  it("follows complete authored show, merge_start, and merge_end clips", () => {
    const record = createWinCelebrationPlan(wins).records[0]!;
    expect(WIN_LABEL_AUTHORED_TIMELINE_MS).toEqual({
      showDuration: 333.333343,
      mergeStartAt: 333.333343,
      mergeStartDuration: 1_333.300114,
      mergeEndAt: 1_666.633457,
      mergeEndDuration: 500,
      complete: 2_166.633457,
      hideDuration: 333.333343,
    });
    expect(winLabelMergeFrame(record, 0)).toEqual({
      phase: "base", amountMinor: "200", animation: "show", complete: false,
    });
    expect(winLabelMergeFrame(record, 333.333342)).toMatchObject({
      phase: "base", animation: "show",
    });
    expect(winLabelMergeFrame(record, 333.333343)).toEqual({
      phase: "merging", amountMinor: "200", animation: "merge_start", complete: false,
    });
    expect(winLabelMergeFrame(record, 1_666.633456)).toMatchObject({
      phase: "merging", amountMinor: "200", animation: "merge_start",
    });
    expect(winLabelMergeFrame(record, 1_666.633457)).toEqual({
      phase: "settled", amountMinor: "1000", animation: "merge_end", complete: false,
    });
    expect(winLabelMergeFrame(record, 2_166.633456)).toMatchObject({
      phase: "settled", animation: "merge_end", complete: false,
    });
    expect(winLabelMergeFrame(record, 2_166.633457)).toEqual({
      phase: "settled", amountMinor: "1000", animation: null, complete: true,
    });
    expect(winCelebrationDuration(false, record)).toBe(1_150);
    expect(winCelebrationDuration(false, record))
      .toBeLessThan(WIN_LABEL_AUTHORED_TIMELINE_MS.complete);
  });

  it("runs only the authored show clip for an unmultiplied record", () => {
    const record = {
      multiplier: 1,
      baseAmountMinor: "1000",
      amountMinor: "1000",
    };
    expect(winLabelMergeFrame(record, 0)).toEqual({
      phase: "settled", amountMinor: "1000", animation: "show", complete: false,
    });
    expect(winLabelMergeFrame(record, 333.333343)).toEqual({
      phase: "settled", amountMinor: "1000", animation: null, complete: true,
    });
    expect(winCelebrationDuration(true)).toBeLessThan(winCelebrationDuration(false));
  });

  it("uses the captured gold and info text styles", () => {
    const gold = winLabelGoldTextStyle();
    expect(gold.fontFamily).toContain("Primal Kanit");
    expect(gold.fontSize).toBe(60);
    expect(gold.fill).toEqual(["#e5ad42", "#e5ad42", "#fff5df", "#9e7631", "#e0af46"]);
    expect(gold.fillGradientStops).toEqual([0, 0.13, 0.6, 0.64, 0.81]);
    expect(gold.stroke).toBe("#1c1406");
    expect(gold.strokeThickness).toBe(6);
    expect(gold.dropShadowColor).toBe("#503f1a");
    expect(gold.dropShadowDistance).toBe(5);
    expect(gold.dropShadowBlur).toBe(0);

    const info = winLabelInfoTextStyle();
    expect(info.fontSize).toBe(30);
    expect(info.fill).toBe("#ffffff");
    expect(info.stroke).toBe("#221c0e");
    expect(info.strokeThickness).toBe(6);
    expect(info.dropShadowColor).toBe("#392f18");
    expect(info.dropShadowDistance).toBe(6);
    expect(info.dropShadowBlur).toBe(2);
  });

  it("resolves WinLabel text bounds from the default skin", () => {
    const bounds = { vertices: [-10, 5, 10, 5, 10, -5, -10, -5] };
    expect(resolveWinLabelTextAttachment(
      { getAttachment: (_slotIndex, name) => name === "bounds" ? bounds : null },
      { data: { index: 12 }, getAttachment: () => null },
    )).toBe(bounds);
    expect(resolveWinLabelTextAttachment(
      { getAttachment: () => null },
      { data: { index: 12 }, getAttachment: () => bounds },
    )).toBe(bounds);
  });

  it("keeps the captured animation-controller invocation order explicit", () => {
    const played: string[] = [];
    const entries: Array<{ animationEnd: number; mixDuration: number }> = [];
    const animations = new Set([
      "hidden",
      "show",
      "merge_start",
      "merge_end",
      "hide",
      "hide_merged",
    ]);
    const controller = new WinLabelAnimationController({
      hasAnimation: (name) => animations.has(name),
      setAnimation: (_track, name) => {
        played.push(name);
        const entry = {
          animationEnd: name === "hide_merged" ? 0.42 : 0.2,
          mixDuration: 0.15,
        };
        entries.push(entry);
        return entry;
      },
    });

    controller.setHidden();
    controller.show();
    expect(controller.isMultiplierMerged).toBe(false);
    controller.startMerge();
    controller.endMerge();
    expect(controller.isMultiplierMerged).toBe(true);
    expect(controller.hide()).toBe(0.42);
    expect(controller.isMultiplierMerged).toBe(false);
    expect(played).toEqual([
      "hidden",
      "show",
      "merge_start",
      "merge_end",
      "hide_merged",
    ]);

    controller.show();
    controller.hide();
    expect(played.slice(-2)).toEqual(["show", "hide"]);
    expect(entries.every(({ mixDuration }) => mixDuration === 0)).toBe(true);
  });

  it("mounts resident WinBox and WinLabel before dimming and visible without a Promise turn", async () => {
    const order: string[] = [];
    const loadArtwork = vi.fn(async () => undefined);
    const reels = {
      dimNonWinningCells: vi.fn(() => order.push("dim")),
      clearWinDimming: vi.fn(),
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(new Container(), reels as never);
    let releaseHold: () => void = () => undefined;
    Object.assign(celebration as unknown as Record<string, unknown>, {
      assets: { winBox: {}, winLabel: {} },
      loadArtwork,
      createTargets: () => new Map(),
      createAuthoredBoxes: () => {
        order.push("boxes");
        return [];
      },
      createAuthoredLabel: () => {
        order.push("label");
        return null;
      },
      updateAuthored: () => {
        order.push("authored-frame");
      },
      animate: () => new Promise<void>((resolve) => {
        releaseHold = resolve;
      }),
    });

    const presentation = celebration.present(wins, false, 2_200, (milestone) => {
      if (milestone === "visible") order.push("visible");
    });

    expect(order).toEqual(["boxes", "label", "authored-frame", "dim", "visible"]);
    expect(loadArtwork).not.toHaveBeenCalled();

    celebration.destroy();
    releaseHold();
    await presentation;
  });

  it("prebuilds one label and all 24 frames before loadArtwork resolves", async () => {
    const loadAssets = vi.spyOn(PrimalSpineAssets, "loadPrimalSpineSet")
      .mockResolvedValue({ winBox: {}, winLabel: {} } as never);
    const reels = {
      dimNonWinningCells: vi.fn(),
      clearWinDimming: vi.fn(),
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(new Container(), reels as never);
    const probe = installResidentLifecycleProbe(celebration, false);
    try {
      await celebration.loadArtwork();

      expect(loadAssets).toHaveBeenCalledOnce();
      expect(celebration.artworkLoaded).toBe(true);
      expect(probe.labelAllocations).toBe(1);
      expect(probe.framePoolAllocations).toBe(1);
      expect(probe.boxes).toHaveLength(PRIMAL_WINBOX_POOL_SIZE);
      expect((celebration as unknown as {
        resident: { boxes: readonly unknown[]; label: unknown } | null;
      }).resident).toMatchObject({
        boxes: probe.boxes,
        label: probe.labelProbe?.label,
      });

    // 此处测试的是分配标识。只替换局部时钟，避免测试在 Node 中依赖 Pixi 的 / English: What is being tested here is the assignment ID. Only replace the local clock to avoid tests that depend on Pixi in Node
    // 浏览器 RAF 填充实现。 / English: Browser RAF padding implementation.
      Object.assign(celebration as unknown as Record<string, unknown>, {
        animate: async () => undefined,
      });
      await celebration.present([multipliedHandoffWins[0]!], false, 4_000);
      await flushMicrotasks();
      expect(probe.labelAllocations).toBe(1);
      expect(probe.framePoolAllocations).toBe(1);

      await celebration.present([multipliedHandoffWins[1]!], false, 4_000);
      await flushMicrotasks();
      expect(probe.labelAllocations).toBe(1);
      expect(probe.framePoolAllocations).toBe(1);
    } finally {
      celebration.destroy();
      loadAssets.mockRestore();
    }
  });

  it("rolls back a partial eager allocation and keeps loadArtwork retryable", async () => {
    const loadAssets = vi.spyOn(PrimalSpineAssets, "loadPrimalSpineSet")
      .mockResolvedValue({ winBox: {}, winLabel: {} } as never);
    const reels = {
      dimNonWinningCells: vi.fn(),
      clearWinDimming: vi.fn(),
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(new Container(), reels as never);
    const probe = installResidentLifecycleProbe(celebration, false);
    const internals = celebration as unknown as Record<string, unknown>;
    const allocateFrames = internals["createAuthoredBoxes"] as (
      ...args: unknown[]
    ) => unknown;
    let failFirstAllocation = true;
    let partial: Container | null = null;
    internals["createAuthoredBoxes"] = (host: Container, ...args: unknown[]) => {
      if (failFirstAllocation) {
        failFirstAllocation = false;
        partial = new Container();
        host.addChild(partial);
        throw new Error("injected resident allocation failure");
      }
      return allocateFrames(host, ...args);
    };
    try {
      await expect(celebration.loadArtwork()).rejects.toThrow(
        "injected resident allocation failure",
      );
      await flushMicrotasks();

      expect(celebration.artworkLoaded).toBe(false);
      expect((celebration as unknown as { resident: unknown }).resident).toBeNull();
      expect((partial as unknown as Container).destroyed).toBe(true);
      expect(probe.labelAllocations).toBe(0);

      await celebration.loadArtwork();
      expect(loadAssets).toHaveBeenCalledTimes(2);
      expect(celebration.artworkLoaded).toBe(true);
      expect(probe.framePoolAllocations).toBe(1);
      expect(probe.labelAllocations).toBe(1);
      expect((celebration as unknown as {
        resident: { boxes: readonly unknown[] } | null;
      }).resident?.boxes).toHaveLength(PRIMAL_WINBOX_POOL_SIZE);
    } finally {
      celebration.destroy();
      loadAssets.mockRestore();
    }
  });

  it("cleans a pre-visible generation fault without publishing a hidden record", async () => {
    const clearWinDimming = vi.fn();
    const telemetry = {
      start: vi.fn(() => ({ operationId: 91 })),
      fail: vi.fn(),
      complete: vi.fn(),
    };
    const reels = {
      dimNonWinningCells: vi.fn(),
      clearWinDimming,
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(
      new Container(),
      reels as never,
      telemetry as never,
    );
    installResidentLifecycleProbe(celebration);
    const record = createWinCelebrationPlan([multipliedHandoffWins[0]!]).records[0]!;
    (celebration as unknown as {
      ensureResidentScene(
        record: WinRecordPlan,
        reducedMotion: boolean,
        allowArtwork: boolean,
        preload: boolean,
      ): unknown;
    }).ensureResidentScene(record, false, true, true);
    Object.assign(celebration as unknown as Record<string, unknown>, {
      retargetAuthoredBoxes: () => {
        throw new Error("injected pre-visible retarget failure");
      },
    });
    const milestones: WinCelebrationMilestone[] = [];

    await expect(celebration.present(
      [multipliedHandoffWins[0]!],
      false,
      4_000,
      (milestone) => { milestones.push(milestone); },
    )).rejects.toThrow("injected pre-visible retarget failure");

    const resident = (celebration as unknown as {
      resident: {
        activeGeneration: number;
        activeBoxCount: number;
        pendingCleanupCount: number;
        presentationCount: number;
        artworkPreparedForRecord: boolean;
        scene: Container;
        boxScene: Container;
      } | null;
    }).resident;
    expect(milestones).toEqual([]);
    expect(milestones).not.toContain("hidden");
    expect(resident).toMatchObject({
      activeGeneration: 0,
      activeBoxCount: 0,
      pendingCleanupCount: 0,
      presentationCount: 0,
      artworkPreparedForRecord: false,
    });
    expect(resident?.scene.visible).toBe(false);
    expect(resident?.boxScene.visible).toBe(false);
    expect(clearWinDimming).toHaveBeenCalledOnce();
    expect(telemetry.fail).toHaveBeenCalledOnce();
    expect(telemetry.complete).not.toHaveBeenCalled();
    celebration.destroy();
  });

  it("runs the delayed multiplier program on exact invocation-based RAF boundaries", async () => {
    const clock = installFakeAnimationFrameClock();
    try {
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearHighlights: vi.fn(),
        clearWinDimming: vi.fn(),
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      let probe: ReturnType<typeof createWinLabelProbe> | null = null;
      const mergeBoundaryOrder: string[] = [];
      Object.assign(celebration as unknown as Record<string, unknown>, {
        assets: { winBox: {}, winLabel: {} },
        createTargets: () => new Map(),
        createAuthoredBoxes: () => [],
        createAuthoredLabel: (_host: unknown, record: Readonly<WinRecordPlan>) => {
          probe = createWinLabelProbe(record, (animation) => {
            if (animation === "merge_start") mergeBoundaryOrder.push("startMerge");
          });
          return probe.label;
        },
        syncLabelText: () => true,
        updateAuthored: () => undefined,
      });
      const milestones: WinCelebrationMilestone[] = [];
      const presentation = celebration.present(wins, false, 4_000, (milestone) => {
        milestones.push(milestone);
        if (milestone === "merge-start") {
          mergeBoundaryOrder.push(`notify:${probe?.read("winLabelMultiplier") ?? ""}`);
        }
      });

      expect(probe).not.toBeNull();
      expect(probe!.read("winLabelValue")).toBe("2.00");
      expect(probe!.read("winLabelMultiplier")).toBe("");
      expect(probe!.commands).toEqual([{
        animation: "show", value: "2.00", multiplier: "",
      }]);
      expect(milestones).toEqual(["visible"]);

      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartAt - 0.001);
      expect(probe!.read("winLabelMultiplier")).toBe("");
      expect(milestones).toEqual(["visible"]);

      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartAt);
      expect(probe!.commands.at(-1)).toEqual({
        animation: "merge_start", value: "2.00", multiplier: " x5",
      });
      expect(milestones).toEqual(["visible", "show-complete", "merge-start"]);
      expect(mergeBoundaryOrder).toEqual(["notify: x5", "startMerge"]);

      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndAt - 0.001);
      expect(probe!.read("winLabelValue")).toBe("2.00");
      expect(milestones).toEqual(["visible", "show-complete", "merge-start"]);

      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndAt);
      expect(probe!.commands.at(-1)).toEqual({
        animation: "merge_end", value: "10.00", multiplier: " x5",
      });
      expect(milestones).toEqual(["visible", "show-complete", "merge-start"]);

      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.complete - 0.001);
      expect(milestones).toEqual(["visible", "show-complete", "merge-start"]);
      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.complete);
      expect(milestones).toEqual([
        "visible",
        "show-complete",
        "merge-start",
        "merge-settled",
      ]);

      clock.runFrame(clock.invocationAt + 4_000);
      await flushMicrotasks();
      expect(probe!.commands.at(-1)?.animation).toBe("hide_merged");
      expect(milestones).toEqual([
        "visible",
        "show-complete",
        "merge-start",
        "merge-settled",
        "hold-complete",
        "hide-start",
      ]);

      clock.runFrame(
        clock.invocationAt + 4_000 + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration,
      );
      await flushMicrotasks();
      await presentation;
      expect(probe!.commands.map(({ animation }) => animation)).toEqual([
        "show",
        "merge_start",
        "merge_end",
        "hide_merged",
      ]);
      expect(milestones).toEqual([
        "visible",
        "show-complete",
        "merge-start",
        "merge-settled",
        "hold-complete",
        "hide-start",
        "hidden",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["Normal", PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplier],
    ["Fast", PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplierFast],
  ] as const)("uses the caller-owned %s multiplier HOLD without appending hide time", async (
    _mode,
    holdDurationMs,
  ) => {
    const clock = installFakeAnimationFrameClock();
    try {
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearHighlights: vi.fn(),
        clearWinDimming: vi.fn(),
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      installResidentLifecycleProbe(celebration);
      const milestones: WinCelebrationMilestone[] = [];
      const presentation = celebration.present(
        [multipliedHandoffWins[0]!],
        false,
        holdDurationMs,
        (milestone) => { milestones.push(milestone); },
      );

      clock.runFrame(clock.invocationAt + holdDurationMs - 0.001);
      expect(milestones).not.toContain("hold-complete");
      clock.runFrame(clock.invocationAt + holdDurationMs);
      await flushMicrotasks();
      await presentation;

      expect(milestones.slice(-2)).toEqual(["hold-complete", "hide-start"]);
      expect(milestones).not.toContain("hidden");
      expect(clock.callbacks.size).toBe(1);
      celebration.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a single-record idle repeat resident until requestFinish", async () => {
    const clock = installFakeAnimationFrameClock();
    try {
      const dimNonWinningCells = vi.fn();
      const highlight = vi.fn();
      const clearHighlights = vi.fn();
      const clearWinDimming = vi.fn();
      const reels = {
        dimNonWinningCells,
        highlight,
        clearHighlights,
        clearWinDimming,
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      const probe = installResidentLifecycleProbe(celebration);
      const milestones: WinCelebrationMilestone[] = [];
      let logicalPresentationComplete = false;
      const presentation = celebration.present(
        plainWins,
        false,
        Number.POSITIVE_INFINITY,
        (milestone) => { milestones.push(milestone); },
      ).then(() => { logicalPresentationComplete = true; });

      const resident = (celebration as unknown as {
        resident: {
          activeGeneration: number;
          activeBoxCount: number;
          pendingCleanupCount: number;
          scene: Container;
          boxScene: Container;
        } | null;
      }).resident;

      expect(milestones).toEqual(["visible"]);
      expect(dimNonWinningCells).toHaveBeenCalledOnce();
      expect(dimNonWinningCells).toHaveBeenCalledWith(plainWins[0]!.cells);
    // 空闲重复演出是官方强调路径：它会调暗未中奖符号，但绝不能再次发出首次 / English: The idle repeat is the official highlight path: it dims unwinn symbols but can never be issued again for the first time
    // 展示的符号赢分或高亮命令。 / English: Revealed symbols win points or highlight commands.
      expect(highlight).not.toHaveBeenCalled();
      expect(clearHighlights).not.toHaveBeenCalled();
      expect(clearWinDimming).not.toHaveBeenCalled();
      expect(resident).toMatchObject({
        activeBoxCount: 3,
        pendingCleanupCount: 0,
      });
      expect(resident?.activeGeneration).toBeGreaterThan(0);
      expect(resident?.scene.visible).toBe(true);
      expect(resident?.boxScene.visible).toBe(true);
      expect(clock.callbacks.size).toBe(1);

    // Infinity 是语义哨兵值，而不是极大的有限超时。无论将墙上时钟推进多大的 / English: Infinity is a semantic sentinel value, not a huge finite timeout. No matter how far you push the wall clock
    // 有限值，都必须让同一个驻留代次保持活动，且绝不能发布 HOLD/hide。 / English: Finite value, both must keep the same resident generation active, and HOLD/hide must never be issued.
      const finiteTimes = [
        clock.invocationAt + 16,
        clock.invocationAt + 60_000,
        clock.invocationAt + 86_400_000,
      ];
      for (const timeMs of finiteTimes) {
        clock.runFrame(timeMs);
        await flushMicrotasks();
        expect(milestones).toEqual(["visible"]);
        expect(logicalPresentationComplete).toBe(false);
        expect(resident).toMatchObject({
          activeBoxCount: 3,
          pendingCleanupCount: 0,
        });
        expect(resident?.scene.visible).toBe(true);
        expect(resident?.boxScene.visible).toBe(true);
        expect(clock.callbacks.size).toBe(1);
      }
      expect(probe.labelProbe?.commands.map(({ animation }) => animation)).toEqual([
        "show",
      ]);
      expect(dimNonWinningCells).toHaveBeenCalledOnce();
      expect(highlight).not.toHaveBeenCalled();
      expect(clearHighlights).not.toHaveBeenCalled();
      expect(clearWinDimming).not.toHaveBeenCalled();

      const hideStartedAt = finiteTimes.at(-1)!;
      expect(celebration.requestFinish()).toBe(true);
      await flushMicrotasks();
      await presentation;

    // 跨越逻辑边界无需额外 RAF：Continue 会取消无限 HOLD，并立即开始预设退出。 / English: No additional RAF is required to cross logical boundaries: Continue cancels the infinite HOLD and starts the preset exit immediately.
      expect(logicalPresentationComplete).toBe(true);
      expect(milestones).toEqual(["visible", "hide-start"]);
      expect(milestones).not.toContain("hold-complete");
      expect(probe.labelProbe?.commands.map(({ animation }) => animation)).toEqual([
        "show",
        "hide",
      ]);
      expect(clearHighlights).toHaveBeenCalledOnce();
      expect(clearWinDimming).toHaveBeenCalledOnce();
      expect(clearWinDimming).toHaveBeenCalledWith(true);
      expect(highlight).not.toHaveBeenCalled();
      expect(resident).toMatchObject({
        activeBoxCount: 3,
        pendingCleanupCount: 1,
      });
      expect(resident?.scene.visible).toBe(true);
      expect(resident?.boxScene.visible).toBe(true);
      expect(clock.callbacks.size).toBe(1);

      clock.runFrame(
        hideStartedAt + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration - 0.001,
      );
      await flushMicrotasks();
      expect(milestones).toEqual(["visible", "hide-start"]);
      expect(resident?.scene.visible).toBe(true);
      expect(resident?.boxScene.visible).toBe(true);

      clock.runFrame(
        hideStartedAt + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration + 0.001,
      );
      await flushMicrotasks();
      expect(milestones).toEqual(["visible", "hide-start", "hidden"]);
      expect(resident).toMatchObject({
        activeGeneration: 0,
        activeBoxCount: 0,
        pendingCleanupCount: 0,
      });
      expect(resident?.scene.visible).toBe(false);
      expect(resident?.boxScene.visible).toBe(false);
      expect(clock.callbacks.size).toBe(0);
      celebration.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses one label and one 24-frame pool across a zero-delay 4-to-3 box handoff", async () => {
    const clock = installFakeAnimationFrameClock();
    try {
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearWinDimming: vi.fn(),
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      const probe = installResidentLifecycleProbe(celebration);
      const events: Array<Readonly<{
        milestone: WinCelebrationMilestone;
        recordId: string;
        resident: Readonly<WinCelebrationResidentFacts>;
      }>> = [];
      const observe = (
        milestone: WinCelebrationMilestone,
        record: Readonly<WinRecordPlan>,
        resident: Readonly<WinCelebrationResidentFacts>,
      ): void => {
        events.push({ milestone, recordId: record.id, resident: { ...resident } });
      };
      const holdMs = PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplier;

      const firstPresentation = celebration.present(
        [multipliedHandoffWins[0]!],
        false,
        holdMs,
        observe,
        false,
        true,
      );
      clock.runFrame(clock.invocationAt + holdMs);
      await flushMicrotasks();
      await firstPresentation;

      const firstVisible = events.find((event) => (
        event.recordId === "prism-x2" && event.milestone === "visible"
      ));
      const firstHideStart = events.find((event) => (
        event.recordId === "prism-x2" && event.milestone === "hide-start"
      ));
      expect(firstVisible?.resident).toMatchObject({
        framePoolSize: 24,
        activeBoxCount: 4,
        activeOwnerCount: 1,
        pendingCleanupCount: 0,
        viewReused: false,
      });
      expect(firstHideStart?.resident).toMatchObject({
        activeBoxCount: 4,
        activeOwnerCount: 1,
        pendingCleanupCount: 1,
        handoffDelayMs: 0,
      });
      expect(clock.callbacks.size).toBe(1);

    // 刻意让可观察的墙上时钟经过真实 Promise 轮次。驻留诊断报告的是调度器的 / English: Deliberately letting the observable wall clock go through real Promise rounds. Resident diagnostics report the scheduler's
    // H+0 边界，而非偶然产生的微任务或检查延迟。 / English: H+0 boundaries, not accidental microtasks or check delays.
      await Promise.resolve();
      await Promise.resolve();
      clock.setNow(clock.invocationAt + holdMs + 37);

    // 后继调用会取消第 1 代预设隐藏，并在同一调用栈中安装第 2 代 HOLD 更新器： / English: Subsequent calls cancel the generation 1 preset hiding and install the generation 2 HOLD updater in the same call stack:
    // 只使用一个 RAF，中间没有空隙。 / English: Only one RAF is used, with no gaps in between.
      const secondInvocationAt = clock.invocationAt + holdMs + 37;
      const secondPresentation = celebration.present(
        [multipliedHandoffWins[1]!],
        false,
        holdMs,
        observe,
      );
      const secondVisible = events.find((event) => (
        event.recordId === "orbit-x2" && event.milestone === "visible"
      ));
      expect(secondVisible?.resident).toMatchObject({
        generation: (firstVisible?.resident.generation ?? 0) + 1,
        labelInstanceId: firstVisible?.resident.labelInstanceId,
        framePoolInstanceId: firstVisible?.resident.framePoolInstanceId,
        framePoolSize: PRIMAL_WINBOX_POOL_SIZE,
        activeBoxCount: 3,
        activeOwnerCount: 1,
        pendingCleanupCount: 0,
        viewReused: true,
        handoffDelayMs: 0,
        staleHiddenCount: 0,
      });
      expect(clock.callbacks.size).toBe(1);
      await flushMicrotasks();
      expect(events.some((event) => (
        event.recordId === "prism-x2" && event.milestone === "hidden"
      ))).toBe(false);
      expect(probe.labelAllocations).toBe(1);
      expect(probe.framePoolAllocations).toBe(1);
      expect(probe.boxes).toHaveLength(PRIMAL_WINBOX_POOL_SIZE);

      clock.runFrame(secondInvocationAt + holdMs);
      await flushMicrotasks();
      await secondPresentation;
      const finalHideStart = events.find((event) => (
        event.recordId === "orbit-x2" && event.milestone === "hide-start"
      ));
      expect(finalHideStart?.resident.pendingCleanupCount).toBe(1);
      expect(clock.callbacks.size).toBe(1);

      clock.runFrame(
        secondInvocationAt + holdMs + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration - 0.001,
      );
      await flushMicrotasks();
      expect(events.some((event) => event.milestone === "hidden")).toBe(false);
      clock.runFrame(
        secondInvocationAt + holdMs + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration,
      );
      await flushMicrotasks();

      const hiddenEvents = events.filter((event) => event.milestone === "hidden");
      expect(hiddenEvents).toHaveLength(1);
      expect(hiddenEvents[0]).toMatchObject({
        recordId: "orbit-x2",
        resident: {
          generation: secondVisible?.resident.generation,
          activeBoxCount: 0,
          activeOwnerCount: 0,
          pendingCleanupCount: 0,
          viewReused: true,
          handoffDelayMs: 0,
          staleHiddenCount: 0,
        },
      });
      expect(events.every(({ resident }) => resident.staleHiddenCount === 0)).toBe(true);
      expect(clock.callbacks.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      name: "plain label",
      sourceWins: plainWins,
      requestAtMs: 120,
      activeBoxCount: 3,
      expectedLabelAnimations: ["show", "hide"],
      expectedMilestones: ["visible", "hide-start"],
    },
    {
      name: "merged multiplier label",
      sourceWins: wins,
      requestAtMs: WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartAt,
      activeBoxCount: 4,
      expectedLabelAnimations: ["show", "merge_start", "hide_merged"],
      expectedMilestones: ["visible", "show-complete", "merge-start", "hide-start"],
    },
  ] as const)("quick-stops an active HOLD through the authored $name hide tail", async ({
    sourceWins,
    requestAtMs,
    activeBoxCount,
    expectedLabelAnimations,
    expectedMilestones,
  }) => {
    const clock = installFakeAnimationFrameClock();
    try {
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearHighlights: vi.fn(),
        clearWinDimming: vi.fn(),
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      const probe = installResidentLifecycleProbe(celebration);
      const milestones: WinCelebrationMilestone[] = [];
      let logicalPresentationComplete = false;
      const presentation = celebration.present(
        sourceWins,
        false,
        PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplier,
        (milestone) => { milestones.push(milestone); },
      ).then(() => { logicalPresentationComplete = true; });

      clock.runFrame(clock.invocationAt + requestAtMs);
      const staleHoldCallback = [...clock.callbacks.values()][0];
      expect(staleHoldCallback).toBeTypeOf("function");

      expect(celebration.requestFinish()).toBe(true);
      await flushMicrotasks();
      await presentation;

    // CONTINUE 会在隐藏开始时结束外层记录调度器，而驻留标签和帧仍保持挂载， / English: CONTINUE ends the outer record scheduler when hiding begins, while resident tags and frames remain mounted,
    // 以完成其预设隐藏。 / English: to complete its default hiding.
      expect(logicalPresentationComplete).toBe(true);
      expect(probe.labelProbe?.commands.map(({ animation }) => animation)).toEqual(
        expectedLabelAnimations,
      );
      expect(milestones).toEqual(expectedMilestones);
      expect(milestones).not.toContain("hold-complete");
      expect(milestones).not.toContain("hidden");
      expect(probe.boxAnimationCommands.filter(({ animation }) => (
        animation === "disappear"
      ))).toEqual(Array.from({ length: activeBoxCount }, (_, index) => ({
        index,
        trackIndex: 1,
        animation: "disappear",
        loop: false,
      })));

      const resident = (celebration as unknown as {
        resident: {
          scene: Container;
          boxScene: Container;
          activeBoxCount: number;
          pendingCleanupCount: number;
        } | null;
      }).resident;
      expect(resident).not.toBeNull();
      expect(resident?.scene.visible).toBe(true);
      expect(resident?.boxScene.visible).toBe(true);
      expect(resident?.activeBoxCount).toBe(activeBoxCount);
      expect(resident?.pendingCleanupCount).toBe(1);
      expect(clock.callbacks.size).toBe(1);

    // 从已取消 HOLD 捕获的回调即使迟到也必须保持无作用，尤其不能发布合并或 / English: Callbacks captured from a canceled HOLD must remain inactive even if they are late, and in particular must not post a merge or
    // 停留里程碑，也不能替换已经运行的隐藏片段。 / English: Staying at the milestone also cannot replace hidden fragments that have already been run.
      const commandsAtHideStart = [...(probe.labelProbe?.commands ?? [])];
      const milestonesAtHideStart = [...milestones];
      staleHoldCallback?.(
        clock.invocationAt + PRIMAL_NORMAL_WIN_RECORD_HOLD_MS.multiMultiplier + 1_000,
      );
      await flushMicrotasks();
      expect(probe.labelProbe?.commands).toEqual(commandsAtHideStart);
      expect(milestones).toEqual(milestonesAtHideStart);

    // 驻留隐藏尾段持有视图期间，重复请求应为空操作：不能强制隐藏视图，也不能 / English: While the view is held by the resident hidden tail segment, repeated requests should be a no-op: the view cannot be forced to be hidden, nor can
    // 提前或重复发出结束事件。 / English: Emit the end event early or repeatedly.
      celebration.requestFinish();
      await flushMicrotasks();
      expect(resident?.scene.visible).toBe(true);
      expect(resident?.boxScene.visible).toBe(true);
      expect(milestones.filter((milestone) => milestone === "hidden")).toHaveLength(0);
      expect(clock.callbacks.size).toBe(1);

      const hideStartedAt = clock.invocationAt + requestAtMs;
      clock.runFrame(hideStartedAt + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration - 0.001);
      await flushMicrotasks();
      expect(resident?.scene.visible).toBe(true);
      expect(resident?.boxScene.visible).toBe(true);
      expect(milestones.filter((milestone) => milestone === "hidden")).toHaveLength(0);

      clock.runFrame(hideStartedAt + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration);
      await flushMicrotasks();
      expect(resident?.scene.visible).toBe(false);
      expect(resident?.boxScene.visible).toBe(false);
      expect(resident?.activeBoxCount).toBe(0);
      expect(resident?.pendingCleanupCount).toBe(0);
      expect(milestones.filter((milestone) => milestone === "hidden")).toHaveLength(1);
      expect(clock.callbacks.size).toBe(0);

      const terminalCommands = [...(probe.labelProbe?.commands ?? [])];
      const terminalMilestones = [...milestones];
      staleHoldCallback?.(hideStartedAt + 10_000);
      clock.runFrame(hideStartedAt + 10_000);
      await flushMicrotasks();
      expect(probe.labelProbe?.commands).toEqual(terminalCommands);
      expect(milestones).toEqual(terminalMilestones);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pauses on WINLABEL_SHOWN before assigning or starting the multiplier", async () => {
    const clock = installFakeAnimationFrameClock();
    try {
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearHighlights: vi.fn(),
        clearWinDimming: vi.fn(),
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      let probe: ReturnType<typeof createWinLabelProbe> | null = null;
      Object.assign(celebration as unknown as Record<string, unknown>, {
        assets: { winBox: {}, winLabel: {} },
        createTargets: () => new Map(),
        createAuthoredBoxes: () => [],
        createAuthoredLabel: (_host: unknown, record: Readonly<WinRecordPlan>) => {
          probe = createWinLabelProbe(record);
          return probe.label;
        },
        syncLabelText: () => true,
        updateAuthored: () => undefined,
      });
      let releaseShow: () => void = () => undefined;
      const showGate = new Promise<void>((resolve) => { releaseShow = resolve; });
      const milestones: WinCelebrationMilestone[] = [];
      const presentation = celebration.present(wins, false, 4_000, (milestone) => {
        milestones.push(milestone);
        return milestone === "show-complete" ? showGate : undefined;
      });

      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.showDuration);
      expect(milestones).toEqual(["visible", "show-complete"]);
      expect(probe!.read("winLabelMultiplier")).toBe("");
      expect(probe!.commands.map(({ animation }) => animation)).toEqual(["show"]);
      expect(clock.callbacks.size).toBe(0);

      releaseShow();
      for (let index = 0; index < 10 && clock.callbacks.size === 0; index += 1) {
        await Promise.resolve();
      }
      expect(clock.callbacks.size).toBe(1);
      expect(probe!.read("winLabelMultiplier")).toBe("");

    // 已释放的检查点会调度新的 RAF。赋值、通知和 merge_start 不得发生在 / English: Released checkpoints schedule new RAFs. Assignments, notifications, and merge_start must not occur in
    // Promise 释放微任务中。 / English: Promise is released in microtask.
      clock.runFrame(clock.invocationAt + WIN_LABEL_AUTHORED_TIMELINE_MS.showDuration + 100);
      expect(milestones).toEqual(["visible", "show-complete", "merge-start"]);
      expect(probe!.read("winLabelMultiplier")).toBe(" x5");
      expect(probe!.commands.map(({ animation }) => animation)).toEqual([
        "show",
        "merge_start",
      ]);

      expect(celebration.requestFinish()).toBe(true);
      await presentation;
      expect(milestones.at(-1)).toBe("hide-start");
      clock.runFrame(
        clock.invocationAt
          + WIN_LABEL_AUTHORED_TIMELINE_MS.showDuration
          + 100
          + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration,
      );
      await flushMicrotasks();
      expect(milestones.at(-1)).toBe("hidden");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reconstructs every authored clip before publishing settled on an RAF overshoot", async () => {
    const clock = installFakeAnimationFrameClock();
    try {
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearHighlights: vi.fn(),
        clearWinDimming: vi.fn(),
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      let probe: ReturnType<typeof createWinLabelProbe> | null = null;
      Object.assign(celebration as unknown as Record<string, unknown>, {
        assets: { winBox: {}, winLabel: {} },
        createTargets: () => new Map(),
        createAuthoredBoxes: () => [],
        createAuthoredLabel: (_host: unknown, record: Readonly<WinRecordPlan>) => {
          probe = createWinLabelProbe(record);
          return probe.label;
        },
        syncLabelText: () => true,
        updateAuthored: (_boxes: unknown, _label: unknown, deltaMs: number) => {
          probe?.advance(deltaMs);
        },
      });
      const milestones: WinCelebrationMilestone[] = [];
      const terminalPoses: Array<Readonly<Record<string, number>>> = [];
      const presentation = celebration.present(wins, false, 4_000, (milestone) => {
        milestones.push(milestone);
        if (milestone === "merge-settled") {
          terminalPoses.push({
            show: probe?.authoredMs("show") ?? -1,
            merge_start: probe?.authoredMs("merge_start") ?? -1,
            merge_end: probe?.authoredMs("merge_end") ?? -1,
          });
        }
      });

    // 一个延迟 RAF 会跨过全部三个片段。只有 show、merge_start 和 merge_end / English: A delayed RAF spans all three segments. Only show, merge_start and merge_end
    // 的预设时钟全部追平后，里程碑才有效。 / English: The milestone will be effective only after all the preset clocks are tied.
      clock.runFrame(clock.invocationAt + 3_000);
      expect(milestones).toEqual([
        "visible",
        "show-complete",
        "merge-start",
        "merge-settled",
      ]);
      expect(terminalPoses).toHaveLength(1);
      expect(terminalPoses[0]?.["show"]).toBeCloseTo(
        WIN_LABEL_AUTHORED_TIMELINE_MS.showDuration,
        9,
      );
      expect(terminalPoses[0]?.["merge_start"]).toBeCloseTo(
        WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartDuration,
        9,
      );
      expect(terminalPoses[0]?.["merge_end"]).toBeCloseTo(
        WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndDuration,
        9,
      );
      expect(probe!.commands.map(({ animation }) => animation)).toEqual([
        "show",
        "merge_start",
        "merge_end",
      ]);

      expect(celebration.requestFinish()).toBe(true);
      await presentation;
      expect(milestones.at(-1)).toBe("hide-start");
      clock.runFrame(
        clock.invocationAt + 3_000 + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration,
      );
      await flushMicrotasks();
      expect(milestones.at(-1)).toBe("hidden");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("time-slices a delayed Spine update without discarding authored time", () => {
    const reels = {
      dimNonWinningCells: vi.fn(),
      clearWinDimming: vi.fn(),
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(new Container(), reels as never);
    const updates: number[] = [];
    const label = {
      view: { update: (deltaSeconds: number) => updates.push(deltaSeconds) },
    };
    Object.assign(celebration as unknown as Record<string, unknown>, {
      syncLabelText: () => true,
    });

    (celebration as unknown as {
      updateAuthored(boxes: readonly unknown[], label: unknown, deltaMs: number): void;
    }).updateAuthored([], label, 500);

    expect(Math.max(...updates)).toBeLessThanOrEqual(0.064);
    expect(updates.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.5, 12);
  });

  it("interrupts every pre-settle HOLD range without late label mutations", async () => {
    const cases = [
      {
        holdDurationMs: 200,
        animations: ["show", "hide"],
        value: "2.00",
        multiplier: "",
        milestones: ["visible", "hold-complete", "hide-start", "hidden"],
      },
      {
        holdDurationMs: 1_000,
        animations: ["show", "merge_start", "hide_merged"],
        value: "2.00",
        multiplier: " x5",
        milestones: [
          "visible", "show-complete", "merge-start", "hold-complete", "hide-start", "hidden",
        ],
      },
      {
        holdDurationMs: 1_900,
        animations: ["show", "merge_start", "merge_end", "hide_merged"],
        value: "10.00",
        multiplier: " x5",
        milestones: [
          "visible", "show-complete", "merge-start", "hold-complete", "hide-start", "hidden",
        ],
      },
      {
        holdDurationMs: WIN_LABEL_AUTHORED_TIMELINE_MS.complete,
        animations: ["show", "merge_start", "merge_end", "hide_merged"],
        value: "10.00",
        multiplier: " x5",
        milestones: [
          "visible", "show-complete", "merge-start", "hold-complete", "hide-start", "hidden",
        ],
      },
    ] as const;

    for (const expected of cases) {
      const clock = installFakeAnimationFrameClock();
      try {
        const reels = {
          dimNonWinningCells: vi.fn(),
          clearWinDimming: vi.fn(),
          getCellPresentationBounds: () => null,
        };
        const celebration = new WinCelebration(new Container(), reels as never);
        let probe: ReturnType<typeof createWinLabelProbe> | null = null;
        Object.assign(celebration as unknown as Record<string, unknown>, {
          assets: { winBox: {}, winLabel: {} },
          createTargets: () => new Map(),
          createAuthoredBoxes: () => [],
          createAuthoredLabel: (_host: unknown, record: Readonly<WinRecordPlan>) => {
            probe = createWinLabelProbe(record);
            return probe.label;
          },
          syncLabelText: () => true,
          updateAuthored: () => undefined,
        });
        const milestones: WinCelebrationMilestone[] = [];
        const presentation = celebration.present(
          wins,
          false,
          expected.holdDurationMs,
          (milestone) => { milestones.push(milestone); },
        );

    // 在 H 之后很久才交付首个 RAF。渲染器只能重建边界早于 H 的预设转换； / English: The first RAF was delivered long after the H . The renderer can only reconstruct preset transformations whose boundaries are earlier than H;
    // 绝不能因超调而泄漏 merge-settled 或其他更晚的转换。 / English: Merge-settled or other later transformations must not leak due to overshoot.
        const overshootAt = clock.invocationAt + expected.holdDurationMs + 5_000;
        clock.runFrame(overshootAt);
        await flushMicrotasks();
        clock.runFrame(overshootAt + WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration);
        await flushMicrotasks();
        await presentation;

        expect(probe).not.toBeNull();
        expect(probe!.commands.map(({ animation }) => animation)).toEqual(expected.animations);
        expect(probe!.read("winLabelValue")).toBe(expected.value);
        expect(probe!.read("winLabelMultiplier")).toBe(expected.multiplier);
        expect(milestones).toEqual(expected.milestones);

        const terminalCommands = [...probe!.commands];
        const terminalMilestones = [...milestones];
        clock.runFrame(clock.invocationAt + 3_000);
        await flushMicrotasks();
        expect(probe!.commands).toEqual(terminalCommands);
        expect(milestones).toEqual(terminalMilestones);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("emits the mounted, merge, hold, and cleanup milestones exactly once", async () => {
    const reels = {
      dimNonWinningCells: () => undefined,
      clearWinDimming: () => undefined,
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(new Container(), reels as never);
    let animationIndex = 0;
    Object.assign(celebration as unknown as Record<string, unknown>, {
      loadArtwork: async () => undefined,
      startDisappear: () => 0,
      animate: async (
        _durationMs: number,
        onFrame: (progress: number, deltaMs: number, elapsedMs: number) => void,
      ) => {
        animationIndex += 1;
        if (animationIndex === 1) {
          onFrame(0, 0, 0);
          onFrame(0.2, 16, WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartAt);
          onFrame(0.8, 16, WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndAt);
          onFrame(1, 16, WIN_LABEL_AUTHORED_TIMELINE_MS.complete);
        } else {
          onFrame(1, 0, 0);
        }
      },
    });
    const milestones: WinCelebrationMilestone[] = [];
    const records: Readonly<WinRecordPlan>[] = [];

    await celebration.present(wins, false, 2_200, (milestone, record) => {
      milestones.push(milestone);
      records.push(record);
      if (milestone === "merge-start") throw new Error("observer failure");
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(milestones).toEqual([
      "visible",
      "show-complete",
      "merge-start",
      "merge-settled",
      "hold-complete",
      "hide-start",
      "hidden",
    ]);
    expect(records.every((record) => record.id === "server-win-a")).toBe(true);
    expect(celebration.view.children).toHaveLength(1);
  });

  it("cleans a continued or destroyed record without hold-complete or duplicate callbacks", async () => {
    const runInterrupted = async (action: "continue" | "destroy") => {
      const reels = {
        dimNonWinningCells: () => undefined,
        clearHighlights: () => undefined,
        clearWinDimming: () => undefined,
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      const animations = (celebration as unknown as {
        animations: Set<{ handle: null; finish(): void }>;
      }).animations;
      let holdStarted = false;
      Object.assign(celebration as unknown as Record<string, unknown>, {
        loadArtwork: async () => undefined,
        animate: (
          _durationMs: number,
          onFrame: (progress: number, deltaMs: number, elapsedMs: number) => void,
        ) => {
          holdStarted = true;
          onFrame(0, 0, 0);
          return new Promise<void>((resolve) => {
            const animation = {
              handle: null,
              finish: () => {
                animations.delete(animation);
                resolve();
              },
            };
            animations.add(animation);
          });
        },
      });
      const milestones: WinCelebrationMilestone[] = [];
      const presentation = celebration.present(
        wins,
        false,
        4_000,
        (milestone) => milestones.push(milestone),
      );
      while (!holdStarted) await Promise.resolve();

      if (action === "continue") {
        expect(celebration.requestFinish()).toBe(true);
        expect(celebration.requestFinish()).toBe(false);
      } else {
        celebration.destroy();
        celebration.destroy();
      }
      await presentation;
      await Promise.resolve();

      if (action === "continue") {
        expect(milestones).toEqual(["visible", "hide-start"]);
        expect(animations.size).toBe(1);
        animations.values().next().value?.finish();
        await flushMicrotasks();
        expect(milestones).toEqual(["visible", "hide-start", "hidden"]);
      } else {
        expect(milestones).toEqual(["visible", "hidden"]);
      }
      expect(animations.size).toBe(0);
      expect(celebration.view.children).toHaveLength(action === "destroy" ? 0 : 1);
    };

    await runInterrupted("continue");
    await runInterrupted("destroy");
  });

  it("does not start the record clock until an async visible checkpoint releases", async () => {
    const reels = {
      dimNonWinningCells: () => undefined,
      clearWinDimming: () => undefined,
      getCellPresentationBounds: () => null,
    };
    const celebration = new WinCelebration(new Container(), reels as never);
    const animate = vi.fn(async (
      durationMs: number,
      onFrame: (progress: number, deltaMs: number, elapsedMs: number) => void,
    ) => onFrame(1, 0, durationMs));
    Object.assign(celebration as unknown as Record<string, unknown>, {
      loadArtwork: async () => undefined,
      startDisappear: () => 0,
      animate,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const milestones: WinCelebrationMilestone[] = [];

    const presentation = celebration.present(wins, false, 2_200, (milestone) => {
      milestones.push(milestone);
      return milestone === "visible" ? gate : undefined;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(milestones).toEqual(["visible"]);
    expect(animate).not.toHaveBeenCalled();

    release();
    await presentation;
    await Promise.resolve();
    expect(animate).toHaveBeenCalled();
    expect(milestones.at(-1)).toBe("hidden");
  });

  it("ends a plain single-record hold at invocation plus D and restores symbols after its gate", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const invocationAt = 1_000;
    const holdDurationMs = 500;
    vi.stubGlobal("performance", { now: () => invocationAt });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextFrame++;
      callbacks.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      callbacks.delete(handle);
    });
    const runFrame = (timeMs: number): void => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(timeMs);
    };
    const flushMicrotasks = async (): Promise<void> => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };

    try {
      const teardownOrder: string[] = [];
      const clearHighlights = vi.fn(() => teardownOrder.push("symbols"));
      const clearWinDimming = vi.fn((progressiveRestore?: boolean) => {
        teardownOrder.push(`dimming:${String(progressiveRestore)}`);
      });
      const reels = {
        dimNonWinningCells: vi.fn(),
        clearHighlights,
        clearWinDimming,
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      const startDisappear = vi.fn(() => {
        teardownOrder.push("box-label");
        return 0;
      });
      Object.assign(celebration as unknown as Record<string, unknown>, {
        assets: { winBox: {}, winLabel: {} },
        createTargets: () => new Map(),
        createAuthoredBoxes: () => [],
        createAuthoredLabel: () => null,
        updateAuthored: () => undefined,
        startDisappear,
      });
      let releaseHold: () => void = () => undefined;
      const holdGate = new Promise<void>((resolve) => { releaseHold = resolve; });
      const milestones: WinCelebrationMilestone[] = [];

      const presentation = celebration.present(
        plainWins,
        false,
        holdDurationMs,
        (milestone) => {
          milestones.push(milestone);
          return milestone === "hold-complete" ? holdGate : undefined;
        },
        true,
      );

      expect(milestones).toEqual(["visible"]);
      expect(callbacks.size).toBe(1);
      runFrame(invocationAt + 16);
      runFrame(invocationAt + holdDurationMs - 1);
      await flushMicrotasks();
      expect(milestones).toEqual(["visible"]);
      expect(startDisappear).not.toHaveBeenCalled();

    // 首个 RAF 并非合成的 t=0：停留会在调用时刻+D 结束。 / English: The first RAF is not synthetic t=0: the dwell ends at the calling time +D.
      runFrame(invocationAt + holdDurationMs);
      await flushMicrotasks();
      expect(milestones).toEqual(["visible", "hold-complete"]);
      expect(clearHighlights).not.toHaveBeenCalled();
      expect(clearWinDimming).not.toHaveBeenCalled();
      expect(startDisappear).not.toHaveBeenCalled();

      releaseHold();
      await flushMicrotasks();
      expect(teardownOrder).toEqual(["box-label", "symbols", "dimming:true"]);
      expect(clearHighlights).toHaveBeenCalledOnce();
      expect(clearWinDimming).toHaveBeenCalledOnce();
      expect(clearWinDimming).toHaveBeenCalledWith(true);
      expect(startDisappear).toHaveBeenCalledOnce();

      runFrame(invocationAt + holdDurationMs + 1);
      await flushMicrotasks();
      await presentation;
      expect(milestones).toEqual(["visible", "hold-complete", "hide-start", "hidden"]);
      expect(clearWinDimming).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps Continue behind the release gate and lets destroy cancel the gate", async () => {
    const run = async (action: "continue" | "destroy") => {
      const reels = {
        dimNonWinningCells: () => undefined,
        clearHighlights: () => undefined,
        clearWinDimming: () => undefined,
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      const animate = vi.fn(async () => undefined);
      Object.assign(celebration as unknown as Record<string, unknown>, {
        loadArtwork: async () => undefined,
        animate,
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const milestones: WinCelebrationMilestone[] = [];
      let completed = false;
      const presentation = celebration.present(wins, false, 4_000, (milestone) => {
        milestones.push(milestone);
        return milestone === "visible" ? gate : undefined;
      }).then(() => { completed = true; });
      await Promise.resolve();
      await Promise.resolve();

      if (action === "continue") {
        expect(celebration.requestFinish()).toBe(true);
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(celebration.view.children).toHaveLength(1);
        release();
      } else {
        celebration.destroy();
      }
      await presentation;

      expect(animate).not.toHaveBeenCalled();
      expect(milestones).toEqual(["visible", "hidden"]);
      expect(celebration.view.children).toHaveLength(action === "destroy" ? 0 : 1);
    };

    await run("continue");
    await run("destroy");
  });

  it("freezes the authored hold clock while merge-settled is awaiting release", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("performance", { now: () => 0 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextFrame++;
      callbacks.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      callbacks.delete(handle);
    });
    const runFrame = (timeMs: number): void => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(timeMs);
    };

    try {
      const reels = {
        dimNonWinningCells: () => undefined,
        clearHighlights: () => undefined,
        clearWinDimming: () => undefined,
        getCellPresentationBounds: () => null,
      };
      const celebration = new WinCelebration(new Container(), reels as never);
      Object.assign(celebration as unknown as Record<string, unknown>, {
        loadArtwork: async () => undefined,
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const milestones: WinCelebrationMilestone[] = [];
      const presentation = celebration.present(wins, false, 4_000, (milestone) => {
        milestones.push(milestone);
        return milestone === "merge-settled" ? gate : undefined;
      });
      await Promise.resolve();
      await Promise.resolve();

      runFrame(0);
      runFrame(WIN_LABEL_AUTHORED_TIMELINE_MS.mergeStartAt);
      runFrame(WIN_LABEL_AUTHORED_TIMELINE_MS.mergeEndAt);
      expect(milestones).toEqual(["visible", "show-complete", "merge-start"]);
      expect(callbacks.size).toBe(1);

      runFrame(WIN_LABEL_AUTHORED_TIMELINE_MS.complete);
      expect(milestones).toEqual([
        "visible",
        "show-complete",
        "merge-start",
        "merge-settled",
      ]);
      expect(callbacks.size).toBe(0);

      release();
      for (let index = 0; index < 10 && callbacks.size === 0; index += 1) {
        await Promise.resolve();
      }
      expect(callbacks.size).toBe(1);

      expect(celebration.requestFinish()).toBe(true);
      await presentation;
      expect(milestones).toEqual([
        "visible",
        "show-complete",
        "merge-start",
        "merge-settled",
        "hide-start",
      ]);
      runFrame(WIN_LABEL_AUTHORED_TIMELINE_MS.hideDuration);
      await flushMicrotasks();
      expect(milestones.at(-1)).toBe("hidden");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reel inertial settle", () => {
  it("uses the captured positive cubic bounce and never counter-bounces above rest", () => {
    const peak = PRIMAL_REEL_IMPACT_PROGRESS + (1 - PRIMAL_REEL_IMPACT_PROGRESS) / 3;
    expect(settleBounceOffset(0)).toBe(0);
    expect(settleBounceOffset(PRIMAL_REEL_IMPACT_PROGRESS)).toBe(0);
    expect(settleBounceOffset(peak)).toBeCloseTo(7.777_777_8, 6);
    expect(settleBounceOffset(0.9)).toBeGreaterThanOrEqual(0);
    expect(settleBounceOffset(1)).toBeCloseTo(0);
  });

  it("removes directional blur as the authoritative grid settles", () => {
    expect(settleBlurStrength(0)).toBe(7.5);
    expect(settleBlurStrength(0.3)).toBeGreaterThan(0);
    expect(settleBlurStrength(PRIMAL_REEL_IMPACT_PROGRESS)).toBe(0);
    expect(settleBlurStrength(1)).toBe(0);
  });
});
