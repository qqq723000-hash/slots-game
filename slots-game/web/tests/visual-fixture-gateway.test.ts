import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import fixtureHtml from "../visual-fixtures.html?raw";
import productionMain from "../src/main.ts?raw";
import type {
  FeatureState,
  ServerError,
  SessionOpened,
  SpinResult,
} from "../src/app/state/types";
import {
  isCelebratoryWin,
  isWinLossOrEqual,
  planPayoutAudio,
} from "../src/app/roundAudioPlan";
import { decodeServerMessage } from "../src/protocol/decoder";
import { validateSpinResultAgainstOrigin } from "../src/protocol/spinResultOriginGuard";
import { planBigWin } from "../src/renderer/BigWinView";
import { createWinCelebrationPlan } from "../src/renderer/WinCelebration";
import type {
  GatewayCallbacks,
  GatewayStatus,
} from "../src/protocol/GameGateway";
import {
  isVisualFixtureScenario,
  VisualFixtureGateway,
  VISUAL_FIXTURE_SCENARIOS,
  type VisualFixtureScenarioName,
} from "../src/testing/VisualFixtureGateway";
import { bindPrimalPresentationRules } from "../src/ui/presentationRules";

interface GatewayLog {
  readonly statuses: GatewayStatus[];
  readonly sessions: SessionOpened[];
  readonly results: SpinResult[];
  readonly errors: (ServerError | Error)[];
}

function connectFixture(scenario: VisualFixtureScenarioName): {
  gateway: VisualFixtureGateway;
  log: GatewayLog;
} {
  const gateway = new VisualFixtureGateway(scenario);
  const log: GatewayLog = { statuses: [], sessions: [], results: [], errors: [] };
  const callbacks: GatewayCallbacks = {
    onStatus: (status) => log.statuses.push(status),
    onSession: (session) => log.sessions.push(session),
    onSpinResult: (result) => log.results.push(result),
    onError: (error) => log.errors.push(error),
  };
  gateway.setCallbacks(callbacks);
  gateway.connect();
  expect(log.statuses).toEqual(["connecting"]);
  vi.runOnlyPendingTimers();
  expect(log.statuses).toEqual(["connecting", "online"]);
  expect(log.sessions).toHaveLength(1);
  return { gateway, log };
}

function deliverRound(
  gateway: VisualFixtureGateway,
  log: GatewayLog,
  roundId: string,
): SpinResult {
  const resultCount = log.results.length;
  expect(gateway.requestSpin(roundId, "100")).toBe(true);
  expect(gateway.hasPendingSpin).toBe(true);
  vi.runOnlyPendingTimers();
  expect(gateway.hasPendingSpin).toBe(false);
  expect(log.results).toHaveLength(resultCount + 1);
  return log.results[resultCount]!;
}

function expectProductionSequence(
  initialState: Readonly<FeatureState>,
  results: readonly SpinResult[],
): void {
  let origin = initialState;
  for (const result of results) {
    expect(decodeServerMessage(result)).toEqual(result);
    expect(() => validateSpinResultAgainstOrigin(origin, result)).not.toThrow();
    origin = result.featureState;
  }
}

