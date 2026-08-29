import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { GridCell, SpinResult } from "../src/app/state/types";
import {
  SymbolView,
  authoredCellVariantAnimation,
  authoredSymbolSpineKeyForPresentation,
  lockedVaultPresentationCell,
} from "../src/reels/SymbolView";
import { ReelSetView } from "../src/reels/ReelSetView";
import { ReelView } from "../src/reels/ReelView";
import {
  ATTRACT_GRID_LOCKED_VAULT_CELLS,
  createAttractGrid,
} from "../src/presentation/attractGrid";
import {
  FeatureEffects,
  PRIMAL_VAULT_UNLOCK_CHECKPOINT_MS,
  type VaultUnlockPresentationPhase,
} from "../src/renderer/FeatureEffects";
import {
  VisualFixtureGateway,
} from "../src/testing/VisualFixtureGateway";
import {
  matchVisualFixtureSemanticCheckpoint,
  publishBaseVaultUnlockCheckpoint,
  resolveVisualFixtureSemanticCheckpoint,
  baseVaultUnlockCaptureEnvironmentViolation,
} from "../src/testing/visualFixtureObservation";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";
import { validateSpinResultAgainstOrigin } from "../src/protocol/spinResultOriginGuard";

const unlockEvent = Object.freeze({
  type: "vault.unlocked" as const,
  reel: 1,
  row: 2,
  prize: "X2",
  multiplier: 2,
});

// Pixi 会在创建首个真实 Graphics 实例时延迟创建白色纹理。 / English: Pixi lazily creates the white texture when it creates the first real Graphics instance.
// 这些测试保持在真实 ReelView/ReelSetView 层级，无需引入 jsdom。 / English: These tests stay at the real ReelView/ReelSetView level without introducing jsdom.
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
const pixiShimKeys = [
  "HTMLImageElement",
  "HTMLVideoElement",
  "ImageBitmap",
  "HTMLCanvasElement",
  "SVGElement",
  "document",
] as const;
const previousPixiGlobals = new Map(
  pixiShimKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);
Object.assign(globalThis, {
  HTMLImageElement: TestImageElement,
  HTMLVideoElement: TestVideoElement,
  ImageBitmap: TestImageBitmap,
  HTMLCanvasElement: TestCanvas,
  SVGElement: TestSvgElement,
  document: { createElement: () => new TestCanvas() },
});

