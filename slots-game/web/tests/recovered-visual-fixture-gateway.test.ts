import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FeatureState,
  SessionOpened,
  SpinResult,
} from "../src/app/state/types";
import type {
  GatewayCallbacks,
  GatewayStatus,
} from "../src/protocol/GameGateway";
import { validateSpinResultAgainstOrigin } from "../src/protocol/spinResultOriginGuard";
import {
  createRecoveredVisualFixtureGateway,
  RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO,
  RecoveredVisualFixtureGateway,
} from "../src/testing/RecoveredVisualFixtureGateway";
import { VisualFixtureGateway } from "../src/testing/VisualFixtureGateway";

const ORIGIN_FEATURE_STATE: Readonly<FeatureState> = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 1,
  rageCollected: 11,
};

const FINAL_FEATURE_STATE: Readonly<FeatureState> = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 2,
  rageCollected: 12,
};

describe("recovered level-up visual fixture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("authors the exact immutable zero-win 1/11 -> 2/12 round", () => {
    const gateway = new VisualFixtureGateway(RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO);
    const sessions: SessionOpened[] = [];
    const results: SpinResult[] = [];
    gateway.setCallbacks({
      onStatus: vi.fn(),
      onSession: (session) => sessions.push(session),
      onSpinResult: (result) => results.push(result),
      onError: vi.fn(),
    });

    gateway.connect();
    vi.runOnlyPendingTimers();
    expect(sessions[0]).toMatchObject({
      balanceMinor: "100000",
      featureState: ORIGIN_FEATURE_STATE,
    });
    expect(sessions[0]?.featureState).toEqual(ORIGIN_FEATURE_STATE);

    expect(gateway.requestSpin("fixture-level-up-round", "100")).toBe(true);
    vi.runOnlyPendingTimers();
    const result = results[0]!;
    expect(result).toMatchObject({
      roundId: "fixture-level-up-round",
      sequence: 1,
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "99900",
      totalWinMinor: "0",
      wins: [],
      featureState: FINAL_FEATURE_STATE,
    });
    expect(result.featureState).toEqual(FINAL_FEATURE_STATE);
    expect(result.grid).toEqual([
      [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "ORBIT" }],
      [{ symbol: "SURGE" }, { symbol: "NOVA" }, { symbol: "TANK" }],
      [{ symbol: "CIRCUIT" }, { symbol: "NOVA" }, { symbol: "TANK" }],
    ]);
    expect(result.grid.flat().filter(({ symbol }) => symbol === "SURGE")).toEqual([
      { symbol: "SURGE" },
    ]);
    expect(result.events).toEqual([{
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 2,
      total: 12,
    }]);
    expect(() => validateSpinResultAgainstOrigin(ORIGIN_FEATURE_STATE, result)).not.toThrow();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid)).toBe(true);
    expect(Object.isFrozen(result.grid[1]?.[0])).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.isFrozen(result.featureState)).toBe(true);
  });

  it("replays the committed result after the already-advanced session and retains it until exact ACK", () => {
    let launchReady = false;
    const gateway = createRecoveredVisualFixtureGateway(() => launchReady);
    const order: string[] = [];
    const statuses: GatewayStatus[] = [];
    const sessions: SessionOpened[] = [];
    const results: SpinResult[] = [];
    const origins: Readonly<FeatureState>[] = [];
    const pendingSamples: boolean[] = [];
    const errors: unknown[] = [];
    const callbacks: GatewayCallbacks = {
      onStatus: (status) => {
        statuses.push(status);
        order.push(status);
      },
      onSession: (session) => {
        pendingSamples.push(gateway.hasPendingSpin);
        sessions.push(session);
        order.push("advanced session");
      },
      onSpinResult: (result, origin) => {
        pendingSamples.push(gateway.hasPendingSpin);
        results.push(result);
        origins.push(origin!);
        order.push("recovered result");
      },
      onError: (error) => errors.push(error),
    };
    gateway.setCallbacks(callbacks);

    expect(gateway).toBeInstanceOf(RecoveredVisualFixtureGateway);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("user-spin", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("fixture-rgs-recovered-level-up", 1)).toBe(false);
    gateway.connect();
    expect(order).toEqual(["connecting"]);
    vi.runAllTimers();

    expect(order).toEqual([
      "connecting",
      "online",
      "advanced session",
      "recovered result",
    ]);
    expect(statuses).toEqual(["connecting", "online"]);
    expect(pendingSamples).toEqual([true, true]);
    expect(errors).toEqual([]);
    expect(sessions[0]).toMatchObject({
      balanceMinor: "99900",
      featureState: FINAL_FEATURE_STATE,
    });
    expect(sessions[0]?.featureState).toEqual(FINAL_FEATURE_STATE);
    expect(results[0]).toMatchObject({
      balanceMinor: "99900",
      chargedBetMinor: "100",
      totalWinMinor: "0",
      featureState: FINAL_FEATURE_STATE,
    });
    expect(results[0]?.featureState).toEqual(FINAL_FEATURE_STATE);
    expect(origins).toEqual([ORIGIN_FEATURE_STATE]);
    expect(Object.isFrozen(sessions[0])).toBe(true);
    expect(Object.isFrozen(sessions[0]?.featureState)).toBe(true);
    expect(Object.isFrozen(origins[0])).toBe(true);

    const delivered = results[0]!;
    expect(gateway.diagnostics).toEqual({
      pendingAtSession: true,
      pendingAtResult: true,
      deliveredBeforeLaunch: true,
      deliveryCount: 1,
      acknowledgementCount: 0,
      deliveredOrigin: origins[0],
      deliveredResult: delivered,
    });
    expect(Object.isFrozen(gateway.diagnostics)).toBe(true);
    expect(gateway.diagnostics.deliveredOrigin).toBe(origins[0]);
    expect(gateway.diagnostics.deliveredResult).toBe(delivered);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("user-spin-after-recovery", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("wrong-round", delivered.sequence)).toBe(false);
    expect(gateway.acknowledgeSpinResult(delivered.roundId, delivered.sequence + 1)).toBe(false);
    expect(gateway.acknowledgeSpinResult(delivered.roundId, delivered.sequence)).toBe(true);
    expect(gateway.hasPendingSpin).toBe(false);
    expect(gateway.acknowledgeSpinResult(delivered.roundId, delivered.sequence)).toBe(false);
    expect(gateway.diagnostics.acknowledgementCount).toBe(1);

    launchReady = true;
    expect(gateway.diagnostics.deliveredBeforeLaunch).toBe(true);
    gateway.close();
    gateway.close();
    expect(statuses).toEqual(["connecting", "online", "offline"]);
  });

  it("keeps unacknowledged durable pending state across idempotent close", () => {
    const gateway = new RecoveredVisualFixtureGateway();
    const statuses: GatewayStatus[] = [];
    gateway.setCallbacks({
      onStatus: (status) => statuses.push(status),
      onSession: vi.fn(),
      onSpinResult: vi.fn(),
      onError: vi.fn(),
    });

    gateway.close();
    gateway.close();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(statuses).toEqual(["offline"]);
    gateway.connect();
    vi.runAllTimers();
    expect(statuses).toEqual(["offline"]);
  });
});