describe("VisualFixtureGateway", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exposes only the explicit scenario allow-list", () => {
    expect(VISUAL_FIXTURE_SCENARIOS).toEqual([
      "big-win",
      "base-wild-reveal-x100",
      "base-vault-unlock-x2",
      "base-vault-locked-x6",
      "base-single-rage-no-wheel",
      "base-two-rage-no-wheel",
      "base-one-rage-trigger-transform",
      "base-rage-level-two-persistent-aura",
      "base-launch-level-two-intro",
      "base-rgs-recovered-level-up",
      "base-three-rage-wheel-entry",
      "win-effects-matrix",
      "normal-win-continue",
      "wheel-mini-flow",
      "autoplay-wheel-mini-resume",
      "king-flow",
      "high-pps-probability-king-exit",
      "king-upgrade-ladder",
      "kong-flow",
      "cap-summary",
      "summary-no-panel",
      "summary-no-panel-equal",
    ]);
    expect(isVisualFixtureScenario("big-win")).toBe(true);
    expect(isVisualFixtureScenario("base-wild-reveal-x100")).toBe(true);
    expect(isVisualFixtureScenario("base-vault-unlock-x2")).toBe(true);
    expect(isVisualFixtureScenario("base-vault-locked-x6")).toBe(true);
    expect(isVisualFixtureScenario("base-single-rage-no-wheel")).toBe(true);
    expect(isVisualFixtureScenario("base-two-rage-no-wheel")).toBe(true);
    expect(isVisualFixtureScenario("base-one-rage-trigger-transform")).toBe(true);
    expect(isVisualFixtureScenario("base-rage-level-two-persistent-aura")).toBe(true);
    expect(isVisualFixtureScenario("base-launch-level-two-intro")).toBe(true);
    expect(isVisualFixtureScenario("base-rgs-recovered-level-up")).toBe(true);
    expect(isVisualFixtureScenario("base-three-rage-wheel-entry")).toBe(true);
    expect(isVisualFixtureScenario("win-effects-matrix")).toBe(true);
    expect(isVisualFixtureScenario("normal-win-continue")).toBe(true);
    expect(isVisualFixtureScenario("wheel-mini-flow")).toBe(true);
    expect(isVisualFixtureScenario("autoplay-wheel-mini-resume")).toBe(true);
    expect(isVisualFixtureScenario("high-pps-probability-king-exit")).toBe(true);
    expect(isVisualFixtureScenario("king-upgrade-ladder")).toBe(true);
    expect(isVisualFixtureScenario("summary-no-panel-equal")).toBe(true);
    expect(isVisualFixtureScenario("base-rage-level-two-persistent-aura-extra"))
      .toBe(false);
    expect(isVisualFixtureScenario("BIG-WIN")).toBe(false);
    expect(isVisualFixtureScenario("eyJvdXRjb21lIjoiaW5qZWN0ZWQifQ==")).toBe(false);
    expect(isVisualFixtureScenario("{\"grid\":[]}")).toBe(false);
  });

  it("connects asynchronously with a canonical immutable fixture session", () => {
    const gateway = new VisualFixtureGateway("big-win");
    const sessions: SessionOpened[] = [];
    const statuses: GatewayStatus[] = [];
    gateway.setCallbacks({
      onStatus: (status) => statuses.push(status),
      onSession: (session) => sessions.push(session),
      onSpinResult: vi.fn(),
      onError: vi.fn(),
    });

    gateway.connect();
    expect(statuses).toEqual(["connecting"]);
    expect(sessions).toEqual([]);
    vi.runOnlyPendingTimers();

    expect(statuses).toEqual(["connecting", "online"]);
    expect(sessions[0]).toMatchObject({
      type: "session.opened",
      protocolVersion: 1,
      balanceMinor: "100000",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(sessions[0]?.sessionId).toMatch(/^fixture-session-/);
    expect(sessions[0]?.requestId).toMatch(/^fixture-open-/);
    expect(Object.isFrozen(sessions[0])).toBe(true);
    expect(Object.isFrozen(sessions[0]?.featureState)).toBe(true);
  });

  it("binds its synthetic session to the approved presentationRules fixture identity", () => {
    const { log } = connectFixture("big-win");
    const opened = log.sessions[0];
    if (!opened) throw new Error("fixture session was not emitted");

    expect(bindPrimalPresentationRules(null, opened).status).toBe("bound");
    expect(Object.isFrozen(opened.definitionBinding)).toBe(true);
  });

  it("emits the immutable Tank-Wild-x100 Big Win and settles the charged balance", () => {
    const { gateway, log } = connectFixture("big-win");
    const result = deliverRound(gateway, log, "round-big-win");

    expect(result).toMatchObject({
      roundId: "round-big-win",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "114900",
      totalWinMinor: "15000",
    });
    expect(result.requestId).toMatch(/^fixture-spin-/);
    expect(result.sessionId).toBe(log.sessions[0]?.sessionId);
    expect(result.grid[1]?.[1]).toEqual({ symbol: "WILD", multiplier: 100 });
    expect(result.wins[0]?.pathAwards?.[0]).toMatchObject({
      multiplier: 100,
      baseAmountMinor: "150",
      amountMinor: "15000",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid)).toBe(true);
    expect(Object.isFrozen(result.grid[1]?.[1])).toBe(true);
    expect(Object.isFrozen(result.wins[0]?.pathAwards?.[0]?.cells)).toBe(true);
    expect(() => {
      (result.grid[1]![1] as { symbol: string }).symbol = "PRISM";
    }).toThrow(TypeError);
    expect(decodeServerMessage(result)).toEqual(result);
  });

  it("emits one middle-reel Wild-x100 with no win or feature event", () => {
    const { gateway, log } = connectFixture("base-wild-reveal-x100");
    const result = deliverRound(gateway, log, "round-base-wild-reveal-x100");

    expect(result).toMatchObject({
      roundId: "round-base-wild-reveal-x100",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "99900",
      totalWinMinor: "0",
      wins: [],
      events: [],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    expect(result.grid[1]?.[1]).toEqual({ symbol: "WILD", multiplier: 100 });
    const cells = result.grid.flatMap((reel, reelIndex) => (
      reel.map((gridCell, row) => ({ ...gridCell, reel: reelIndex, row }))
    ));
    expect(cells.filter(({ symbol }) => symbol === "WILD")).toEqual([
      { symbol: "WILD", multiplier: 100, reel: 1, row: 1 },
    ]);
    expect(cells.filter(({ symbol }) => symbol === "SURGE" || symbol === "VAULT"))
      .toEqual([]);
    expect(new Set(result.grid[0]!.map(({ symbol }) => symbol)))
      .toEqual(new Set(["PRISM", "PULSE", "ORBIT"]));
    expect(result.grid[2]!.every(({ symbol }) => (
      !result.grid[0]!.some((leftCell) => leftCell.symbol === symbol)
    ))).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid[1]?.[1])).toBe(true);
    expect(decodeServerMessage(result)).toEqual(result);
    expectProductionSequence(log.sessions[0]!.featureState, [result]);
  });

  it("replays the official locked server-ID-22 face without opening or paying it", () => {
    const { gateway, log } = connectFixture("base-vault-locked-x6");
    const origin = log.sessions[0]!.featureState;
    const result = deliverRound(gateway, log, "round-base-vault-locked-x6");

    expect(result).toMatchObject({
      roundId: "round-base-vault-locked-x6",
      totalWinMinor: "0",
      balanceMinor: "99900",
    });
    expect(result.grid[1]?.[2]).toEqual({ symbol: "VAULT", lockedVaultFace: "x6" });
    expect(result.events).toEqual([
      { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vaults.locked", count: 1, cells: [{ reel: 1, row: 2 }] },
    ]);
    expect(result.wins).toEqual([]);
    expectProductionSequence(origin, [result]);
  });

  it("collects one Base Rage without a transform, Wheel, Vault, Wild, or Free Spins", () => {
    const { gateway, log } = connectFixture("base-single-rage-no-wheel");
    const result = deliverRound(gateway, log, "round-base-single-rage-no-wheel");

    expect(result).toMatchObject({
      roundId: "round-base-single-rage-no-wheel",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "99900",
      totalWinMinor: "0",
      wins: [],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 1,
      },
    });
    expect(result.grid).toEqual([
      [{ symbol: "ORBIT" }, { symbol: "CIRCUIT" }, { symbol: "ORBIT" }],
      [{ symbol: "SURGE" }, { symbol: "PULSE" }, { symbol: "CIRCUIT" }],
      [{ symbol: "TANK" }, { symbol: "TANK" }, { symbol: "PRISM" }],
    ]);
    expect(result.events).toEqual([{
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    }]);

    const symbols = result.grid.flat().map(({ symbol }) => symbol);
    expect(symbols.filter((symbol) => symbol === "SURGE")).toEqual(["SURGE"]);
    expect(symbols).not.toContain("WILD");
    expect(symbols).not.toContain("VAULT");
    expect(result.events.some(({ type }) => type === "rage.transformed")).toBe(false);
    expect(result.events.some(({ type }) => type.startsWith("wheel."))).toBe(false);
    expect(result.events.some(({ type }) => (
      type.startsWith("free_spin.") || type.startsWith("free_spins.")
    ))).toBe(false);
    expect(result.events.some(({ type }) => type.startsWith("vault"))).toBe(false);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(decodeServerMessage(result)).toEqual(result);
    expectProductionSequence(log.sessions[0]!.featureState, [result]);
  });

  it("collects two Base Rage symbols without a transform, Wheel, Vault, Wild, or Free Spins", () => {
    const { gateway, log } = connectFixture("base-two-rage-no-wheel");
    const origin = log.sessions[0]!.featureState;
    const result = deliverRound(gateway, log, "round-base-two-rage-no-wheel");

    expect(result).toMatchObject({
      roundId: "round-base-two-rage-no-wheel",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "99900",
      totalWinMinor: "0",
      wins: [],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 2,
      },
    });
    expect(result.grid).toEqual([
      [{ symbol: "ORBIT" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "PULSE" }, { symbol: "SURGE" }, { symbol: "CIRCUIT" }],
      [{ symbol: "TANK" }, { symbol: "TANK" }, { symbol: "TANK" }],
    ]);
    expect(result.events).toEqual([{
      type: "surge.collected",
      count: 2,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 2,
    }]);

    const symbols = result.grid.flat().map(({ symbol }) => symbol);
    expect(symbols.filter((symbol) => symbol === "SURGE"))
      .toEqual(["SURGE", "SURGE"]);
    expect(symbols).not.toContain("WILD");
    expect(symbols).not.toContain("VAULT");
    expect(result.wins).toEqual([]);
    expect(result.events.some(({ type }) => type === "rage.transformed")).toBe(false);
    expect(result.events.some(({ type }) => type.startsWith("wheel."))).toBe(false);
    expect(result.events.some(({ type }) => (
      type.startsWith("free_spin.") || type.startsWith("free_spins.")
    ))).toBe(false);
    expect(result.events.some(({ type }) => type.startsWith("vault"))).toBe(false);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(decodeServerMessage(result)).toEqual(result);
    expect(() => validateSpinResultAgainstOrigin(origin, result)).not.toThrow();
    expectProductionSequence(origin, [result]);
    expect(gateway.requestSpin("round-base-two-rage-no-wheel-extra", "100")).toBe(false);
    expect(log.results).toEqual([result]);
    expect(log.errors).toEqual([]);
  });

  it("freezes one Base Rage, two authoritative transforms, then the MINI Wheel result", () => {
    const { gateway, log } = connectFixture("base-one-rage-trigger-transform");
    const origin = log.sessions[0]!.featureState;
    const result = deliverRound(gateway, log, "round-base-one-rage-trigger-transform");

    expect(result).toMatchObject({
      roundId: "round-base-one-rage-trigger-transform",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "100900",
      totalWinMinor: "1000",
      wins: [],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    expect(result.grid).toEqual([
      [{ symbol: "ORBIT" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "PULSE" }, { symbol: "CIRCUIT" }, { symbol: "PULSE" }],
      [{ symbol: "NOVA" }, { symbol: "ORBIT" }, { symbol: "ORBIT" }],
    ]);
    expect(result.events).toEqual([
      {
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 0, row: 1 }],
        triggered: true,
        guaranteed: false,
        level: 1,
        total: 0,
      },
      {
        type: "rage.transformed",
        count: 2,
        cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      {
        type: "wheel.awarded",
        outcome: "INSTANT",
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      },
    ]);

    const symbols = result.grid.flat().map(({ symbol }) => symbol);
    expect(symbols.filter((symbol) => symbol === "SURGE")).toEqual(["SURGE"]);
    expect(symbols).not.toContain("WILD");
    expect(symbols).not.toContain("VAULT");
    expect(result.events.some(({ type }) => type.startsWith("vault"))).toBe(false);
    expect(result.events.some(({ type }) => (
      type.startsWith("free_spin.") || type.startsWith("free_spins.")
    ))).toBe(false);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.isFrozen(result.events[0]?.type === "surge.collected"
      ? result.events[0].cells : [])).toBe(true);
    expect(Object.isFrozen(result.events[1]?.type === "rage.transformed"
      ? result.events[1].cells[0] : {})).toBe(true);
    expect(decodeServerMessage(result)).toEqual(result);
    expect(() => validateSpinResultAgainstOrigin(origin, result)).not.toThrow();
    expectProductionSequence(origin, [result]);
    expect(gateway.requestSpin("round-base-one-rage-trigger-transform-extra", "100"))
      .toBe(false);
    expect(log.results).toEqual([result]);
    expect(log.errors).toEqual([]);
  });

  it("preserves the exact level-two Rage aura across one ordinary Base round", () => {
    const { gateway, log } = connectFixture("base-rage-level-two-persistent-aura");
    const initialState = log.sessions[0]!.featureState;

    expect(initialState).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 2,
      rageCollected: 12,
    });
    expect(Object.isFrozen(initialState)).toBe(true);

    const result = deliverRound(
      gateway,
      log,
      "round-base-rage-level-two-persistent-aura",
    );

    expect({
      roundId: result.roundId,
      sequence: result.sequence,
      betMinor: result.betMinor,
      chargedBetMinor: result.chargedBetMinor,
      balanceMinor: result.balanceMinor,
      totalWinMinor: result.totalWinMinor,
    }).toEqual({
      roundId: "round-base-rage-level-two-persistent-aura",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "99900",
      totalWinMinor: "0",
    });
    expect(result.grid).toEqual([
      [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "PRISM" }],
      [{ symbol: "ORBIT" }, { symbol: "NOVA" }, { symbol: "ORBIT" }],
      [{ symbol: "CIRCUIT" }, { symbol: "TANK" }, { symbol: "CIRCUIT" }],
    ]);
    expect(result.wins).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.featureState).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 2,
      rageCollected: 12,
    });
    expect(result.featureState).toEqual(initialState);

    const symbols = result.grid.flat().map(({ symbol }) => symbol);
    expect(symbols).not.toContain("SURGE");
    expect(symbols).not.toContain("WILD");
    expect(symbols).not.toContain("VAULT");
    expect(result.grid[0]!.every(({ symbol }) => (
      result.grid.slice(1).every((reel) => (
        reel.every((gridCell) => gridCell.symbol !== symbol)
      ))
    ))).toBe(true);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid)).toBe(true);
    expect(Object.isFrozen(result.grid[0]?.[0])).toBe(true);
    expect(Object.isFrozen(result.wins)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.featureState)).toBe(true);
    expectProductionSequence(initialState, [result]);
    expect(gateway.requestSpin(
      "round-base-rage-level-two-persistent-aura-extra",
      "100",
    )).toBe(false);
    expect(log.results).toEqual([result]);
    expect(log.errors).toEqual([]);
  });

  it("restores level-two Base state for launch-only capture without authoring a round", () => {
    const { gateway, log } = connectFixture("base-launch-level-two-intro");

    expect(log.sessions[0]!.featureState).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 2,
      rageCollected: 12,
    });
    expect(Object.isFrozen(log.sessions[0]!.featureState)).toBe(true);
    expect(gateway.hasPendingSpin).toBe(false);
    expect(gateway.requestSpin("pass50-must-not-spin", "100")).toBe(false);
    vi.runOnlyPendingTimers();
    expect(gateway.hasPendingSpin).toBe(false);
    expect(log.results).toEqual([]);
    expect(log.errors).toEqual([]);
  });

  it("replays all six ordinary-win boundaries with authoritative Ways projections", () => {
    const { gateway, log } = connectFixture("win-effects-matrix");
    const results = Array.from({ length: 6 }, (_, index) => (
      deliverRound(gateway, log, `round-win-effects-${index + 1}`)
    ));

    expect(results.map(({ totalWinMinor }) => totalWinMinor))
      .toEqual(["10", "100", "150", "200", "100", "2000"]);
    expect(results.map(({ chargedBetMinor }) => chargedBetMinor))
      .toEqual(Array(6).fill("100"));
    expect(results.map(({ balanceMinor }) => balanceMinor))
      .toEqual(["99910", "99910", "99960", "100060", "100060", "101960"]);
    expect(results.map(({ wins }) => wins.map(({ symbol }) => symbol)))
      .toEqual([
        ["PRISM"], ["NOVA"], ["TANK"], ["CIRCUIT"],
        ["PRISM", "ORBIT"], ["CIRCUIT"],
      ]);
    expect(results.every(({ events }) => events.length === 0)).toBe(true);
    expect(results.every(({ featureState }) => (
      featureState.mode === "BASE"
      && featureState.freeSpinsRemaining === 0
      && featureState.rageLevel === 1
      && featureState.rageCollected === 0
    ))).toBe(true);

    const [belowBet, equalBet, celebratory, payoutStart, multiRecord, bigWin] = results;
    expect(isWinLossOrEqual(belowBet!.totalWinMinor, belowBet!.betMinor)).toBe(true);
    expect(isWinLossOrEqual(equalBet!.totalWinMinor, equalBet!.betMinor)).toBe(true);
    expect(isCelebratoryWin(celebratory!.totalWinMinor, celebratory!.betMinor)).toBe(true);
    expect(planPayoutAudio(celebratory!.totalWinMinor, celebratory!.betMinor)).toBeNull();
    expect(planPayoutAudio(payoutStart!.totalWinMinor, payoutStart!.betMinor))
      .toEqual({ level: 1, intensity: 1 });

    expect(multiRecord!.wins.map(({ id }) => id)).toEqual([
      "matrix-prism-wild-x2-two-ways",
      "matrix-orbit-wild-x2",
    ]);
    expect(multiRecord!.wins[0]).toMatchObject({
      symbol: "PRISM",
      ways: 2,
      multiplier: 2,
      amountMinor: "40",
      pathAwards: [
        { multiplier: 2, baseAmountMinor: "10", amountMinor: "20" },
        { multiplier: 2, baseAmountMinor: "10", amountMinor: "20" },
      ],
    });
    expect(multiRecord!.wins[1]).toMatchObject({
      symbol: "ORBIT",
      ways: 1,
      multiplier: 2,
      amountMinor: "60",
      pathAwards: [{ multiplier: 2, baseAmountMinor: "30", amountMinor: "60" }],
    });

    const payingSymbols = [
      "ORBIT", "PRISM", "PULSE", "NOVA", "CIRCUIT", "TANK",
    ] as const;
    const enumerateTargetPaths = (
      symbol: SpinResult["wins"][number]["symbol"],
    ): string[] => {
      const rows = multiRecord!.grid.map((reel) => reel.flatMap((gridCell, row) => (
        gridCell.symbol === symbol || gridCell.symbol === "WILD" ? [row] : []
      )));
      return rows[0]!.flatMap((left) => rows[1]!.flatMap((middle) => (
        rows[2]!.map((right) => `${left}:${middle}:${right}`)
      )));
    };
    const winningSymbols = payingSymbols.filter((symbol) => (
      enumerateTargetPaths(symbol).length > 0
    ));
    expect(new Set(multiRecord!.wins.map(({ symbol }) => symbol)))
      .toEqual(new Set(winningSymbols));
    for (const win of multiRecord!.wins) {
      const enumeratedPaths = enumerateTargetPaths(win.symbol);
      const authoritativePaths = win.pathAwards!.map((award) => (
        award.cells.map(({ row }) => row).join(":")
      ));
      expect(win.ways).toBe(enumeratedPaths.length);
      expect(authoritativePaths).toEqual(enumeratedPaths);
    }

    expect(createWinCelebrationPlan(multiRecord!.wins).records.map((record) => ({
      id: record.id,
      ways: record.ways,
      multiplier: record.multiplier,
      baseAmountMinor: record.baseAmountMinor,
      amountMinor: record.amountMinor,
    }))).toEqual([
      {
        id: "matrix-prism-wild-x2-two-ways",
        ways: 2,
        multiplier: 2,
        baseAmountMinor: "20",
        amountMinor: "40",
      },
      {
        id: "matrix-orbit-wild-x2",
        ways: 1,
        multiplier: 2,
        baseAmountMinor: "30",
        amountMinor: "60",
      },
    ]);

    expect(bigWin!.grid[1]?.[0]).toEqual({ symbol: "WILD", multiplier: 10 });
    expect(bigWin!.wins[0]).toMatchObject({
      id: "matrix-big-win-boundary",
      symbol: "CIRCUIT",
      ways: 1,
      multiplier: 10,
      amountMinor: "2000",
      pathAwards: [{
        multiplier: 10,
        baseAmountMinor: "200",
        amountMinor: "2000",
      }],
    });
    expect(planBigWin(BigInt(bigWin!.totalWinMinor), BigInt(bigWin!.betMinor)))
      .toMatchObject({ finalTier: "bigwin" });

    expectProductionSequence(log.sessions[0]!.featureState, results);
    expect(gateway.requestSpin("round-win-effects-extra", "100")).toBe(false);
    expect(log.results).toEqual(results);
    expect(log.errors).toEqual([]);
  });

  it("replays the exact two-record normal-win Continue sentinel round", () => {
    const { gateway, log } = connectFixture("normal-win-continue");
    const result = deliverRound(gateway, log, "round-normal-win-continue");

    expect(result).toMatchObject({
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      totalWinMinor: "800",
      balanceMinor: "100700",
      events: [],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    expect(result.grid[1]?.[0]).toEqual({ symbol: "WILD", multiplier: 5 });
    expect(result.wins).toEqual([
      {
        id: "continue-prism-wild-x5-four-boxes",
        symbol: "PRISM",
        ways: 2,
        nominalAmountMinor: "500",
        amountMinor: "500",
        multiplier: 5,
        cells: [
          { reel: 0, row: 0 },
          { reel: 0, row: 1 },
          { reel: 1, row: 0 },
          { reel: 2, row: 0 },
        ],
        pathAwards: [
          {
            cells: [
              { reel: 0, row: 0 },
              { reel: 1, row: 0 },
              { reel: 2, row: 0 },
            ],
            multiplier: 5,
            baseAmountMinor: "50",
            nominalAmountMinor: "250",
            amountMinor: "250",
          },
          {
            cells: [
              { reel: 0, row: 1 },
              { reel: 1, row: 0 },
              { reel: 2, row: 0 },
            ],
            multiplier: 5,
            baseAmountMinor: "50",
            nominalAmountMinor: "250",
            amountMinor: "250",
          },
        ],
      },
      {
        id: "continue-orbit-plain-sentinel",
        symbol: "ORBIT",
        ways: 1,
        nominalAmountMinor: "300",
        amountMinor: "300",
        multiplier: 1,
        cells: [
          { reel: 0, row: 2 },
          { reel: 1, row: 1 },
          { reel: 2, row: 2 },
        ],
        pathAwards: [{
          cells: [
            { reel: 0, row: 2 },
            { reel: 1, row: 1 },
            { reel: 2, row: 2 },
          ],
            multiplier: 1,
            baseAmountMinor: "300",
            nominalAmountMinor: "300",
            amountMinor: "300",
        }],
      },
    ]);
    expect(createWinCelebrationPlan(result.wins).records.map((record) => ({
      id: record.id,
      baseAmountMinor: record.baseAmountMinor,
      amountMinor: record.amountMinor,
      multiplier: record.multiplier,
      cellCount: record.cells.length,
    }))).toEqual([
      {
        id: "continue-prism-wild-x5-four-boxes",
        baseAmountMinor: "100",
        amountMinor: "500",
        multiplier: 5,
        cellCount: 4,
      },
      {
        id: "continue-orbit-plain-sentinel",
        baseAmountMinor: "300",
        amountMinor: "300",
        multiplier: 1,
        cellCount: 3,
      },
    ]);
    expect(planBigWin(BigInt(result.totalWinMinor), BigInt(result.betMinor))).toBeNull();
    expectProductionSequence(log.sessions[0]!.featureState, [result]);
    expect(gateway.requestSpin("round-normal-win-continue-extra", "100")).toBe(false);
    expect(log.errors).toEqual([]);
  });

  it("replays one canonical MINI Wheel award without starting Free Spins", () => {
    const { gateway, log } = connectFixture("wheel-mini-flow");
    const origin = log.sessions[0]!.featureState;
    const result = deliverRound(gateway, log, "round-wheel-mini");

    expect(result).toMatchObject({
      roundId: "round-wheel-mini",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      totalWinMinor: "1200",
      balanceMinor: "101100",
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    expect(result.grid).toEqual([
      [{ symbol: "CIRCUIT" }, { symbol: "SURGE" }, { symbol: "PRISM" }],
      [{ symbol: "CIRCUIT" }, { symbol: "SURGE" }, { symbol: "NOVA" }],
      [{ symbol: "CIRCUIT" }, { symbol: "SURGE" }, { symbol: "TANK" }],
    ]);
    expect(result.wins).toEqual([{
      id: "jet-path",
      symbol: "CIRCUIT",
      ways: 1,
      nominalAmountMinor: "200",
      amountMinor: "200",
      cells: [
        { reel: 0, row: 0 },
        { reel: 1, row: 0 },
        { reel: 2, row: 0 },
      ],
      pathAwards: [{
        cells: [
          { reel: 0, row: 0 },
          { reel: 1, row: 0 },
          { reel: 2, row: 0 },
        ],
        multiplier: 1,
        baseAmountMinor: "200",
        nominalAmountMinor: "200",
        amountMinor: "200",
      }],
    }]);
    expect(result.events).toEqual([
      {
        type: "surge.collected",
        count: 3,
        cells: [
          { reel: 0, row: 1 },
          { reel: 1, row: 1 },
          { reel: 2, row: 1 },
        ],
        triggered: true,
        guaranteed: true,
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      {
        type: "wheel.awarded",
        outcome: "INSTANT",
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      },
    ]);
    expect(result.events.some(({ type }) => type === "free_spins.started")).toBe(false);
    const wheelAward = result.events[2];
    if (wheelAward?.type !== "wheel.awarded" || wheelAward.outcome !== "INSTANT") {
      throw new Error("wheel-mini-flow must carry one canonical INSTANT award");
    }
    expect(
      BigInt(result.wins[0]!.amountMinor)
        + BigInt(wheelAward.amountMinor),
    ).toBe(BigInt(result.totalWinMinor));
    expectProductionSequence(origin, [result]);

    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(wheelAward)).toBe(true);
    expect(() => {
      (wheelAward as { prize: string }).prize = "GRAND";
    }).toThrow(TypeError);
    expect(gateway.requestSpin("round-wheel-mini-extra", "100")).toBe(false);
    expect(log.results).toEqual([result]);
    expect(log.errors).toEqual([]);
  });

  it("provides an exact-three MINI Wheel round followed by one accepted Base round", () => {
    const { gateway, log } = connectFixture("autoplay-wheel-mini-resume");
    const origin = log.sessions[0]!.featureState;
    const first = deliverRound(gateway, log, "round-autoplay-wheel-mini");
    const second = deliverRound(gateway, log, "round-autoplay-wheel-resume");

    expect(first.events).toEqual([
      {
        type: "surge.collected",
        count: 3,
        cells: [
          { reel: 0, row: 1 },
          { reel: 1, row: 1 },
          { reel: 2, row: 1 },
        ],
        triggered: true,
        guaranteed: true,
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      {
        type: "wheel.awarded",
        outcome: "INSTANT",
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      },
    ]);
    expect(second).toMatchObject({
      sequence: 2,
      chargedBetMinor: "100",
      totalWinMinor: "0",
      balanceMinor: "101000",
      wins: [],
      events: [],
      featureState: origin,
    });
    expectProductionSequence(origin, [first, second]);
    expect(gateway.requestSpin("round-autoplay-wheel-resume-extra", "100")).toBe(false);
  });

  it("replays the Pass45 exact-three Wheel entry without an unrelated line win", () => {
    const { gateway, log } = connectFixture("base-three-rage-wheel-entry");
    const origin = log.sessions[0]!.featureState;
    const result = deliverRound(gateway, log, "round-base-three-rage-wheel-entry");

    expect(result).toMatchObject({
      roundId: "round-base-three-rage-wheel-entry",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      totalWinMinor: "1000",
      balanceMinor: "100900",
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    expect(result.grid).toEqual([
      [{ symbol: "PRISM" }, { symbol: "SURGE" }, { symbol: "PULSE" }],
      [{ symbol: "SURGE" }, { symbol: "NOVA" }, { symbol: "VAULT" }],
      [{ symbol: "TANK" }, { symbol: "TANK" }, { symbol: "SURGE" }],
    ]);
    expect(result.grid.flat().filter((entry) => entry.symbol === "SURGE")).toHaveLength(3);
    expect(result.wins).toEqual([]);
    expect(result.events).toEqual([
      { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vaults.locked", count: 1, cells: [{ reel: 1, row: 2 }] },
      {
        type: "surge.collected",
        count: 3,
        cells: [{ reel: 0, row: 1 }, { reel: 1, row: 0 }, { reel: 2, row: 2 }],
        triggered: true,
        guaranteed: true,
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      {
        type: "wheel.awarded",
        outcome: "INSTANT",
        prize: "MINI",
        multiplier: 10,
        amountMinor: "1000",
      },
    ]);
    expectProductionSequence(origin, [result]);
    expect(gateway.requestSpin("round-base-three-rage-wheel-entry-extra", "100")).toBe(false);
    expect(log.results).toEqual([result]);
    expect(log.errors).toEqual([]);
  });

  it("replays all eight King Spins with complete Vault awards and terminal settlement", () => {
    const { gateway, log } = connectFixture("king-flow");
    const trigger = deliverRound(gateway, log, "round-king-trigger");
    const freeSpins = Array.from({ length: 8 }, (_, index) => (
      deliverRound(gateway, log, `round-king-${index + 1}`)
    ));
    const vaultRound = freeSpins[1]!;
    const terminal = freeSpins[7]!;

    expect(trigger.events.map(({ type }) => type)).toEqual([
      "surge.collected",
      "wheel.started",
      "wheel.awarded",
      "free_spins.started",
    ]);
    expect(trigger.featureState).toEqual({
      mode: "OVERDRIVE",
      freeSpinsRemaining: 8,
      freeSpinsPlayed: 0,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 1,
      rageCollected: 0,
    });
    expect(vaultRound.events.map(({ type }) => type)).toEqual([
      "vaults.landed",
      "vaults.unlock.started",
      "vault.unlocked",
      "vault.unlocked",
      "vault.unlocked",
      "vaults.unlock.completed",
      "vaults.upgrade.started",
      "vault.upgraded",
      "vault.awarded",
      "vault.awarded",
      "vault.awarded",
    ]);
    expect(vaultRound.grid[1]?.[0]).toEqual({ symbol: "VAULT", prize: "MINI_2X", multiplier: 20 });
    expect(vaultRound.grid[1]?.[1]).toEqual({ symbol: "VAULT", prize: "MINOR", multiplier: 30 });
    expect(vaultRound.grid[1]?.[2]).toEqual({ symbol: "VAULT", prize: "MAJOR", multiplier: 75 });
    expect(vaultRound.events.filter(({ type }) => type === "vault.unlocked").map((event) => (
      "reel" in event ? [event.reel, event.row] : null
    ))).toEqual([[1, 0], [1, 1], [1, 2]]);
    expect(vaultRound.events.filter(({ type }) => type === "vault.awarded")).toEqual([
      expect.objectContaining({ reel: 1, row: 0, prize: "MINI_2X", multiplier: 20, amountMinor: "2000" }),
      expect.objectContaining({ reel: 1, row: 1, prize: "MINOR", multiplier: 30, amountMinor: "3000" }),
      expect.objectContaining({ reel: 1, row: 2, prize: "MAJOR", multiplier: 75, amountMinor: "7500" }),
    ]);
    expect(vaultRound).toMatchObject({
      sequence: 3,
      chargedBetMinor: "0",
      totalWinMinor: "12500",
      balanceMinor: "112400",
      featureState: {
        mode: "OVERDRIVE",
        freeSpinsRemaining: 6,
        freeSpinsPlayed: 2,
        freeSpinsWinMinor: "12500",
      },
    });
    expect(terminal).toMatchObject({
      sequence: 9,
      roundId: "round-king-8",
      chargedBetMinor: "0",
      totalWinMinor: "0",
      balanceMinor: "112400",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
      events: [{
        type: "free_spins.completed",
        mode: "OVERDRIVE",
        awarded: 8,
        cumulativeWinMinor: "12500",
      }],
    });
    expect(freeSpins.slice(0, 7).map(({ featureState }) => featureState.freeSpinsRemaining))
      .toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(trigger.requestId).not.toBe(terminal.requestId);
    expect(trigger.sessionId).toBe(terminal.sessionId);
    for (const result of [trigger, ...freeSpins]) {
      expect(decodeServerMessage(result)).toEqual(result);
    }
    expect(gateway.requestSpin("round-king-extra", "100")).toBe(false);
  });

  it("resets a level-four probabilistic Rage trigger through King exit and the next Base spin", () => {
    const { gateway, log } = connectFixture("high-pps-probability-king-exit");
    const initialState = log.sessions[0]!.featureState;
    expect(initialState).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 4,
      rageCollected: 36,
    });

    const results = Array.from({ length: 10 }, (_, index) => (
      deliverRound(gateway, log, `round-high-pps-king-${index}`)
    ));
    const trigger = results[0]!;
    const freeSpins = results.slice(1, 9);
    const terminal = freeSpins[7]!;
    const baseFollowUp = results[9]!;

    expect(trigger.events).toEqual([
      {
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 0, row: 1 }],
        triggered: true,
        guaranteed: false,
        level: 1,
        total: 0,
      },
      {
        type: "rage.transformed",
        count: 2,
        cells: [{ reel: 1, row: 1 }, { reel: 2, row: 1 }],
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" },
      { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
    ]);
    expect(trigger.featureState).toEqual({
      mode: "OVERDRIVE",
      freeSpinsRemaining: 8,
      freeSpinsPlayed: 0,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 1,
      rageCollected: 0,
    });
    expect(freeSpins.slice(0, 7).map(({ featureState }) => featureState)).toEqual(
      [7, 6, 5, 4, 3, 2, 1].map((freeSpinsRemaining, index) => ({
        mode: "OVERDRIVE",
        freeSpinsRemaining,
        freeSpinsPlayed: index + 1,
        baseBetMinor: "100",
        freeSpinsWinMinor: "0",
        rageLevel: 1,
        rageCollected: 0,
      })),
    );
    expect(terminal).toMatchObject({
      sequence: 9,
      chargedBetMinor: "0",
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
      events: [{
        type: "free_spins.completed",
        mode: "OVERDRIVE",
        awarded: 8,
        cumulativeWinMinor: "0",
      }],
    });
    expect(baseFollowUp).toMatchObject({
      sequence: 10,
      chargedBetMinor: "100",
      totalWinMinor: "0",
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
      events: [],
    });
    expectProductionSequence(initialState, results);
    expect(gateway.requestSpin("round-high-pps-king-extra", "100")).toBe(false);
    expect(log.errors).toEqual([]);
  });

  it("replays two complete King upgrade steps before three GRAND awards", () => {
    const { gateway, log } = connectFixture("king-upgrade-ladder");
    const results = Array.from({ length: 9 }, (_, index) => (
      deliverRound(gateway, log, `round-king-ladder-${index}`)
    ));
    const trigger = results[0]!;
    const ladderRound = results[2]!;
    const terminal = results[8]!;

    expect(trigger.events.map(({ type }) => type)).toEqual([
      "surge.collected",
      "wheel.started",
      "wheel.awarded",
      "free_spins.started",
    ]);
    expect(trigger.events.at(-2)).toEqual({
      type: "wheel.awarded",
      outcome: "OVERDRIVE",
      prize: "KING_SPIN",
    });
    expect(ladderRound.events.map(({ type }) => type)).toEqual([
      "vaults.landed",
      "vaults.unlock.started",
      "vault.unlocked",
      "vault.unlocked",
      "vault.unlocked",
      "vaults.unlock.completed",
      "vaults.upgrade.started",
      "vault.upgraded",
      "vault.upgraded",
      "vault.upgraded",
      "vaults.upgrade.started",
      "vault.upgraded",
      "vault.upgraded",
      "vault.upgraded",
      "vault.awarded",
      "vault.awarded",
      "vault.awarded",
      "win_cap.reached",
    ]);
    expect(ladderRound.events.filter(({ type }) => type === "vaults.upgrade.started"))
      .toEqual([
        { type: "vaults.upgrade.started", count: 3, step: 1 },
        { type: "vaults.upgrade.started", count: 3, step: 2 },
      ]);
    expect(ladderRound.events.filter(({ type }) => type === "vault.upgraded").map((event) => (
      event.type === "vault.upgraded"
        ? [event.step, event.row, event.fromMultiplier, event.toMultiplier, event.prize]
        : null
    ))).toEqual([
      [1, 0, 10, 250, "MEGA"],
      [1, 1, 10, 250, "MEGA"],
      [1, 2, 10, 250, "MEGA"],
      [2, 0, 250, 1_000, "GRAND"],
      [2, 1, 250, 1_000, "GRAND"],
      [2, 2, 250, 1_000, "GRAND"],
    ]);
    expect(ladderRound.grid[1]).toEqual(Array.from({ length: 3 }, () => ({
      symbol: "VAULT",
      prize: "GRAND",
      multiplier: 1_000,
    })));
    expect(ladderRound.events.filter(({ type }) => type === "vault.awarded"))
      .toEqual(Array.from({ length: 3 }, (_, row) => ({
        type: "vault.awarded",
        reel: 1,
        row,
        prize: "GRAND",
        multiplier: 1_000,
        amountMinor: row === 2 ? "50000" : "100000",
      })));
    expect(ladderRound.events.at(-1)).toEqual({
      type: "win_cap.reached",
      multiplier: 2_500,
      cumulativeWinMinor: "250000",
    });
    expect(ladderRound).toMatchObject({
      sequence: 3,
      chargedBetMinor: "0",
      totalWinMinor: "250000",
      balanceMinor: "349900",
      featureState: {
        mode: "OVERDRIVE",
        freeSpinsRemaining: 6,
        freeSpinsPlayed: 2,
        baseBetMinor: "100",
        freeSpinsWinMinor: "250000",
      },
    });
    expect(terminal).toMatchObject({
      sequence: 9,
      chargedBetMinor: "0",
      totalWinMinor: "0",
      balanceMinor: "349900",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
      events: [{
        type: "free_spins.completed",
        mode: "OVERDRIVE",
        awarded: 8,
        cumulativeWinMinor: "250000",
      }],
    });
    expect(results.slice(1, 8).map(({ featureState }) => (
      featureState.freeSpinsRemaining
    ))).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expectProductionSequence(log.sessions[0]!.featureState, results);
    expect(gateway.requestSpin("round-king-ladder-extra", "100")).toBe(false);
    expect(log.errors).toEqual([]);
  });

  it("replays Kong row changes, all 512 paths, a retrigger, and terminal exit", () => {
    const { gateway, log } = connectFixture("kong-flow");
    const trigger = deliverRound(gateway, log, "round-kong-trigger");
    const freeSpins = Array.from({ length: 9 }, (_, index) => (
      deliverRound(gateway, log, `round-kong-${index + 1}`)
    ));
    const waysRound = freeSpins[2]!;
    const retriggerRound = freeSpins[3]!;
    const terminal = freeSpins[8]!;

    expect(trigger.events.at(-2)).toEqual(expect.objectContaining({
      type: "wheel.awarded",
      outcome: "EXPANSION",
      prize: "KONG_QUEST",
    }));
    expect(freeSpins.map(({ grid }) => grid[0]?.length))
      .toEqual([3, 5, 8, 8, 6, 7, 4, 8, 3]);
    expect(freeSpins.map(({ events }) => events[0])).toEqual(
      freeSpins.map(({ grid }) => ({
        type: "grid.expanded",
        rows: grid[0]!.length,
        ways: grid[0]!.length ** 3,
      })),
    );
    expect(waysRound.wins).toHaveLength(1);
    expect(waysRound.wins[0]).toMatchObject({
      id: "orbit-512-ways",
      symbol: "ORBIT",
      ways: 512,
      amountMinor: "15360",
      multiplier: 1,
    });
    expect(waysRound.wins[0]?.cells).toHaveLength(24);
    expect(waysRound.wins[0]?.pathAwards).toHaveLength(512);
    expect(new Set(waysRound.wins[0]?.pathAwards?.map((award) => (
      award.cells.map(({ row }) => row).join(":")
    ))).size).toBe(512);
    expect(retriggerRound.events.map(({ type }) => type)).toEqual([
      "grid.expanded",
      "vaults.landed",
      "vaults.unlock.started",
      "vault.unlocked",
      "free_spin.awarded",
      "vaults.unlock.completed",
    ]);
    expect(retriggerRound.featureState).toMatchObject({
      mode: "EXPANSION",
      freeSpinsRemaining: 5,
      freeSpinsPlayed: 4,
      freeSpinsWinMinor: "15360",
    });
    expect(terminal).toMatchObject({
      sequence: 10,
      chargedBetMinor: "0",
      totalWinMinor: "0",
      balanceMinor: "115260",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(terminal.events.at(-1)).toEqual({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 9,
      cumulativeWinMinor: "15360",
    });
    for (const result of [trigger, ...freeSpins]) {
      expect(decodeServerMessage(result)).toEqual(result);
    }
    expect(gateway.requestSpin("round-kong-extra", "100")).toBe(false);
  });

  it("replays a Base-origin CAP session with two capped Vaults and one winning summary", () => {
    const { gateway, log } = connectFixture("cap-summary");
    expect(log.sessions[0]?.featureState).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    });
    const results = Array.from({ length: 9 }, (_, index) => (
      deliverRound(gateway, log, `round-cap-${index}`)
    ));
    const trigger = results[0]!;
    const capRounds = [results[1]!, results[2]!];
    const freeSpins = results.slice(1);
    const terminal = results[8]!;

    expect(trigger.events.map(({ type }) => type)).toEqual([
      "surge.collected",
      "wheel.started",
      "wheel.awarded",
      "free_spins.started",
    ]);
    expect(trigger.events.at(-2)).toEqual(expect.objectContaining({
      type: "wheel.awarded",
      outcome: "EXPANSION",
      prize: "KONG_QUEST",
    }));
    expect(trigger.events.at(-1)).toEqual({
      type: "free_spins.started",
      mode: "EXPANSION",
      awarded: 8,
    });
    expect(trigger).toMatchObject({
      sequence: 1,
      chargedBetMinor: "100",
      totalWinMinor: "0",
      balanceMinor: "99900",
      featureState: {
        mode: "EXPANSION",
        freeSpinsRemaining: 8,
        freeSpinsPlayed: 0,
        baseBetMinor: "100",
        freeSpinsWinMinor: "0",
      },
    });
    for (const capRound of capRounds) {
      expect(capRound.events.map(({ type }) => type)).toEqual([
        "grid.expanded",
        "vaults.landed",
        "vaults.unlock.started",
        "vault.unlocked",
        "free_spin.cap_reached",
        "vaults.unlock.completed",
      ]);
      expect(capRound.events[0]).toEqual({ type: "grid.expanded", rows: 8, ways: 512 });
      expect(capRound.grid[1]?.[2]).toEqual({ symbol: "VAULT", prize: "FREE_SPIN" });
      expect(capRound.events.filter(({ type }) => type === "free_spin.awarded")).toEqual([]);
      expect(capRound.events.find(({ type }) => type === "free_spin.cap_reached"))
        .toEqual({ type: "free_spin.cap_reached", reel: 1, row: 2 });
    }
    expect(freeSpins.map(({ events }) => events[0])).toEqual(
      freeSpins.map(({ grid }) => ({
        type: "grid.expanded",
        rows: grid[0]!.length,
        ways: grid[0]!.length ** 3,
      })),
    );
    expect(freeSpins.slice(0, 7).map(({ featureState }) => ({
      remaining: featureState.freeSpinsRemaining,
      played: featureState.freeSpinsPlayed,
      awarded: featureState.freeSpinsRemaining + (featureState.freeSpinsPlayed ?? 0),
    }))).toEqual([
      { remaining: 7, played: 1, awarded: 8 },
      { remaining: 6, played: 2, awarded: 8 },
      { remaining: 5, played: 3, awarded: 8 },
      { remaining: 4, played: 4, awarded: 8 },
      { remaining: 3, played: 5, awarded: 8 },
      { remaining: 2, played: 6, awarded: 8 },
      { remaining: 1, played: 7, awarded: 8 },
    ]);
    expect(results.map(({ balanceMinor }) => balanceMinor)).toEqual([
      "99900", "99900", "99900", "99900", "99900",
      "99900", "99900", "99900", "100250",
    ]);
    expect(terminal).toMatchObject({
      sequence: 9,
      chargedBetMinor: "0",
      totalWinMinor: "350",
      balanceMinor: "100250",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(terminal.wins).toEqual([expect.objectContaining({
      id: "tank-path",
      symbol: "TANK",
      ways: 1,
      amountMinor: "350",
      pathAwards: [expect.objectContaining({
        baseAmountMinor: "350",
        amountMinor: "350",
      })],
    })]);
    expect(terminal.events.at(-1)).toEqual({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "350",
    });
    expect(BigInt(terminal.totalWinMinor)).toBeGreaterThan(BigInt(terminal.betMinor));
    expectProductionSequence(log.sessions[0]!.featureState, results);
    expect(gateway.requestSpin("round-cap-extra", "100")).toBe(false);
    expect(log.results).toHaveLength(9);
  });

  it("replays eight zero-win Free Spins and restores Base without a summary panel", () => {
    const { gateway, log } = connectFixture("summary-no-panel");
    const results = Array.from({ length: 9 }, (_, index) => (
      deliverRound(gateway, log, `round-no-panel-${index}`)
    ));
    const freeSpins = results.slice(1);
    const terminal = results[8]!;

    expect(log.sessions[0]?.featureState).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    });
    expect(results[0]).toMatchObject({
      chargedBetMinor: "100",
      totalWinMinor: "0",
      balanceMinor: "99900",
      featureState: { mode: "EXPANSION", freeSpinsRemaining: 8, freeSpinsPlayed: 0 },
    });
    expect(results.every(({ totalWinMinor }) => totalWinMinor === "0")).toBe(true);
    expect(results.map(({ balanceMinor }) => balanceMinor)).toEqual(Array(9).fill("99900"));
    expect(freeSpins.map(({ events }) => events[0])).toEqual(
      freeSpins.map(({ grid }) => ({
        type: "grid.expanded",
        rows: grid[0]!.length,
        ways: grid[0]!.length ** 3,
      })),
    );
    expect(freeSpins.slice(0, 7).map(({ featureState }) => (
      [featureState.freeSpinsRemaining, featureState.freeSpinsPlayed]
    ))).toEqual([[7, 1], [6, 2], [5, 3], [4, 4], [3, 5], [2, 6], [1, 7]]);
    expect(terminal).toMatchObject({
      sequence: 9,
      chargedBetMinor: "0",
      totalWinMinor: "0",
      balanceMinor: "99900",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(terminal.events[0]).toEqual({ type: "grid.expanded", rows: 8, ways: 512 });
    expect(terminal.events.at(-1)).toEqual({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "0",
    });
    expectProductionSequence(log.sessions[0]!.featureState, results);
    expect(gateway.requestSpin("round-no-panel-extra", "100")).toBe(false);
    expect(log.results).toHaveLength(9);
  });

  it("keeps cumulative win equal to the locked bet on the no-summary branch", () => {
    const { gateway, log } = connectFixture("summary-no-panel-equal");
    const results = Array.from({ length: 9 }, (_, index) => (
      deliverRound(gateway, log, `round-no-panel-equal-${index}`)
    ));
    const freeSpins = results.slice(1);
    const winRound = results[7]!;
    const terminal = results[8]!;

    expect(results.slice(0, 7).map(({ balanceMinor }) => balanceMinor))
      .toEqual(Array(7).fill("99900"));
    expect(winRound).toMatchObject({
      sequence: 8,
      chargedBetMinor: "0",
      totalWinMinor: "100",
      balanceMinor: "100000",
      featureState: {
        mode: "EXPANSION",
        freeSpinsRemaining: 1,
        freeSpinsPlayed: 7,
        baseBetMinor: "100",
        freeSpinsWinMinor: "100",
      },
    });
    expect(winRound.wins[0]).toMatchObject({
      id: "tank-path",
      amountMinor: "100",
      pathAwards: [{ baseAmountMinor: "100", amountMinor: "100" }],
    });
    expect(terminal).toMatchObject({
      sequence: 9,
      chargedBetMinor: "0",
      totalWinMinor: "0",
      balanceMinor: "100000",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(terminal.events).toEqual([
      { type: "grid.expanded", rows: 8, ways: 512 },
      {
        type: "free_spins.completed",
        mode: "EXPANSION",
        awarded: 8,
        cumulativeWinMinor: "100",
      },
    ]);
    expect(terminal.events.at(-1)).toEqual(expect.objectContaining({
      cumulativeWinMinor: terminal.betMinor,
    }));
    expect(freeSpins.every(({ chargedBetMinor }) => chargedBetMinor === "0")).toBe(true);
    expect(freeSpins.every(({ events, grid }) => (
      events[0]?.type === "grid.expanded"
      && events[0].rows === grid[0]?.length
      && events[0].ways === (grid[0]?.length ?? 0) ** 3
    ))).toBe(true);
    expectProductionSequence(log.sessions[0]!.featureState, results);
    expect(gateway.requestSpin("round-no-panel-equal-extra", "100")).toBe(false);
    expect(log.results).toHaveLength(9);
  });

  it("rejects non-advertised bets and a second pending request", () => {
    const { gateway, log } = connectFixture("big-win");

    expect(gateway.requestSpin("round-wrong-bet", "0100")).toBe(false);
    expect(gateway.requestSpin("round-wrong-bet", "200")).toBe(false);
    expect(gateway.requestSpin("round-first", "100")).toBe(true);
    expect(gateway.requestSpin("round-second", "100")).toBe(false);
    expect(gateway.requestSpin("round id with spaces", "100")).toBe(false);
    expect(gateway.hasPendingSpin).toBe(true);
    vi.runOnlyPendingTimers();
    expect(log.results.map(({ roundId }) => roundId)).toEqual(["round-first"]);
  });

  it("cancels pending delivery and reports offline on close", () => {
    const { gateway, log } = connectFixture("big-win");
    expect(gateway.requestSpin("round-cancelled", "100")).toBe(true);
    gateway.close();

    expect(gateway.hasPendingSpin).toBe(false);
    expect(log.statuses.at(-1)).toBe("offline");
    vi.runOnlyPendingTimers();
    expect(log.results).toEqual([]);
    expect(log.errors).toEqual([]);
  });

  it("keeps the fixture entry isolated from the production entry", () => {
    expect(indexHtml).not.toMatch(/visual-fixture|src\/testing/i);
    expect(productionMain).not.toMatch(/VisualFixture|src\/testing|[?&]scenario/i);
    expect(fixtureHtml).toContain("/src/testing/visualFixturesMain.ts");
    expect(fixtureHtml).not.toContain("/src/main.ts");
  });
});