afterAll(() => {
  for (const key of pixiShimKeys) {
    const previous = previousPixiGlobals.get(key);
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

describe("Pass52 Base single-Vault unlock", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps only the initial Grand cabinet Vault on locked Symbol8", () => {
    const set = new ReelSetView();
    const grid = createAttractGrid();
    const internals = set as unknown as {
      reels: Array<{
        symbolViews: Array<{ forceLockedVault: boolean; cell: Readonly<GridCell> }>;
      }>;
    };

    set.setGrid(grid, { forceLockedVaultCells: ATTRACT_GRID_LOCKED_VAULT_CELLS });

    const grand = internals.reels[1]?.symbolViews[0];
    expect(grand?.cell).toEqual({ symbol: "VAULT", prize: "GRAND", multiplier: 1_000 });
    expect(grand?.forceLockedVault).toBe(true);
    expect(authoredSymbolSpineKeyForPresentation(grand!.cell, grand!.forceLockedVault))
      .toBe("symbol8");
    expect(authoredCellVariantAnimation(lockedVaultPresentationCell(grand!.cell))).toBe("grand");
    expect(internals.reels.flatMap((reel) => reel.symbolViews)
      .filter((symbol) => symbol.cell.symbol === "VAULT"))
      .toHaveLength(1);

    // 省略仅供渲染器使用的覆盖值，绝不会污染后续结果网格。 / English: Omitting override values ​​for renderer-only use never pollutes subsequent resulting meshes.
    set.setGrid(grid);
    expect(internals.reels[1]?.symbolViews[0]?.forceLockedVault).toBe(false);
  });

  it("keeps the final X2 cell immutable while selecting locked Symbol8", () => {
    const target = Object.freeze<GridCell>({ symbol: "VAULT", prize: "X2", multiplier: 2 });
    const projected = lockedVaultPresentationCell(target);

    expect(authoredSymbolSpineKeyForPresentation(target)).toBe("symbol9");
    expect(authoredSymbolSpineKeyForPresentation(target, true)).toBe("symbol8");
    expect(projected).toEqual(target);
    expect(projected).not.toBe(target);
    expect(authoredCellVariantAnimation(projected)).toBe("x2");
    expect(target).toEqual({ symbol: "VAULT", prize: "X2", multiplier: 2 });
  });

  it("falls doubled jackpot names back to the base Symbol8 pose only", () => {
    const doubled = Object.freeze<GridCell>({
      symbol: "VAULT",
      prize: "MINI_2X",
      multiplier: 20,
    });
    expect(lockedVaultPresentationCell(doubled)).toEqual({
      symbol: "VAULT",
      prize: "MINI",
      multiplier: 20,
    });
    expect(lockedVaultPresentationCell({
      symbol: "VAULT", prize: "GRAND", multiplier: 1_000,
    })).toEqual({ symbol: "VAULT", prize: "GRAND", multiplier: 1_000 });
    expect(lockedVaultPresentationCell({
      symbol: "VAULT", prize: "FREE_SPIN",
    })).toEqual({ symbol: "VAULT", prize: "FREE_SPIN" });
    expect(doubled.prize).toBe("MINI_2X");
  });

  it("forces unlock_backup to zero mix and applies its zero frame", () => {
    const entry = {
      animation: { name: "unlock_backup" },
      trackTime: 0,
      mixDuration: 0.15,
    };
    const valueEntry = {
      animation: { name: "x2" },
      trackTime: 0,
      mixDuration: 0,
    };
    const state = {
      hasAnimation: vi.fn((name: string) => name === "unlock_backup"),
      setAnimation: vi.fn(() => entry),
      getCurrent: vi.fn((track: number) => track === 0 ? entry : valueEntry),
    };
    const update = vi.fn();
    const view = Object.create(SymbolView.prototype) as SymbolView;
    Object.assign(view as unknown as Record<string, unknown>, {
      currentCell: { symbol: "VAULT", prize: "X2", multiplier: 2 },
      authoredView: { state, update },
      authoredKey: "symbol8",
      authoredPlaybackPaused: true,
    });

    expect(view.playVaultUnlockAnimation()).toBe(true);
    expect(state.setAnimation).toHaveBeenCalledWith(0, "unlock_backup", false);
    expect(entry.mixDuration).toBe(0);
    expect(update).toHaveBeenCalledWith(0);
    const diagnostics = view.getVaultCaptureDiagnostics();
    expect(diagnostics).toEqual({
      cell: { symbol: "VAULT", prize: "X2", multiplier: 2 },
      spineKey: "symbol8",
      track0: { animation: "unlock_backup", trackTimeMs: 0, mixDuration: 0 },
      track1: { animation: "x2", trackTimeMs: 0, mixDuration: 0 },
      paused: true,
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.cell)).toBe(true);
    expect(Object.isFrozen(diagnostics.track0)).toBe(true);
  });

  it("passes the final target plus a row-local locked flag without rewriting it", async () => {
    const stopAt = vi.fn(async (
      _cells: GridCell[],
      _duration: number,
      _mode: string,
      _lockedRows: ReadonlySet<number>,
    ) => undefined);
    const reels = [
      { cellAt: vi.fn(), stopAt: vi.fn(async () => undefined) },
      { cellAt: vi.fn(), stopAt },
      { cellAt: vi.fn(), stopAt: vi.fn(async () => undefined) },
    ];
    const view = Object.create(ReelSetView.prototype) as ReelSetView;
    Object.assign(view as unknown as Record<string, unknown>, {
      reels,
      preparedCellOverrides: new Map(),
    });
    const cells = Object.freeze([
      Object.freeze<GridCell>({ symbol: "NOVA" }),
      Object.freeze<GridCell>({ symbol: "TANK" }),
      Object.freeze<GridCell>({ symbol: "VAULT", prize: "X2", multiplier: 2 }),
    ]);

    view.prepareFeaturePresentation([unlockEvent]);
    await view.stopReel(1, [...cells], 777, "NORMAL");

    const [presented, duration, mode, lockedRows] = stopAt.mock.calls[0]!;
    expect(presented).toEqual(cells);
    expect(presented[2]).not.toBe(cells[2]);
    expect(duration).toBe(777);
    expect(mode).toBe("NORMAL");
    expect([...lockedRows]).toEqual([2]);
    expect(cells[2]).toEqual({ symbol: "VAULT", prize: "X2", multiplier: 2 });
  });

  it("keeps real ReelView insertion/last cells pure and clears the flag on next setCells", async () => {
    const reel = new ReelView(1);
    reel.setLayout(180, 336, 3);
    reel.beginSpin(true);
    const cells: GridCell[] = [
      { symbol: "NOVA" },
      { symbol: "TANK" },
      { symbol: "VAULT", prize: "X2", multiplier: 2 },
    ];
    await reel.stopAt(cells, 0, "NORMAL", new Set([2]));
    const internals = reel as unknown as {
      lastCells: GridCell[];
      resultInsertion: { cells: GridCell[] } | null;
      symbolViews: Array<{ forceLockedVault: boolean; cell: Readonly<GridCell> }>;
    };

    expect(internals.lastCells).toEqual(cells);
    expect(internals.resultInsertion?.cells).toEqual(cells);
    for (const stored of [
      ...internals.lastCells,
      ...(internals.resultInsertion?.cells ?? []),
    ]) {
      expect(Object.hasOwn(stored, "forceLockedVault")).toBe(false);
    }
    expect(internals.symbolViews[2]?.forceLockedVault).toBe(true);
    expect(internals.symbolViews[2]?.cell).toEqual(cells[2]);

    reel.setCells(cells);
    expect(internals.symbolViews[2]?.forceLockedVault).toBe(false);
    expect(internals.lastCells).toEqual(cells);
  });

  it("clears a real settled Symbol8 override on complete and cancelPresentation", async () => {
    const set = new ReelSetView();
    const internals = set as unknown as {
      preparedCellOverrides: Map<string, unknown>;
      reels: Array<{
        symbolViews: Array<{ forceLockedVault: boolean; cell: Readonly<GridCell> }>;
        resultInsertion: { cells: GridCell[] } | null;
      }>;
    };
    const middleCells: GridCell[] = [
      { symbol: "NOVA" },
      { symbol: "TANK" },
      { symbol: "VAULT", prize: "X2", multiplier: 2 },
    ];

    set.prepareFeaturePresentation([unlockEvent]);
    set.beginSpin(true);
    await set.stopReel(1, middleCells, 0, "NORMAL");
    expect(internals.reels[1]?.symbolViews[2]?.forceLockedVault).toBe(true);
    expect(internals.reels[1]?.symbolViews[2]?.cell).toEqual(middleCells[2]);

    set.completeVaultUnlock(unlockEvent);
    expect(internals.reels[1]?.symbolViews[2]?.forceLockedVault).toBe(false);
    expect(internals.reels[1]?.symbolViews[2]?.cell).toEqual(middleCells[2]);

    set.prepareFeaturePresentation([unlockEvent]);
    set.beginSpin(true);
    await set.stopReel(1, middleCells, 0, "NORMAL");
    expect(internals.reels[1]?.symbolViews[2]?.forceLockedVault).toBe(true);
    set.cancelPresentation();
    expect(internals.reels[1]?.symbolViews[2]?.forceLockedVault).toBe(false);
    expect(internals.reels[1]?.symbolViews[2]?.cell).toEqual(middleCells[2]);
    expect(internals.reels[1]?.resultInsertion).toBeNull();
    expect(internals.preparedCellOverrides.size).toBe(0);
  });

  it("does not replace Symbol8 before the complete 1500ms barrier", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reels = {
      beginVaultUnlock: vi.fn(() => true),
      completeVaultUnlock: vi.fn(),
      applyVaultUpgrade: vi.fn(() => true),
    };
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    Object.assign(effects as unknown as Record<string, unknown>, {
      destroyed: false,
      reels,
      hooks: {},
      vaultUnlockMilestoneListener: null,
      visualTelemetry: null,
      animate: vi.fn(() => gate),
    });

    const presentation = effects.presentVaultMutationBatch([unlockEvent], false);
    await Promise.resolve();
    expect(reels.beginVaultUnlock).toHaveBeenCalledWith(unlockEvent);
    expect((effects as unknown as { animate: ReturnType<typeof vi.fn> }).animate)
      .toHaveBeenCalledWith(1_500, expect.any(Function));
    expect(reels.completeVaultUnlock).not.toHaveBeenCalled();

    release();
    await presentation;
    expect(reels.completeVaultUnlock).toHaveBeenCalledTimes(1);
    expect(reels.completeVaultUnlock).toHaveBeenCalledWith(unlockEvent);
  });

  it("drives exact enter/key/impact/unlocked checkpoints on only the Vault clock", async () => {
    const order: string[] = [];
    const reels = {
      beginVaultUnlock: vi.fn(() => { order.push("begin"); return true; }),
      completeVaultUnlock: vi.fn(() => order.push("swap")),
      applyVaultUpgrade: vi.fn(() => true),
      setSymbolPlaybackPaused: vi.fn((_cells, active: boolean) => order.push(`pause:${active}`)),
      advanceSymbolPlayback: vi.fn((_cells, ms: number) => order.push(`advance:${ms}`)),
    };
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const animate = vi.fn(async (ms: number) => { order.push(`wait:${ms}`); });
    Object.assign(effects as unknown as Record<string, unknown>, {
      destroyed: false,
      reels,
      hooks: {},
      vaultUnlockMilestoneListener: null,
      visualTelemetry: null,
      animate,
    });
    const phases: VaultUnlockPresentationPhase[] = [];
    effects.setVaultUnlockMilestoneListener(async ({ phase, event }) => {
      expect(event).toEqual(unlockEvent);
      expect(Object.isFrozen(event)).toBe(true);
      phases.push(phase);
      order.push(phase);
    });

    await effects.presentVaultMutationBatch([unlockEvent], false);

    expect(phases).toEqual([
      "vault-unlock.enter",
      "vault-unlock.key-1",
      "vault-unlock.impact",
      "vault-unlock.unlocked",
    ]);
    expect(animate.mock.calls.map(([ms]) => ms)).toEqual([
      PRIMAL_VAULT_UNLOCK_CHECKPOINT_MS.firstAttachmentKey,
      100,
      1_500 - PRIMAL_VAULT_UNLOCK_CHECKPOINT_MS.impact,
    ]);
    expect(reels.advanceSymbolPlayback.mock.calls.map(([, ms]) => ms)).toEqual([
      33.333,
      100,
      1_366.667,
    ]);
    expect(order.indexOf("vault-unlock.impact")).toBeLessThan(order.indexOf("swap"));
    expect(order.indexOf("swap")).toBeLessThan(order.indexOf("vault-unlock.unlocked"));
    expect(reels.setSymbolPlaybackPaused.mock.calls).toEqual([
      [[{ reel: 1, row: 2 }], true],
      [[{ reel: 1, row: 2 }], false],
    ]);
  });

  it("awaits deferred enter and impact observers without advancing or swapping", async () => {
    let releaseEnter: () => void = () => undefined;
    let releaseImpact: () => void = () => undefined;
    const enterGate = new Promise<void>((resolve) => { releaseEnter = resolve; });
    const impactGate = new Promise<void>((resolve) => { releaseImpact = resolve; });
    let symbolPaused = false;
    const order: string[] = [];
    const reels = {
      beginVaultUnlock: vi.fn(() => true),
      completeVaultUnlock: vi.fn(() => order.push("swap")),
      applyVaultUpgrade: vi.fn(() => true),
      setSymbolPlaybackPaused: vi.fn((_cells, active: boolean) => {
        symbolPaused = active;
        order.push(`pause:${active}`);
      }),
      advanceSymbolPlayback: vi.fn((_cells, ms: number) => order.push(`advance:${ms}`)),
    };
    const effects = Object.create(FeatureEffects.prototype) as FeatureEffects;
    const animate = vi.fn(async (ms: number) => { order.push(`wait:${ms}`); });
    Object.assign(effects as unknown as Record<string, unknown>, {
      destroyed: false,
      reels,
      hooks: {},
      vaultUnlockMilestoneListener: null,
      visualTelemetry: null,
      animate,
    });
    const phases: VaultUnlockPresentationPhase[] = [];
    let unlockedObservedPaused = false;
    effects.setVaultUnlockMilestoneListener(({ phase }) => {
      phases.push(phase);
      order.push(phase);
      if (phase === "vault-unlock.enter") return enterGate;
      if (phase === "vault-unlock.impact") return impactGate;
      if (phase === "vault-unlock.unlocked") unlockedObservedPaused = symbolPaused;
    });
    const flush = async (): Promise<void> => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };

    const presentation = effects.presentVaultMutationBatch([unlockEvent], false);
    await flush();
    expect(phases).toEqual(["vault-unlock.enter"]);
    expect(animate).not.toHaveBeenCalled();
    expect(reels.completeVaultUnlock).not.toHaveBeenCalled();
    expect(symbolPaused).toBe(true);

    releaseEnter();
    await flush();
    expect(phases).toEqual([
      "vault-unlock.enter",
      "vault-unlock.key-1",
      "vault-unlock.impact",
    ]);
    expect(animate.mock.calls.map(([ms]) => ms)).toEqual([33.333, 100]);
    expect(reels.completeVaultUnlock).not.toHaveBeenCalled();
    expect(symbolPaused).toBe(true);

    releaseImpact();
    await presentation;
    expect(reels.completeVaultUnlock).toHaveBeenCalledTimes(1);
    expect(phases.at(-1)).toBe("vault-unlock.unlocked");
    expect(unlockedObservedPaused).toBe(true);
    expect(symbolPaused).toBe(false);
    expect(order.indexOf("swap")).toBeLessThan(order.indexOf("vault-unlock.unlocked"));
  });

  it("replays one canonical local-protocol Base X2 Vault round", () => {
    vi.useFakeTimers();
    const results: SpinResult[] = [];
    const gateway = new VisualFixtureGateway("base-vault-unlock-x2");
    gateway.setCallbacks({
      onStatus: vi.fn(),
      onSession: vi.fn(),
      onSpinResult: (result) => results.push(result),
      onError: vi.fn(),
    });
    gateway.connect();
    vi.runOnlyPendingTimers();
    expect(gateway.requestSpin("pass52-vault-x2", "100")).toBe(true);
    vi.runOnlyPendingTimers();

    expect(results).toHaveLength(1);
    expect(results[0]?.sequence).toBe(1);
    expect(results[0]?.totalWinMinor).toBe("200");
    expect(results[0]?.grid[1]?.[2]).toEqual({
      symbol: "VAULT", prize: "X2", multiplier: 2,
    });
    expect(results[0]?.events.map(({ type }) => type)).toEqual([
      "vaults.landed",
      "vaults.unlock.started",
      "vault.unlocked",
      "vault.awarded",
      "vaults.unlock.completed",
    ]);
    expect(() => validateSpinResultAgainstOrigin({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    }, results[0]!)).not.toThrow();
  });

  it.each([
    ["vault-unlock.locked", "symbol8", "stop", 0],
    ["vault-unlock.enter", "symbol8", "unlock_backup", 0],
    ["vault-unlock.key-1", "symbol8", "unlock_backup", 33.333],
    ["vault-unlock.impact", "symbol8", "unlock_backup", 133.333],
    ["vault-unlock.unlocked", "symbol9", "stop", 0],
  ] as const)("strictly matches and publishes %s diagnostics", (
    phase,
    spineKey,
    track0Animation,
    trackTimeMs,
  ) => {
    const checkpoint = Object.freeze({
      type: "vault-unlock-phase" as const,
      phase,
      sequence: 1,
      cell: Object.freeze({ reel: 1, row: 2 }),
      prize: "X2",
      multiplier: 2,
    });
    const requested = resolveVisualFixtureSemanticCheckpoint(
      "base-vault-unlock-x2", "1", phase,
    );
    expect(requested).toBe(phase);
    expect(matchVisualFixtureSemanticCheckpoint(
      "base-vault-unlock-x2", "1", requested, checkpoint,
    )).toBe(phase);
    const diagnostics = Object.freeze({
      reel: 1,
      row: 2,
      cell: Object.freeze<GridCell>({ symbol: "VAULT", prize: "X2", multiplier: 2 }),
      spineKey,
      track0: Object.freeze({
        animation: track0Animation,
        trackTimeMs,
        mixDuration: 0,
      }),
      track1: Object.freeze({ animation: "x2", trackTimeMs: 0, mixDuration: 0 }),
      paused: true,
    });
    const dataset: Record<string, string | undefined> = {};
    expect(publishBaseVaultUnlockCheckpoint(
      dataset,
      "base-vault-unlock-x2",
      "1",
      requested,
      checkpoint,
      diagnostics,
    )).toBeNull();
    expect(dataset.fixtureVaultUnlockCheckpoint).toBe(phase);
    expect(dataset.fixtureVaultUnlockContract).toBe("ok");
    expect(JSON.parse(dataset.fixtureVaultUnlockDiagnostics ?? "null")).toEqual(diagnostics);
  });

  it("rejects a locked checkpoint whose track0 is not the exact stop pose", () => {
    const checkpoint = Object.freeze({
      type: "vault-unlock-phase" as const,
      phase: "vault-unlock.locked" as const,
      sequence: 1,
      cell: Object.freeze({ reel: 1, row: 2 }),
      prize: "X2",
      multiplier: 2,
    });
    const diagnostics = Object.freeze({
      reel: 1,
      row: 2,
      cell: Object.freeze<GridCell>({ symbol: "VAULT", prize: "X2", multiplier: 2 }),
      spineKey: "symbol8" as const,
      track0: Object.freeze({ animation: "land", trackTimeMs: 0, mixDuration: 0 }),
      track1: Object.freeze({ animation: "x2", trackTimeMs: 0, mixDuration: 0 }),
      paused: true,
    });
    const dataset: Record<string, string | undefined> = {};

    expect(publishBaseVaultUnlockCheckpoint(
      dataset,
      "base-vault-unlock-x2",
      "1",
      "vault-unlock.locked",
      checkpoint,
      diagnostics,
    )).toBe("vault-unlock-track0-animation");
    expect(dataset.fixtureVaultUnlockContract).toBeUndefined();
    expect(dataset.fixtureVaultUnlockDiagnostics).toBeUndefined();
  });

  it("fails closed instead of capturing the reduced 120ms accessibility clock", () => {
    expect(baseVaultUnlockCaptureEnvironmentViolation(
      "base-vault-unlock-x2",
      "1",
      "vault-unlock.unlocked",
      false,
    )).toBeNull();
    expect(baseVaultUnlockCaptureEnvironmentViolation(
      "base-vault-unlock-x2",
      "1",
      "vault-unlock.unlocked",
      true,
    )).toBe("vault-unlock-reduced-motion-not-canonical");
    expect(baseVaultUnlockCaptureEnvironmentViolation(
      "base-vault-unlock-x2",
      "1",
      "not-allow-listed",
      true,
    )).toBeNull();
    expect(fixtureMain).toContain(
      'body.dataset.fixtureVaultUnlockReducedMotion = String(pass52VaultUnlockReducedMotion)',
    );
    expect(fixtureMain).toContain("body.dataset.fixtureVaultUnlockEnvironmentViolation = violation");
    expect(fixtureMain).toContain("delete body.dataset.fixtureVaultUnlockReducedMotion");
    expect(fixtureMain).toContain("delete body.dataset.fixtureVaultUnlockEnvironmentViolation");
    expect(fixtureMain).toContain("vaultUnlockCaptureEnabled: pass52VaultUnlockCaptureEnabled");
  });

  it("installs the exact 60-second fixture hold and teardown cleanup", () => {
    expect(fixtureMain).toContain('scenario === "base-vault-unlock-x2"');
    expect(fixtureMain).toContain("publishBaseVaultUnlockCheckpoint");
    expect(fixtureMain).toContain("app?.getVaultCaptureDiagnostics(checkpoint.cell)");
    expect(fixtureMain).toContain("? 60_000");
    expect(fixtureMain).toContain("checkpointHold?.release()");
    expect(fixtureMain).toContain("clearVisualFixtureVault(body.dataset)");
  });
});
