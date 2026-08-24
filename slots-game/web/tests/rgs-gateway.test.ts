import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FeatureState,
  SessionOpened,
  SpinResult,
} from "../src/app/state/types";
import {
  JsonRgsRecoveryLedgerStorage,
  RgsGateway,
  RgsGatewayConfigurationError,
  distributedRetryDelayMs,
  type RgsGatewayConfig,
} from "../src/protocol/RgsGateway";
import type {
  GatewayCallbacks,
  GatewaySessionTimeout,
  GatewayStatus,
} from "../src/protocol/GameGateway";
import { NETWORK_RESPONSE_LIMITS } from "../src/network/boundedResponse";

const HASH = "a".repeat(64);
const LAUNCH_CODE = `lc_${"b".repeat(43)}`;
const TOKEN_ONE = "token-one".padEnd(80, "x");
const TOKEN_TWO = "token-two".padEnd(80, "y");
const FINGERPRINT = "c".repeat(64);

interface SeenRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly redirect: RequestRedirect | undefined;
  readonly signal?: AbortSignal;
}

interface CallbackLog {
  readonly statuses: GatewayStatus[];
  readonly sessions: SessionOpened[];
  readonly results: { result: SpinResult; origin?: Readonly<FeatureState> }[];
  readonly timeouts: GatewaySessionTimeout[];
  readonly errors: unknown[];
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function responseWithRetryAfter(data: unknown, status: number, retryAfter: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": retryAfter,
    },
  });
}

function edgeRateLimitedResponse(
  retryAfter = "30",
  marker = "RATE_LIMITED",
): Response {
  return new Response(null, {
    status: 429,
    headers: {
      "Retry-After": retryAfter,
      "X-RGS-Edge-Error": marker,
    },
  });
}

function requestId(init?: RequestInit): string {
  const value = new Headers(init?.headers).get("X-Request-Id");
  if (!value) throw new Error("request omitted X-Request-Id");
  return value;
}

function seenRequest(url: string | URL | Request, init?: RequestInit): SeenRequest {
  if (typeof init?.body !== "string") throw new Error("request omitted JSON body");
  return {
    url: String(url),
    body: JSON.parse(init.body) as Record<string, unknown>,
    headers: new Headers(init.headers),
    redirect: init.redirect,
    ...(init.signal ? { signal: init.signal } : {}),
  };
}

function feature(
  mode: "NONE" | "EXPANSION" | "OVERDRIVE" = "NONE",
  remaining = 0,
  awarded = 0,
  betMinor = "0",
  winMinor = "0",
  rageLevel = 1,
  rageCollected = 0,
): Record<string, unknown> {
  return {
    mode,
    remaining,
    awarded,
    betMinor,
    winMinor,
    rageLevel,
    rageCollected,
  };
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operatorId: "operator-a",
    sessionId: "session-a",
    gameId: "primal-rampage",
    definitionVersion: "definition-1",
    definitionHash: HASH,
    currency: "EUR",
    currencyExponent: 2,
    jurisdiction: "GB",
    status: "ACTIVE",
    expiresAt: "2030-01-01T00:00:00Z",
    idleDisconnectAt: "2029-12-31T23:30:00Z",
    balanceMinor: "1000",
    revision: "0",
    sequence: "0",
    feature: feature(),
    ...overrides,
  };
}

function exchangeEnvelope(
  id: string,
  overrides: Record<string, unknown> = {},
  token = TOKEN_ONE,
  serverTime = "2029-12-31T23:00:00Z",
): Record<string, unknown> {
  return {
    data: {
      accessToken: token,
      serverTime,
      session: session(overrides),
    },
    requestId: id,
  };
}

const BASE_GRID = [
  [{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
  [{ symbol: "NOVA" }, { symbol: "CIRCUIT" }, { symbol: "TANK" }],
  [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "NOVA" }],
];

const ONE_RAGE_GRID = [
  [{ symbol: "SURGE" }, { symbol: "PRISM" }, { symbol: "PULSE" }],
  [{ symbol: "NOVA" }, { symbol: "CIRCUIT" }, { symbol: "TANK" }],
  [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "NOVA" }],
];

const THREE_RAGE_CELLS = [
  { reel: 0, row: 2 },
  { reel: 1, row: 2 },
  { reel: 2, row: 2 },
];

const THREE_RAGE_GRID = BASE_GRID.map((reel) => (
  reel.map((cell, row) => row === 2 ? { symbol: "SURGE" } : cell)
));

function fullEvent(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    count: 0,
    cells: [],
    triggered: false,
    guaranteed: false,
    outcome: "",
    prize: "",
    multiplier: "0",
    amountMinor: "0",
    cumulativeWinMinor: "0",
    mode: "NONE",
    awarded: 0,
    rows: 0,
    ways: 0,
    reel: 0,
    row: 0,
    level: 0,
    total: 0,
    step: 0,
    fromMultiplier: "0",
    toMultiplier: "0",
    ...overrides,
  };
}

interface ResultOptions {
  readonly roundId?: string;
  readonly roundKind?: "BASE" | "FREE_SPIN";
  readonly startRevision?: string;
  readonly endRevision?: string;
  readonly sequence?: string;
  readonly chargedBetMinor?: string;
  readonly balanceMinor?: string;
  readonly grid?: unknown[];
  readonly events?: unknown[];
  readonly nextFeature?: Record<string, unknown>;
  readonly idleDisconnectAt?: string;
}

const RESULT_HASH = "c".repeat(64);

function committedResult(options: ResultOptions = {}): Record<string, unknown> {
  return {
    operatorId: "operator-a",
    sessionId: "session-a",
    roundId: options.roundId ?? "round-a",
    gameId: "primal-rampage",
    definitionVersion: "definition-1",
    definitionHash: HASH,
    currency: "EUR",
    roundKind: options.roundKind ?? "BASE",
    serverTransactionId: "server-tx-a",
    walletTransactionId: "wallet-tx-a",
    startRevision: options.startRevision ?? "0",
    endRevision: options.endRevision ?? "1",
    sequence: options.sequence ?? "1",
    resultHash: RESULT_HASH,
    idleDisconnectAt: options.idleDisconnectAt ?? "2029-12-31T23:45:00Z",
    betMinor: "100",
    chargedBetMinor: options.chargedBetMinor ?? "100",
    balanceMinor: options.balanceMinor ?? "900",
    totalWinMinor: "0",
    grid: options.grid ?? BASE_GRID,
    wins: [],
    events: options.events ?? [],
    feature: options.nextFeature ?? feature(),
  };
}

function acknowledgementEnvelope(
  id: string,
  result: Record<string, unknown> = committedResult(),
): Record<string, unknown> {
  return {
    data: {
      operatorId: "operator-a",
      sessionId: "session-a",
      roundId: result.roundId,
      sequence: result.sequence,
      resultHash: result.resultHash,
      acknowledgedAt: "2026-08-13T12:00:00Z",
    },
    requestId: id,
  };
}

function acknowledgementEnvelopeFromRequest(init?: RequestInit): Record<string, unknown> {
  const request = seenRequest("https://rgs.example/client/v1/results/acknowledgements", init);
  return {
    data: {
      operatorId: request.body.operatorId,
      sessionId: request.body.sessionId,
      roundId: request.body.roundId,
      sequence: request.body.sequence,
      resultHash: request.body.resultHash,
      acknowledgedAt: "2026-08-13T12:00:00Z",
    },
    requestId: requestId(init),
  };
}

function levelTwoRageResult(): Record<string, unknown> {
  return committedResult({
    grid: ONE_RAGE_GRID,
    events: [fullEvent("surge.collected", {
      count: 1,
      cells: [{ reel: 0, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 2,
      total: 12,
    })],
    nextFeature: feature("NONE", 0, 0, "0", "0", 2, 12),
  });
}

function directThreeRageResult(): Record<string, unknown> {
  return committedResult({
    grid: THREE_RAGE_GRID,
    events: [
      fullEvent("surge.collected", {
        count: 3,
        cells: THREE_RAGE_CELLS,
        triggered: true,
        guaranteed: true,
        level: 1,
        total: 0,
      }),
      fullEvent("wheel.started"),
      fullEvent("wheel.awarded", { outcome: "EXPANSION" }),
      fullEvent("free_spins.started", { mode: "EXPANSION", awarded: 8 }),
    ],
    nextFeature: feature("EXPANSION", 8, 8, "100", "0", 1, 0),
  });
}

function successEnvelope(id: string, result: Record<string, unknown>): Record<string, unknown> {
  return { data: result, requestId: id };
}

function statusEnvelope(
  id: string,
  status: "PREPARED" | "WALLET_PENDING" | "COMMITTED" | "REJECTED" | "MANUAL_REVIEW",
  result?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    data: {
      operatorId: "operator-a",
      sessionId: "session-a",
      roundId: "round-a",
      status,
      ...(result ? { result } : {}),
    },
    requestId: id,
  };
}

function pendingResultEnvelope(
  id: string,
  result: Record<string, unknown>,
  originFeature: Record<string, unknown>,
): Record<string, unknown> {
  return {
    data: {
      operatorId: result.operatorId,
      sessionId: result.sessionId,
      roundId: result.roundId,
      sequence: result.sequence,
      resultHash: result.resultHash,
      originFeature,
      result,
    },
    requestId: id,
  };
}

function errorEnvelope(id: string, code: string, message = "request failed"): Record<string, unknown> {
  return { error: { code, message }, requestId: id };
}

function sessionStatusEnvelope(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      operatorId: "operator-a",
      sessionId: "session-a",
      status: "ACTIVE",
      idleDisconnectAt: "2029-12-31T23:30:00Z",
      serverTime: "2029-12-31T23:00:25Z",
      ...overrides,
    },
    requestId: id,
  };
}

function schedulingToken(issuedAt: number, expiresAt: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "EdDSA", typ: "RGS-ACCESS", v: 2 })}`
    + `.${encode({ iat: issuedAt, exp: expiresAt })}.${"s".repeat(86)}`;
}

const PROACTIVE_REFRESH_SERVER_TIME = "1970-01-01T00:01:40Z";

function config(
  fetchImplementation: typeof fetch,
  overrides: Partial<RgsGatewayConfig> = {},
  automaticallyAcknowledge = true,
): RgsGatewayConfig {
  let id = 0;
  const fetchWithAcknowledgements: typeof fetch = async (url, init) => {
    if (automaticallyAcknowledge
      && String(url).endsWith("/client/v1/results/acknowledgements")) {
      return response(acknowledgementEnvelopeFromRequest(init));
    }
    return fetchImplementation(url, init);
  };
  return {
    baseUrl: "https://rgs.example",
    launchCode: LAUNCH_CODE,
    operatorId: "operator-a",
    sessionId: "session-a",
    betOptionsMinor: ["50", "100", "200"],
    defaultBetMinor: "100",
    fetch: fetchWithAcknowledgements,
    requestId: () => `request-${++id}`,
    retryJitter: () => 0,
    requestTimeoutMs: 5_000,
    pollDelayMs: 10,
    maxPollAttempts: 6,
    disableSessionMonitoringForTests: true,
    bindingFingerprint: async () => FINGERPRINT,
    ...overrides,
  };
}

function callbacks(): { log: CallbackLog; callbacks: GatewayCallbacks } {
  const log: CallbackLog = {
    statuses: [],
    sessions: [],
    results: [],
    timeouts: [],
    errors: [],
  };
  return {
    log,
    callbacks: {
      onStatus: (status) => log.statuses.push(status),
      onSession: (opened) => log.sessions.push(opened),
      onSpinResult: (result, origin) => log.results.push({
        result,
        ...(origin ? { origin } : {}),
      }),
      onSessionTimeout: (timeout) => log.timeouts.push(timeout),
      onError: (error) => log.errors.push(error),
    },
  };
}

async function waitForSession(log: CallbackLog): Promise<void> {
  await vi.waitFor(() => expect(log.sessions).toHaveLength(1));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RgsGateway", () => {
  it("spreads ten thousand retry clients without violating the server delay floor", () => {
    let state = 0x6d2b79f5;
    const sample = (): number => {
      state = Math.imul(state ^ state >>> 15, state | 1);
      state ^= state + Math.imul(state ^ state >>> 7, state | 61);
      return ((state ^ state >>> 14) >>> 0) / 4_294_967_296;
    };
    const buckets = new Map<number, number>();
    const delays = Array.from({ length: 10_000 }, () => {
      const delay = distributedRetryDelayMs(250, 1_000, sample);
      const bucket = Math.floor((delay - 1_000) / 10);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      return delay;
    });
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(1_000);
    expect(Math.max(...delays)).toBeLessThan(2_000);
    expect(buckets.size).toBeGreaterThanOrEqual(95);
    expect(Math.max(...buckets.values())).toBeLessThan(160);
  });

  it("uses a safe midpoint when the retry jitter source fails", () => {
    expect(distributedRetryDelayMs(500, 1_000, () => {
      throw new Error("unavailable jitter source");
    })).toBe(1_500);
    expect(distributedRetryDelayMs(500, 0, () => Number.NaN)).toBe(750);
    expect(distributedRetryDelayMs(0, 0, () => 0.9)).toBe(0);
  });

  it("rejects and cancels an RGS body whose declared byte length exceeds the protocol cap", async () => {
    const cancelled = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.stringify(exchangeEnvelope(requestId(init)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel(reason) {
          cancelled(reason);
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(NETWORK_RESPONSE_LIMITS.rgsJsonBytes + 1),
        },
      });
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);

    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(cancelled).toHaveBeenCalledOnce();
    expect(observed.log.sessions).toEqual([]);
    expect(observed.log.statuses).toEqual(["connecting", "offline"]);
    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: "RGS response body exceeds the 4 MiB safety limit",
    });
  });

  it("exchanges the one-time launch without Authorization and binds the ACTIVE session", async () => {
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      requests.push(seenRequest(url, init));
      return response(exchangeEnvelope(requestId(init)));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);

    gateway.connect();
    await waitForSession(observed.log);

    expect(observed.log.statuses).toEqual(["connecting", "online"]);
    expect(observed.log.sessions[0]).toMatchObject({
      sessionId: "session-a",
      engineRulesVersion: "slots-game-ways3-features-v4",
      currency: "EUR",
      currencyExponent: 2,
      balanceMinor: "1000",
      betOptionsMinor: ["50", "100", "200"],
      defaultBetMinor: "100",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://rgs.example/client/v1/sessions/exchange");
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
    expect(requests[0]?.headers.get("X-Request-Id")).toBe("request-1");
    expect(requests[0]?.headers.get("traceparent"))
      .toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-02$/);
    expect(requests[0]?.redirect).toBe("error");
    expect(requests[0]?.body).toEqual({
      launchCode: LAUNCH_CODE,
      operatorId: "operator-a",
      sessionId: "session-a",
    });
  });

  it("parks an unspent launch while unavailable and exchanges it once on foreground recovery", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => (
      response(exchangeEnvelope(requestId(init)))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);

    gateway.setRuntimeAvailability({ online: false, visible: true });
    gateway.connect();
    await Promise.resolve();
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(observed.log.statuses).toEqual(["recovering"]);

    gateway.setRuntimeAvailability({ online: true, visible: true });
    await waitForSession(observed.log);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(observed.log.statuses).toEqual(["recovering", "connecting", "online"]);
  });

  it("releases a parked launch on close without a late exchange", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => (
      response(exchangeEnvelope(requestId(init)))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);

    gateway.setRuntimeAvailability({ online: false, visible: true });
    gateway.connect();
    gateway.close();
    gateway.setRuntimeAvailability({ online: true, visible: true });
    gateway.connect();
    await Promise.resolve();

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(observed.log.statuses).toEqual(["recovering", "offline"]);
  });

  it.each([
    {
      name: "network uncertainty",
      result: (id: string) => {
        void id;
        throw new TypeError("connection reset");
      },
    },
    {
      name: "HTTP rejection",
      result: (id: string) => response(errorEnvelope(id, "SESSION_UNAVAILABLE"), 503),
    },
    {
      name: "malformed protocol response",
      result: (id: string) => response({
        ...exchangeEnvelope(id),
        unexpected: true,
      }),
    },
  ])("never replays a launch code after $name reaches the exchange boundary", async ({ result }) => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => result(requestId(init)));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);

    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(2));

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(observed.log.errors[1]).toMatchObject({
      name: "RgsGatewayConfigurationError",
      message: "RGS launch code has already been consumed; obtain a fresh operator relaunch",
    });
  });

  it("submits one BASE round with the exchanged binding/revision and decodes COMMITTED", async () => {
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      return response(successEnvelope(requestId(init), committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requests[1]?.url).toBe("https://rgs.example/client/v1/spins");
    expect(requests[1]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN_ONE}`);
    expect(requests[1]?.body).toMatchObject({
      operatorId: "operator-a",
      sessionId: "session-a",
      gameId: "primal-rampage",
      definitionVersion: "definition-1",
      definitionHash: HASH,
      currency: "EUR",
      currencyExponent: 2,
      jurisdiction: "GB",
      roundId: "round-a",
      roundKind: "BASE",
      betMinor: "100",
      startRevision: "0",
    });
    expect(observed.log.results[0]).toMatchObject({
      result: { roundId: "round-a", sequence: 1, chargedBetMinor: "100" },
      origin: { mode: "BASE", rageLevel: 1 },
    });
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 2)).toBe(false);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
  });

  it("accepts the exact no-win BASE response shape emitted by local production", async () => {
    const operatorId = "local-production-operator";
    const sessionId = "session_local_contract";
    const roundId = "round-local-contract";
    const definitionHash = "96caac1ea4f82292ba96e0e0397459687638d6ff904471a8363e69f6e824d35d";
    const localFeature = feature("NONE", 0, 0, "0", "0", 1, 0);
    const localResult: Record<string, unknown> = {
      operatorId,
      sessionId,
      roundId,
      gameId: "iron-colossus",
      definitionVersion: "local-production-2026-08-16.1",
      definitionHash,
      currency: "CNY",
      roundKind: "BASE",
      serverTransactionId: "rgs-op-v1:local-contract",
      walletTransactionId: "wtx_local_contract",
      startRevision: "0",
      endRevision: "1",
      sequence: "1",
      resultHash: "a".repeat(64),
      idleDisconnectAt: "2029-12-31T23:45:00Z",
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "99610",
      totalWinMinor: "0",
      grid: [
        [{ symbol: "PRISM" }, { symbol: "PRISM" }, { symbol: "PRISM" }],
        [{ symbol: "CIRCUIT" }, { symbol: "ORBIT" }, { symbol: "PRISM" }],
        [{ symbol: "CIRCUIT" }, { symbol: "PULSE" }, { symbol: "ORBIT" }],
      ],
      wins: [],
      events: [],
      feature: localFeature,
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init), {
            operatorId,
            sessionId,
            gameId: "iron-colossus",
            definitionVersion: "local-production-2026-08-16.1",
            definitionHash,
            currency: "CNY",
            currencyExponent: 2,
            jurisdiction: "CN-LOCAL",
            balanceMinor: "99710",
            feature: localFeature,
          }))
        : response(successEnvelope(requestId(init), localResult))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, {
      operatorId,
      sessionId,
      betOptionsMinor: ["10", "20", "50", "100", "200", "300", "400", "600", "1000", "2000", "5000", "10000"],
    }));
    const observed = callbacks();
    const deliveryStages: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onResultDeliveryStage: (stage) => deliveryStages.push(stage),
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin(roundId, "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.errors).toEqual([]);
    expect(observed.log.results[0]).toMatchObject({
      result: { roundId, sequence: 1, balanceMinor: "99610" },
      origin: { mode: "BASE", rageLevel: 1, rageCollected: 0 },
    });
    expect(deliveryStages).toEqual([
      "post-response-before-decode",
      "decode-envelope",
      "decode-request-id",
      "decode-data-shape",
      "decode-binding",
      "decode-metadata",
      "decode-grid",
      "decode-wins",
      "decode-events",
      "decode-feature",
      "decode-projection",
      "projection-round-id",
      "projection-sequence",
      "projection-money-fields",
      "projection-message-input",
      "projection-message-shape",
      "projection-message-grid",
      "projection-message-wins",
      "projection-message-events",
      "projection-message-feature",
      "projection-invariant-win-identities",
      "projection-invariant-award-total",
      "projection-invariant-wheel",
      "projection-invariant-vault",
      "projection-invariant-reels",
      "projection-message-output",
      "decode-commit-metadata",
      "decode-complete",
      "decoded",
      "economic-identity",
      "sequence-guard",
      "origin-reconstructed",
      "origin-validated",
      "controller-dispatch",
      "delivered",
    ]);
  });

  it("marks the response boundary before a committed spin decoder failure", async () => {
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let spinCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init)))
        : (() => {
            spinCalls += 1;
            return response(successEnvelope(requestId(init), {
              ...committedResult(),
              wins: null,
            }));
          })()
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const deliveryStages: string[] = [];
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        if (status === "offline") throw new Error("status observer failed");
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        throw new Error("diagnostic observer failed");
      },
      onOperatorSessionRequired: operatorRecovery,
      onResultDeliveryStage: (stage) => deliveryStages.push(stage),
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors).toHaveLength(1);
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
    expect(deliveryStages).toEqual([
      "post-response-before-decode",
      "decode-envelope",
      "decode-request-id",
      "decode-data-shape",
      "decode-binding",
      "decode-metadata",
      "decode-grid",
      "decode-wins",
    ]);
    gateway.setRuntimeAvailability({ online: false, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    gateway.connect();
    gateway.close();
    await Promise.resolve();
    expect(spinCalls).toBe(1);
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("hands a non-retryable spin HTTP failure to the operator without clearing its ledger", async () => {
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let spinCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      spinCalls += 1;
      return response(errorEnvelope(requestId(init), "INVALID_SESSION"), 400);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(observed.log.errors).toHaveLength(1);
    expect(observed.log.errors[0]).toMatchObject({
      code: "INVALID_SESSION",
      roundId: "round-a",
      retryable: false,
    });
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(spinCalls).toBe(1);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("stops the fixed projection stages at the visible-award invariant", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init)))
        : response(successEnvelope(requestId(init), {
            ...committedResult(),
            totalWinMinor: "1",
          }))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    const deliveryStages: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onResultDeliveryStage: (stage) => deliveryStages.push(stage),
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.results).toEqual([]);
    expect(deliveryStages.at(-1)).toBe("projection-invariant-award-total");
  });

  it("stops the fixed decoder stages at a mismatched response request id", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init)))
        : response(successEnvelope("foreign-request", committedResult()))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    const deliveryStages: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onResultDeliveryStage: (stage) => deliveryStages.push(stage),
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.results).toEqual([]);
    expect(deliveryStages).toEqual([
      "post-response-before-decode",
      "decode-envelope",
      "decode-request-id",
    ]);
  });

  it("keeps delivery authoritative when the fixed-stage observer throws", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init)))
        : response(successEnvelope(requestId(init), committedResult()))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks({
      ...observed.callbacks,
      onResultDeliveryStage: () => {
        throw new Error("诊断观察者故障");
      },
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.errors).toEqual([]);
  });

  it("accepts the local-production two-Rage response with mixed WILD cells", async () => {
    const result = committedResult({
      grid: [
        [{ symbol: "PULSE" }, { symbol: "CIRCUIT" }, { symbol: "SURGE" }],
        [{ symbol: "WILD", multiplier: 5 }, { symbol: "WILD" }, { symbol: "NOVA" }],
        [{ symbol: "TANK" }, { symbol: "ORBIT" }, { symbol: "SURGE" }],
      ],
      events: [fullEvent("surge.collected", {
        count: 2,
        cells: [{ reel: 0, row: 2 }, { reel: 2, row: 2 }],
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 2,
      })],
      nextFeature: feature("NONE", 0, 0, "0", "0", 1, 2),
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init)))
        : response(successEnvelope(requestId(init), result))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.errors).toEqual([]);
    expect(observed.log.results[0]?.result.featureState).toMatchObject({
      mode: "BASE",
      rageLevel: 1,
      rageCollected: 2,
    });
  });

  it("binds one in-flight server acknowledgement to the delivered result before clearing locally", async () => {
    const requests: SeenRequest[] = [];
    let resolveAcknowledgement: ((response: Response) => void) | undefined;
    let acknowledgementRequestId = "";
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementRequestId = requestId(init);
      return new Promise<Response>((resolve) => { resolveAcknowledgement = resolve; });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {}, false));
    const observed = callbacks();
    const acknowledged = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onSpinResultAcknowledged: acknowledged,
    });
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(requests.filter(({ url }) => (
      url.endsWith("/results/acknowledgements")
    ))).toHaveLength(1));
    const acknowledgement = requests.at(-1)!;
    expect(acknowledgement.headers.get("Authorization")).toBe(`Bearer ${TOKEN_ONE}`);
    expect(acknowledgement.body).toMatchObject({
      operatorId: "operator-a",
      sessionId: "session-a",
      roundId: "round-a",
      sequence: "1",
      resultHash: RESULT_HASH,
    });
    expect(gateway.hasPendingSpin).toBe(true);
    expect(acknowledged).not.toHaveBeenCalled();

    resolveAcknowledgement?.(response(acknowledgementEnvelope(
      acknowledgementRequestId,
      committedResult(),
    )));
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledWith("round-a", 1);
    expect(observed.log.statuses).toEqual(["connecting", "online"]);
  });

  it("keeps a failed acknowledgement pending and permits an idempotent retry", async () => {
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementAttempts += 1;
      if (acknowledgementAttempts === 1) {
        return response(errorEnvelope(requestId(init), "UNAVAILABLE"), 503);
      }
      return response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {}, false));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
    expect(acknowledgementAttempts).toBe(2);
  });

  it("automatically retries an idempotent acknowledgement and honors a safe Retry-After", async () => {
    vi.useFakeTimers();
    const acknowledgementRequests: SeenRequest[] = [];
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      const request = seenRequest(url, init);
      acknowledgementRequests.push(request);
      acknowledgementAttempts += 1;
      if (acknowledgementAttempts === 1) {
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
          503,
          "2",
        );
      }
      if (acknowledgementAttempts === 2) throw new TypeError("temporary disconnect");
      return response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 5_000,
      acknowledgementMaxAttempts: 5,
      acknowledgementRetryWindowMs: 10_000,
    }, false));
    const observed = callbacks();
    const acknowledged = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onSpinResultAcknowledged: acknowledged });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    expect(acknowledgementAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(acknowledgementAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(acknowledgementAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(acknowledgementAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));

    expect(acknowledgementAttempts).toBe(3);
    expect(acknowledgementRequests.map(({ body }) => body)).toEqual([
      expect.objectContaining({ roundId: "round-a", sequence: "1", resultHash: RESULT_HASH }),
      expect.objectContaining({ roundId: "round-a", sequence: "1", resultHash: RESULT_HASH }),
      expect.objectContaining({ roundId: "round-a", sequence: "1", resultHash: RESULT_HASH }),
    ]);
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(observed.log.errors).toHaveLength(2);
    expect(fetchImplementation.mock.calls.filter(([url]) => String(url).endsWith("/spins"))).toHaveLength(1);
    expect(fetchImplementation.mock.calls.filter(([url]) => String(url).endsWith("/rounds/status"))).toHaveLength(0);
  });

  it("does not let a valid long admission Retry-After extend the acknowledgement deadline", async () => {
    vi.useFakeTimers();
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementAttempts += 1;
      return responseWithRetryAfter(
        errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
        503,
        "1000",
      );
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 400,
      acknowledgementMaxAttempts: 3,
      acknowledgementRetryWindowMs: 5_000,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(acknowledgementAttempts).toBe(1);
    expect(gateway.hasPendingSpin).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(acknowledgementAttempts).toBe(1);
  });

  it("rejects unsafe Retry-After values and hands acknowledgement recovery to the operator at the hard cap", async () => {
    vi.useFakeTimers();
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const retryAfterValues = ["999999999999", "0", "not-a-delay"];
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      const retryAfter = retryAfterValues[acknowledgementAttempts] ?? "1";
      acknowledgementAttempts += 1;
      return responseWithRetryAfter(
        errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
        503,
        retryAfter,
      );
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 400,
      acknowledgementMaxAttempts: 3,
      acknowledgementRetryWindowMs: 5_000,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    expect(acknowledgementAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(acknowledgementAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(acknowledgementAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(acknowledgementAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(acknowledgementAttempts).toBe(3);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(observed.log.statuses.at(-1)).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acknowledgementAttempts).toBe(3);
  });

  it("stops acknowledgement retrying when the bounded recovery window is exhausted", async () => {
    vi.useFakeTimers();
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementAttempts += 1;
      return response(errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"), 503);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      acknowledgementRetryBaseDelayMs: 500,
      acknowledgementRetryMaxDelayMs: 1_000,
      acknowledgementMaxAttempts: 10,
      acknowledgementRetryWindowMs: 1_200,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onOperatorSessionRequired: operatorRecovery });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());
    expect(acknowledgementAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(acknowledgementAttempts).toBe(2);
    expect(gateway.hasPendingSpin).toBe(true);
  });

  it("aborts an in-flight acknowledgement at the hard recovery deadline", async () => {
    vi.useFakeTimers();
    let acknowledgementSignal: AbortSignal | undefined;
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      return new Promise<Response>((_resolve, reject) => {
        acknowledgementSignal = init?.signal ?? undefined;
        acknowledgementSignal?.addEventListener("abort", () => (
          reject(new DOMException("aborted", "AbortError"))
        ));
      });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      requestTimeoutMs: 5_000,
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 500,
      acknowledgementMaxAttempts: 5,
      acknowledgementRetryWindowMs: 1_000,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onOperatorSessionRequired: operatorRecovery });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    expect(acknowledgementSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(acknowledgementSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(acknowledgementSignal?.aborted).toBe(true);
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("rejects a successful acknowledgement that arrives after an absolute deadline timer was throttled", async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    let resolveAcknowledgement: ((value: Response) => void) | undefined;
    let acknowledgementRequestId = "";
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementRequestId = requestId(init);
      return new Promise<Response>((resolve) => { resolveAcknowledgement = resolve; });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      monotonicNow: () => monotonicNow,
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 500,
      acknowledgementMaxAttempts: 5,
      acknowledgementRetryWindowMs: 1_000,
    }, false));
    const observed = callbacks();
    const acknowledged = vi.fn();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onSpinResultAcknowledged: acknowledged,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    // 模拟后台冻结：单调恢复时钟已过期，但 deadline timer 尚未获得调度机会。
    monotonicNow = 1_000;
    resolveAcknowledgement?.(response(acknowledgementEnvelope(
      acknowledgementRequestId,
      committedResult(),
    )));
    await vi.runAllTicks();
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(acknowledged).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(observed.log.statuses.at(-1)).toBe("offline");
  });

  it("parks ACK retries while offline without replaying the delivered session on recovery", async () => {
    vi.useFakeTimers();
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementAttempts += 1;
      return acknowledgementAttempts === 1
        ? responseWithRetryAfter(
          errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
          503,
          "2",
        )
        : response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 3_000,
      acknowledgementMaxAttempts: 5,
      acknowledgementRetryWindowMs: 5_000,
    }, false));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    expect(acknowledgementAttempts).toBe(1);
    gateway.setRuntimeAvailability({ online: false, visible: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acknowledgementAttempts).toBe(1);

    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(acknowledgementAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
    expect(acknowledgementAttempts).toBe(2);
    // 已交付轮次不能通过重复 SESSION_OPENED 把控制器推进回 requesting。
    expect(observed.log.statuses).toEqual(["connecting", "online"]);
    expect(observed.log.sessions).toHaveLength(1);
  });

  it("keeps an offline acknowledgement Retry-After on the server-anchored clock across wall-clock jumps", async () => {
    vi.useFakeTimers();
    let wallNow = Date.parse("2029-12-31T23:00:00Z");
    let monotonicNow = 0;
    let acknowledgementAttempts = 0;
    const scheduledDelays: number[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementAttempts += 1;
      return acknowledgementAttempts === 1
        ? responseWithRetryAfter(
          errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
          503,
          "2",
        )
        : response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
      timers: {
        setTimeout: (callback, delayMs) => {
          scheduledDelays.push(delayMs);
          return globalThis.setTimeout(callback, delayMs);
        },
        clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 3_000,
      acknowledgementMaxAttempts: 5,
      acknowledgementRetryWindowMs: 5_000,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    expect(acknowledgementAttempts).toBe(1);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    await vi.runAllTicks();
    gateway.setRuntimeAvailability({ online: false, visible: true });
    wallNow = Date.parse("2050-01-01T00:00:00Z");
    monotonicNow = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acknowledgementAttempts).toBe(1);

    gateway.setRuntimeAvailability({ online: true, visible: true });
    expect(scheduledDelays.at(-1)).toBe(1_000);
    wallNow = Date.parse("2000-01-01T00:00:00Z");
    monotonicNow = 1_999;
    await vi.advanceTimersByTimeAsync(999);
    expect(acknowledgementAttempts).toBe(1);
    monotonicNow = 2_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(acknowledgementAttempts).toBe(2);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));

    expect(acknowledgementAttempts).toBe(2);
    expect(operatorRecovery).not.toHaveBeenCalled();
    expect(observed.log.errors).toHaveLength(1);
  });

  it("cancels a scheduled acknowledgement retry and releases memory on close without clearing the ledger", async () => {
    vi.useFakeTimers();
    let acknowledgementAttempts = 0;
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      acknowledgementAttempts += 1;
      return responseWithRetryAfter(
        errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
        503,
        "2",
      );
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      acknowledgementRetryBaseDelayMs: 100,
      acknowledgementRetryMaxDelayMs: 5_000,
      acknowledgementMaxAttempts: 5,
      acknowledgementRetryWindowMs: 10_000,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onOperatorSessionRequired: operatorRecovery });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.runAllTicks();
    expect(acknowledgementAttempts).toBe(1);

    gateway.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(acknowledgementAttempts).toBe(1);
    expect(operatorRecovery).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(false);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("keeps close idempotent and releases observers even when the offline observer throws", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => (
      response(exchangeEnvelope(requestId(init)))
    ));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);

    const throwingStatus = vi.fn(() => { throw new Error("observer failed"); });
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: throwingStatus,
    });
    expect(() => gateway.close()).not.toThrow();
    expect(() => gateway.close()).not.toThrow();
    expect(throwingStatus).toHaveBeenCalledOnce();

    const lateObserver = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onStatus: lateObserver });
    gateway.setRuntimeAvailability({ online: false, visible: false });
    expect(lateObserver).not.toHaveBeenCalled();
  });

  it("refreshes one expired token and retries the exact acknowledgement tuple", async () => {
    const acknowledgementRequests: SeenRequest[] = [];
    let acknowledgementAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      if (target.endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(requestId(init), {
          balanceMinor: "900",
          revision: "1",
          sequence: "1",
        }, TOKEN_TWO));
      }
      const request = seenRequest(url, init);
      acknowledgementRequests.push(request);
      acknowledgementAttempts += 1;
      return acknowledgementAttempts === 1
        ? response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401)
        : response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {}, false));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));

    expect(acknowledgementRequests).toHaveLength(2);
    expect(acknowledgementRequests.map(({ body }) => body)).toEqual([
      expect.objectContaining({ roundId: "round-a", sequence: "1", resultHash: RESULT_HASH }),
      expect.objectContaining({ roundId: "round-a", sequence: "1", resultHash: RESULT_HASH }),
    ]);
    expect(acknowledgementRequests.map(({ headers }) => headers.get("Authorization"))).toEqual([
      `Bearer ${TOKEN_ONE}`,
      `Bearer ${TOKEN_TWO}`,
    ]);
  });

  it("requires an operator relaunch when acknowledgement token refresh is rejected", async () => {
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {}, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onOperatorSessionRequired: operatorRecovery });
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(requests.filter(({ url }) => url.endsWith("/results/acknowledgements"))).toHaveLength(1);
    expect(requests.filter(({ url }) => url.endsWith("/sessions/refresh"))).toHaveLength(1);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
    expect(observed.log.statuses.at(-1)).toBe("offline");
  });

  it("aborts a pending result acknowledgement on close without a late clear or callback", async () => {
    let acknowledgementSignal: AbortSignal | undefined;
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      return new Promise<Response>((_resolve, reject) => {
        acknowledgementSignal = init?.signal ?? undefined;
        acknowledgementSignal?.addEventListener("abort", () => (
          reject(new DOMException("aborted", "AbortError"))
        ));
      });
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }, false));
    const observed = callbacks();
    const acknowledged = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onSpinResultAcknowledged: acknowledged });
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(acknowledgementSignal).toBeDefined());

    gateway.close();
    await vi.waitFor(() => expect(acknowledgementSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(acknowledged).not.toHaveBeenCalled();
    expect(observed.log.errors).toEqual([]);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
  });

  it("derives FREE_SPIN kind and locked bet from the exchanged active feature", async () => {
    const requests: SeenRequest[] = [];
    let pendingDiscoveryCalls = 0;
    const expansionEvent = fullEvent("grid.expanded", { rows: 3, ways: 27 });
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/results/pending")) {
        pendingDiscoveryCalls += 1;
        return new Response(null, { status: 204 });
      }
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "3",
          sequence: "3",
          feature: feature("EXPANSION", 2, 8, "100", "0"),
        }));
      }
      return response(successEnvelope(requestId(init), committedResult({
        roundKind: "FREE_SPIN",
        startRevision: "3",
        endRevision: "4",
        sequence: "4",
        chargedBetMinor: "0",
        balanceMinor: "1000",
        events: [expansionEvent],
        nextFeature: feature("EXPANSION", 1, 8, "100", "0"),
      })));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(pendingDiscoveryCalls).toBe(1);

    expect(gateway.requestSpin("round-a", "200")).toBe(false);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requests[1]?.body).toMatchObject({
      roundKind: "FREE_SPIN",
      betMinor: "100",
      startRevision: "3",
    });
    expect(observed.log.results[0]?.origin).toMatchObject({
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 6,
      baseBetMinor: "100",
    });
  });

  it("handles HTTP 202 with bounded status polling and never changes round identity", async () => {
    vi.useFakeTimers();
    const requests: SeenRequest[] = [];
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      return response(statusEnvelope(
        requestId(init),
        statusCalls === 1 ? "WALLET_PENDING" : "COMMITTED",
        statusCalls === 1 ? undefined : committedResult(),
      ));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTimersAsync();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    const economicRequests = requests.slice(1);
    expect(economicRequests.map(({ body }) => body.roundId)).toEqual([
      "round-a",
      "round-a",
      "round-a",
    ]);
    expect(economicRequests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(1);
    expect(observed.log.errors).toEqual([]);
  });

  it.each([
    { name: "offline", unavailable: { online: false, visible: true } },
    { name: "background", unavailable: { online: true, visible: false } },
  ])("parks $name polling without consuming attempts and resumes the same ledger", async ({
    unavailable,
  }) => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 1,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();

    gateway.setRuntimeAvailability(unavailable);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusCalls).toBe(0);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors).toEqual([]);

    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(statusCalls).toBe(1);
    expect(observed.log.results[0]?.result.roundId).toBe("round-a");
    expect(observed.log.errors).toEqual([]);
  });

  it("returns an in-flight polling attempt when COMMITTED arrives while backgrounded", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    let firstStatusRequestId = "";
    let resolveFirstStatus: ((value: Response) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      if (statusCalls === 1) {
        firstStatusRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveFirstStatus = resolve; });
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 1,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();

    await vi.advanceTimersByTimeAsync(100);
    expect(statusCalls).toBe(1);
    gateway.setRuntimeAvailability({ online: true, visible: false });
    resolveFirstStatus?.(response(statusEnvelope(
      firstStatusRequestId,
      "COMMITTED",
      committedResult(),
    )));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.log.results).toEqual([]);

    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(statusCalls).toBe(2);
    expect(observed.log.errors).toEqual([]);
    expect(observed.log.statuses).toEqual(["connecting", "online", "recovering", "online"]);
    expect(observed.log.sessions).toHaveLength(2);
  });

  it("does not start a second poll when foreground recovery races an in-flight request", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    let statusRequestId = "";
    let resolveStatus: ((value: Response) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      statusRequestId = requestId(init);
      return new Promise<Response>((resolve) => { resolveStatus = resolve; });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 2,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();

    await vi.advanceTimersByTimeAsync(100);
    expect(statusCalls).toBe(1);
    gateway.setRuntimeAvailability({ online: true, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls).toBe(1);
    expect(observed.log.results).toEqual([]);

    resolveStatus?.(response(statusEnvelope(
      statusRequestId,
      "COMMITTED",
      committedResult(),
    )));
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(statusCalls).toBe(1);
    expect(observed.log.errors).toEqual([]);
    expect(observed.log.statuses).toEqual(["connecting", "online", "recovering", "online"]);
    expect(observed.log.sessions).toHaveLength(2);
  });

  it.each([
    { name: "backgrounded", unavailable: { online: true, visible: false } },
    { name: "offline", unavailable: { online: false, visible: true } },
  ])("defers an in-flight direct ROUND_REJECTED response while $name until status recovery", async ({
    unavailable,
  }) => {
    vi.useFakeTimers();
    let spinCalls = 0;
    let statusCalls = 0;
    let spinRequestId = "";
    let resolveSpin: ((value: Response) => void) | undefined;
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        spinCalls += 1;
        spinRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveSpin = resolve; });
      }
      statusCalls += 1;
      return response(statusEnvelope(requestId(init), "REJECTED"));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      pollDelayMs: 100,
      maxPollAttempts: 1,
    }));
    const observed = callbacks();
    const timeline: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        timeline.push(`status:${status}`);
      },
      onSession: (session) => {
        observed.callbacks.onSession(session);
        timeline.push("session");
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        timeline.push("error");
      },
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    expect(spinCalls).toBe(1);

    gateway.setRuntimeAvailability(unavailable);
    resolveSpin?.(response(errorEnvelope(spinRequestId, "ROUND_REJECTED"), 409));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.log.errors).toEqual([]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();

    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    expect(observed.log.errors[0]).toMatchObject({
      code: "ROUND_REJECTED",
      roundId: "round-a",
      retryable: false,
    });
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(observed.log.sessions).toHaveLength(2);
    expect(timeline.lastIndexOf("session")).toBeLessThan(timeline.indexOf("error"));
    expect(gateway.hasPendingSpin).toBe(false);
    expect(storage.clear).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "backgrounded", unavailable: { online: true, visible: false } },
    { name: "offline", unavailable: { online: false, visible: true } },
  ])("defers an in-flight polled REJECTED state while $name until status recovery", async ({
    unavailable,
  }) => {
    vi.useFakeTimers();
    let spinCalls = 0;
    let statusCalls = 0;
    let firstStatusRequestId = "";
    let resolveFirstStatus: ((value: Response) => void) | undefined;
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        spinCalls += 1;
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      if (statusCalls === 1) {
        firstStatusRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveFirstStatus = resolve; });
      }
      return response(statusEnvelope(requestId(init), "REJECTED"));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      pollDelayMs: 100,
      maxPollAttempts: 1,
    }));
    const observed = callbacks();
    const timeline: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        timeline.push(`status:${status}`);
      },
      onSession: (session) => {
        observed.callbacks.onSession(session);
        timeline.push("session");
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        timeline.push("error");
      },
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);

    gateway.setRuntimeAvailability(unavailable);
    resolveFirstStatus?.(response(statusEnvelope(firstStatusRequestId, "REJECTED")));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.log.errors).toEqual([]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();

    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    expect(observed.log.errors[0]).toMatchObject({
      code: "ROUND_REJECTED",
      roundId: "round-a",
      retryable: false,
    });
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(2);
    expect(observed.log.sessions).toHaveLength(2);
    expect(timeline.lastIndexOf("session")).toBeLessThan(timeline.indexOf("error"));
    expect(gateway.hasPendingSpin).toBe(false);
    expect(storage.clear).toHaveBeenCalledOnce();
  });

  it("uses status Retry-After as the lower bound for retryable polling", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      if (statusCalls === 1) {
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "RGS_UNAVAILABLE"),
          503,
          "2",
        );
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { pollDelayMs: 100 }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(2);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
  });

  it("preserves a polling Retry-After floor across a background suspension", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "ROUND_PENDING"),
          202,
          "2",
        );
      }
      statusCalls += 1;
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { pollDelayMs: 100 }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();

    await vi.advanceTimersByTimeAsync(500);
    gateway.setRuntimeAvailability({ online: true, visible: false });
    await vi.advanceTimersByTimeAsync(1_000);
    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(statusCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(statusCalls).toBe(1);
  });

  it.each([
    { name: "offline", unavailable: { online: false, visible: true } },
    { name: "background", unavailable: { online: true, visible: false } },
  ])("keeps a $name round-recovery floor on the server-anchored clock across wall-clock jumps", async ({
    unavailable,
  }) => {
    vi.useFakeTimers();
    let wallNow = Date.parse("2029-12-31T23:00:00Z");
    let monotonicNow = 0;
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "RGS_UNAVAILABLE"),
          503,
          "2",
        );
      }
      statusCalls += 1;
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
      pollDelayMs: 100,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    await vi.runAllTicks();

    gateway.setRuntimeAvailability(unavailable);
    wallNow = Date.parse("2050-01-01T00:00:00Z");
    monotonicNow = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusCalls).toBe(0);

    gateway.setRuntimeAvailability({ online: true, visible: true });
    wallNow = Date.parse("2000-01-01T00:00:00Z");
    monotonicNow = 1_999;
    await vi.advanceTimersByTimeAsync(999);
    expect(statusCalls).toBe(0);
    monotonicNow = 2_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(1);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(statusCalls).toBe(1);
    expect(observed.log.results[0]?.result.roundId).toBe("round-a");
    expect(observed.log.errors).toHaveLength(1);
  });

  it("honors the 1000-second admission ceiling across suspension without consuming a poll attempt", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "RATE_LIMITED"),
          429,
          "1000",
        );
      }
      statusCalls += 1;
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 1,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();

    await vi.advanceTimersByTimeAsync(400_000);
    gateway.setRuntimeAvailability({ online: true, visible: false });
    await vi.advanceTimersByTimeAsync(599_999);
    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls).toBe(0);
    expect(gateway.hasPendingSpin).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(statusCalls).toBe(1);
  });

  it.each(["1001", "01000"]) (
    "rejects unsafe JSON Retry-After %s instead of treating it as a server delay floor",
    async (retryAfter) => {
      vi.useFakeTimers();
      let statusCalls = 0;
      const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/sessions/exchange")) {
          return response(exchangeEnvelope(requestId(init)));
        }
        if (String(url).endsWith("/spins")) {
          return responseWithRetryAfter(
            errorEnvelope(requestId(init), "ROUND_PENDING"),
            202,
            retryAfter,
          );
        }
        statusCalls += 1;
        return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
      });
      const gateway = new RgsGateway(config(fetchImplementation, { pollDelayMs: 100 }));
      const observed = callbacks();
      gateway.setCallbacks(observed.callbacks);
      gateway.connect();
      await vi.runAllTicks();
      await waitForSession(observed.log);

      expect(gateway.requestSpin("round-a", "100")).toBe(true);
      await vi.advanceTimersByTimeAsync(99);
      expect(statusCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
      expect(statusCalls).toBe(1);
    },
  );

  it("ignores an invalid status Retry-After without shortening exponential polling", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      if (statusCalls === 1) {
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "RGS_UNAVAILABLE"),
          503,
          "0",
        );
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { pollDelayMs: 100 }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(2);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
  });

  it.each([2, 3])(
    "recovers after %i consecutive WALLET_UNAVAILABLE responses without changing ledger identity",
    async (walletFailures) => {
      vi.useFakeTimers();
      const requests: SeenRequest[] = [];
      let spinCalls = 0;
      let statusCalls = 0;
      const pollDelayMs = 600;
      const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
        const request = seenRequest(url, init);
        requests.push(request);
        if (request.url.endsWith("/sessions/exchange")) {
          return response(exchangeEnvelope(requestId(init)));
        }
        if (request.url.endsWith("/spins")) {
          spinCalls += 1;
          if (spinCalls <= walletFailures) {
            return responseWithRetryAfter(
              errorEnvelope(requestId(init), "WALLET_UNAVAILABLE"),
              503,
              "1",
            );
          }
          return response(successEnvelope(requestId(init), committedResult()));
        }
        statusCalls += 1;
        return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
      });
      const gateway = new RgsGateway(config(fetchImplementation, {
        pollDelayMs,
        maxPollAttempts: 6,
      }));
      const observed = callbacks();
      gateway.setCallbacks(observed.callbacks);
      gateway.connect();
      await vi.runAllTicks();
      await waitForSession(observed.log);

      expect(gateway.requestSpin("round-a", "100")).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(spinCalls).toBe(1);

      for (let pollAttempt = 0; pollAttempt < walletFailures; pollAttempt += 1) {
        const exponentialDelayMs = Math.min(
          8_000,
          pollDelayMs * 2 ** Math.min(pollAttempt, 5),
        );
        const effectiveDelayMs = Math.max(1_000, exponentialDelayMs);
        await vi.advanceTimersByTimeAsync(effectiveDelayMs - 1);
        expect(statusCalls).toBe(pollAttempt);
        expect(spinCalls).toBe(pollAttempt + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(statusCalls).toBe(pollAttempt + 1);
        expect(spinCalls).toBe(pollAttempt + 2);
      }
      await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

      const spinRequests = requests.filter(({ url }) => url.endsWith("/spins"));
      expect(spinRequests).toHaveLength(walletFailures + 1);
      expect(spinRequests.map(({ body }) => body)).toEqual(
        Array.from({ length: walletFailures + 1 }, () => spinRequests[0]!.body),
      );
      expect(spinRequests[0]?.body).toMatchObject({
        operatorId: "operator-a",
        sessionId: "session-a",
        roundId: "round-a",
        roundKind: "BASE",
        betMinor: "100",
        startRevision: "0",
      });
      expect(observed.log.results[0]?.result).toMatchObject({
        roundId: "round-a",
        sequence: 1,
      });
      expect(observed.log.errors).toHaveLength(walletFailures);
    },
  );

  it.each([
    { status: 429, code: "RATE_LIMITED" },
    { status: 503, code: "ADMISSION_UNAVAILABLE" },
    { status: 503, code: "WALLET_UNAVAILABLE" },
    { status: 503, code: "CAPACITY_UNAVAILABLE" },
  ])("retries a provably pre-transaction $status $code with the same ledger", async ({
    status,
    code,
  }) => {
    vi.useFakeTimers();
    const spinRequests: SeenRequest[] = [];
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        spinRequests.push(request);
        if (spinRequests.length === 1) {
          return responseWithRetryAfter(errorEnvelope(requestId(init), code), status, "1");
        }
        return response(successEnvelope(requestId(init), committedResult()));
      }
      statusCalls += 1;
      return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 3,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(spinRequests).toHaveLength(1);
    expect(statusCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(1);
    expect(spinRequests).toHaveLength(2);
    expect(spinRequests[1]?.body).toEqual(spinRequests[0]?.body);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
  });

  it("honors a bodyless edge rate limit before strict JSON decoding", async () => {
    vi.useFakeTimers();
    const spinRequests: SeenRequest[] = [];
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        spinRequests.push(request);
        return spinRequests.length === 1
          ? edgeRateLimitedResponse()
          : response(successEnvelope(requestId(init), committedResult()));
      }
      statusCalls += 1;
      return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 3,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(spinRequests).toHaveLength(1);
    expect(statusCalls).toBe(0);
    expect(observed.log.errors[0]).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      requestId: "request-2",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toBe(1);
    expect(spinRequests).toHaveLength(2);
    expect(spinRequests[1]?.body).toEqual(spinRequests[0]?.body);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
  });

  it.each([
    {
      name: "missing marker",
      reply: () => new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
      message: "RGS response Content-Type must be application/json",
    },
    {
      name: "foreign marker",
      reply: () => edgeRateLimitedResponse("30", "UNTRUSTED"),
      message: "RGS response Content-Type must be application/json",
    },
    {
      name: "unsafe Retry-After",
      reply: () => edgeRateLimitedResponse("0"),
      message: "RGS edge rate limit response has an unsafe Retry-After",
    },
    {
      name: "Retry-After above the admission ceiling",
      reply: () => edgeRateLimitedResponse("1001"),
      message: "RGS edge rate limit response has an unsafe Retry-After",
    },
  ])("fails closed on a bodyless edge 429 with $name", async ({ reply, message }) => {
    vi.useFakeTimers();
    let spinCalls = 0;
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        spinCalls += 1;
        return reply();
      }
      statusCalls += 1;
      return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    expect(observed.log.errors[0]).toMatchObject({ name: "RgsProtocolError", message });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(0);
    expect(gateway.hasPendingSpin).toBe(true);
  });

  it("does not resubmit an unclassified service failure after status 404", async () => {
    vi.useFakeTimers();
    let spinCalls = 0;
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        spinCalls += 1;
        return response(errorEnvelope(requestId(init), "SERVICE_UNAVAILABLE"), 503);
      }
      statusCalls += 1;
      return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      pollDelayMs: 100,
      maxPollAttempts: 3,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(gateway.hasPendingSpin).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
  });

  it("clears a synchronous final rejection and permits a new round", async () => {
    const spinRequests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/results/acknowledgements")) {
        return response(acknowledgementEnvelopeFromRequest(init));
      }
      if (request.url.endsWith("/spins")) {
        spinRequests.push(request);
        if (request.body.roundId === "round-a") {
          return response(errorEnvelope(requestId(init), "ROUND_REJECTED"), 409);
        }
        return response(successEnvelope(
          requestId(init),
          committedResult({ roundId: "round-b" }),
        ));
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    expect(observed.log.errors[0]).toMatchObject({
      code: "ROUND_REJECTED",
      roundId: "round-a",
      retryable: false,
    });
    expect(gateway.hasPendingSpin).toBe(false);
    expect(gateway.requestSpin("round-b", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(observed.log.results[0]?.result.roundId).toBe("round-b");
    expect(spinRequests.map(({ body }) => body.roundId)).toEqual(["round-a", "round-b"]);
  });

  it("stops WALLET_UNAVAILABLE resubmission at maxPollAttempts without a tail request", async () => {
    vi.useFakeTimers();
    const spinRequests: SeenRequest[] = [];
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        spinRequests.push(request);
        return responseWithRetryAfter(
          errorEnvelope(requestId(init), "WALLET_UNAVAILABLE"),
          503,
          "1",
        );
      }
      statusCalls += 1;
      return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      pollDelayMs: 100,
      maxPollAttempts: 2,
    }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spinRequests).toHaveLength(2);
    expect(statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spinRequests).toHaveLength(2);
    expect(statusCalls).toBe(2);
    expect(observed.log.errors.at(-1)).toMatchObject({
      code: "ROUND_RECOVERY_EXHAUSTED",
      roundId: "round-a",
      retryable: false,
    });
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors.at(-1));
    expect(spinRequests[1]?.body).toEqual(spinRequests[0]?.body);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(spinRequests).toHaveLength(2);
    expect(statusCalls).toBe(2);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    gateway.setRuntimeAvailability({ online: false, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    gateway.connect();
    gateway.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(spinRequests).toHaveLength(2);
    expect(statusCalls).toBe(2);
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("aborts and ignores a concurrent late session-status response after an unrecoverable poll", async () => {
    vi.useFakeTimers();
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let sessionStatusSignal: AbortSignal | undefined;
    let resolveSessionStatus: ((value: Response) => void) | undefined;
    let roundStatusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      if (target.endsWith("/sessions/status")) {
        sessionStatusSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveSessionStatus = resolve; });
      }
      roundStatusCalls += 1;
      return response(errorEnvelope(requestId(init), "INVALID_SESSION"), 400);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      pollDelayMs: 100,
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
    }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);

    gateway.setRuntimeAvailability({ online: true, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sessionStatusSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(99);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(roundStatusCalls).toBe(1);
    expect(sessionStatusSignal?.aborted).toBe(true);
    expect(observed.log.errors).toHaveLength(1);
    expect(observed.log.errors[0]).toMatchObject({
      code: "INVALID_SESSION",
      roundId: "round-a",
      retryable: false,
    });
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();
    resolveSessionStatus?.(response(sessionStatusEnvelope("request-late-status")));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(observed.log.errors).toHaveLength(1);
    expect(observed.log.results).toEqual([]);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("hands an unrelated non-retryable poll 404 to the operator without resubmitting", async () => {
    vi.useFakeTimers();
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let spinCalls = 0;
    let statusCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        spinCalls += 1;
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      statusCalls += 1;
      return response(errorEnvelope(requestId(init), "ROUND_NOT_FOUND"), 404);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(observed.log.errors.at(-1)).toMatchObject({
      code: "ROUND_NOT_FOUND",
      retryable: false,
    });
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors.at(-1));
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
    gateway.close();
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "foreign round-status binding",
      envelope: (id: string) => {
        const valid = statusEnvelope(id, "PREPARED");
        return {
          ...valid,
          data: {
            ...(valid.data as Record<string, unknown>),
            sessionId: "session-b",
          },
        };
      },
    },
    {
      name: "malformed COMMITTED round status",
      envelope: (id: string) => statusEnvelope(id, "COMMITTED"),
    },
  ])("hands $name to one operator relaunch without clearing or retrying the round", async ({
    envelope,
  }) => {
    vi.useFakeTimers();
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let spinCalls = 0;
    let statusCalls = 0;
    let acknowledgementCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        spinCalls += 1;
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      if (target.endsWith("/rounds/status")) {
        statusCalls += 1;
        return response(envelope(requestId(init)));
      }
      acknowledgementCalls += 1;
      return response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(
      fetchImplementation,
      { ledgerStorage: storage },
      false,
    ));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        if (status === "offline") throw new Error("status observer failed");
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        throw new Error("diagnostic observer failed");
      },
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(acknowledgementCalls).toBe(0);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors).toHaveLength(1);
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);

    gateway.setRuntimeAvailability({ online: false, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    gateway.connect();
    gateway.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(spinCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(acknowledgementCalls).toBe(0);
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("treats MANUAL_REVIEW as a hard non-economic block and retains recovery evidence", async () => {
    vi.useFakeTimers();
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/spins")) {
        return response(errorEnvelope(requestId(init), "ROUND_PENDING"), 202);
      }
      return response(statusEnvelope(requestId(init), "MANUAL_REVIEW"));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    const callbackOrder: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        callbackOrder.push(`status:${status}`);
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        callbackOrder.push("error");
      },
      onOperatorSessionRequired: (error) => {
        operatorRecovery(error);
        callbackOrder.push("operator");
      },
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.errors[0]).toMatchObject({ code: "MANUAL_REVIEW", retryable: false });
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(callbackOrder.slice(-3)).toEqual(["status:offline", "error", "operator"]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    gateway.setRuntimeAvailability({ online: false, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    gateway.connect();
    gateway.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("refreshes exactly once after an authenticated 401 and retries the same spin", async () => {
    const requests: SeenRequest[] = [];
    let spinCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(requestId(init), {}, TOKEN_TWO));
      }
      spinCalls += 1;
      if (spinCalls === 1) return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
      return response(successEnvelope(requestId(init), committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requests.filter(({ url }) => url.endsWith("/sessions/refresh"))).toHaveLength(1);
    const spins = requests.filter(({ url }) => url.endsWith("/spins"));
    expect(spins).toHaveLength(2);
    expect(spins.map(({ body }) => body.roundId)).toEqual(["round-a", "round-a"]);
    expect(spins[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN_ONE}`);
    expect(spins[1]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN_TWO}`);
  });

  it.each([
    {
      name: "currencyExponent",
      refreshOverrides: { currencyExponent: 3 },
    },
    {
      name: "session status",
      refreshOverrides: { status: "BLOCKED" },
    },
  ])("terminates the browser transport and requests an operator relaunch when refresh drifts $name", async ({
    refreshOverrides,
  }) => {
    const requests: SeenRequest[] = [];
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(
          requestId(init),
          refreshOverrides,
          TOKEN_TWO,
        ));
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    const callbackOrder: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        callbackOrder.push(`status:${status}`);
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        callbackOrder.push("error");
      },
      onOperatorSessionRequired: (error) => {
        operatorRecovery(error);
        callbackOrder.push("operator");
      },
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.sessions).toHaveLength(1);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: "RGS refresh changed the immutable session binding or status",
    });
    expect(requests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(1);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(callbackOrder.slice(-3)).toEqual(["status:offline", "error", "operator"]);

    // 一次性 launch code 已消费；terminal refresh failure 必须使旧网关不可再次 connect。
    gateway.connect();
    await Promise.resolve();
    expect(observed.log.errors).toHaveLength(1);
    expect(requests.filter(({ url }) => url.endsWith("/sessions/exchange"))).toHaveLength(1);
  });

  it.each([
    {
      name: "balance",
      refreshOverrides: { balanceMinor: "999" },
    },
    {
      name: "feature state",
      refreshOverrides: {
        feature: {
          rageCollected: 0,
          rageLevel: 2,
          winMinor: "0",
          betMinor: "0",
          awarded: 0,
          remaining: 0,
          mode: "NONE",
        },
      },
    },
  ])("fails closed when refresh changes $name without advancing revision", async ({
    refreshOverrides,
  }) => {
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(requestId(init), refreshOverrides, TOKEN_TWO));
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(observed.log.sessions).toHaveLength(1);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors.at(-1)).toMatchObject({
      name: "RgsProtocolError",
      message: "refreshed RGS session changed economic state without advancing revision",
    });
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(gateway.hasPendingSpin).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(1);
  });

  it("compares equal refresh feature states independently of JSON key order", async () => {
    const requests: SeenRequest[] = [];
    let spinCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(requestId(init), {
          feature: {
            rageCollected: 0,
            rageLevel: 1,
            winMinor: "0",
            betMinor: "0",
            awarded: 0,
            remaining: 0,
            mode: "NONE",
          },
        }, TOKEN_TWO));
      }
      spinCalls += 1;
      if (spinCalls === 1) return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
      return response(successEnvelope(requestId(init), committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.sessions).toHaveLength(2);
    expect(observed.log.errors).toEqual([]);
    expect(operatorRecovery).not.toHaveBeenCalled();
    expect(requests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(2);
    expect(requests.filter(({ url }) => url.endsWith("/spins"))[1]?.headers.get("Authorization"))
      .toBe(`Bearer ${TOKEN_TWO}`);
    gateway.close();
  });

  it("isolates terminal status/error observers so operator recovery always runs", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (String(url).endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(
          requestId(init),
          { currencyExponent: 3 },
          TOKEN_TWO,
        ));
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const statuses: GatewayStatus[] = [];
    const diagnosticObserver = vi.fn(() => {
      throw new Error("diagnostic observer failed");
    });
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      onStatus: (status) => {
        statuses.push(status);
        if (status === "offline") throw new Error("status observer failed");
      },
      onSession: vi.fn(),
      onSpinResult: vi.fn(),
      onError: diagnosticObserver,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.waitFor(() => expect(statuses).toContain("online"));

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(statuses.at(-1)).toBe("offline");
    expect(diagnosticObserver).toHaveBeenCalledOnce();
    expect(gateway.hasPendingSpin).toBe(true);
  });

  it.each([
    {
      name: "revision",
      refreshOverrides: { revision: "2", sequence: "2" },
    },
    {
      name: "sequence",
      // revision 只允许与对应的一次 sequence 递增同步前进。
      refreshOverrides: { revision: "1", sequence: "9" },
    },
  ])("terminates and retains the pending ledger when refresh advances outside its $name window", async ({
    refreshOverrides,
  }) => {
    const requests: SeenRequest[] = [];
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/sessions/refresh")) {
        return response(exchangeEnvelope(
          requestId(init),
          refreshOverrides,
          TOKEN_TWO,
        ));
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: "refreshed RGS session is outside the pending round revision/sequence window",
    });
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(requests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(1);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);

    gateway.connect();
    await Promise.resolve();
    expect(observed.log.errors).toHaveLength(1);
  });

  it.each([401, 403, 410, 423])(
    "terminates for operator relaunch and preserves pending recovery when refresh returns %i",
    async (refreshStatus) => {
    const requests: SeenRequest[] = [];
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/sessions/refresh")) {
        return response(errorEnvelope(requestId(init), "SESSION_AUTHORIZATION_LOST"), refreshStatus);
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    const callbackOrder: string[] = [];
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        callbackOrder.push(`status:${status}`);
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        callbackOrder.push("error");
      },
      onOperatorSessionRequired: (error) => {
        operatorRecovery(error);
        callbackOrder.push("operator");
      },
    });
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(requests.filter(({ url }) => url.endsWith("/sessions/refresh"))).toHaveLength(1);
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.errors).toHaveLength(1);
    expect(observed.log.errors[0]).toMatchObject({
      type: "error",
      code: "SESSION_AUTHORIZATION_LOST",
      retryable: false,
    });
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(callbackOrder.slice(-3)).toEqual(["status:offline", "error", "operator"]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    gateway.connect();
    await Promise.resolve();
    expect(requests.filter(({ url }) => url.endsWith("/sessions/exchange"))).toHaveLength(1);
  });

  it("uses compact-token expiry only as a proactive refresh scheduling hint", async () => {
    vi.useFakeTimers();
    const hintedToken = schedulingToken(100, 200);
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      return response(exchangeEnvelope(requestId(init), {}, TOKEN_TWO));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { now: () => 100_000 }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => expect(
      requests.filter(({ url }) => url.endsWith("/sessions/refresh")),
    ).toHaveLength(1));

    expect(observed.log.sessions).toHaveLength(2);
    expect(observed.log.errors).toEqual([]);
    gateway.close();
  });

  it.each([
    "2000-01-01T00:00:00Z",
    "2050-01-01T00:00:00Z",
  ])("anchors proactive token refresh to serverTime when the browser wall clock is %s", async (wallTime) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(wallTime));
    const serverTime = "2029-12-31T23:00:00Z";
    const issuedSeconds = Math.floor(Date.parse(serverTime) / 1_000);
    const hintedToken = schedulingToken(issuedSeconds, issuedSeconds + 100);
    let monotonicNow = 0;
    let refreshCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {}, hintedToken, serverTime));
      }
      refreshCalls += 1;
      return response(exchangeEnvelope(
        requestId(init), {}, TOKEN_TWO, "2029-12-31T23:01:10Z",
      ));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      now: () => Date.now(),
      monotonicNow: () => monotonicNow,
    }));
    const observed = callbacks();
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        observed.log.sessions.push(opened);
        sessionReady();
      },
    });
    gateway.connect();
    await ready;

    monotonicNow = 69_999;
    await vi.advanceTimersByTimeAsync(69_999);
    expect(refreshCalls).toBe(0);
    monotonicNow = 70_000;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    monotonicNow = 75_000;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshCalls).toBe(1);
    expect(observed.log.errors).toEqual([]);
    gateway.close();
  });

  it("keeps the committed projection when an earlier proactive refresh returns the start snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const hintedToken = schedulingToken(100, 132);
    const requests: SeenRequest[] = [];
    let resolveSpin: ((value: Response) => void) | undefined;
    let resolveRefresh: ((value: Response) => void) | undefined;
    let spinRequestId = "";
    let refreshRequestId = "";
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      if (request.url.endsWith("/spins")) {
        spinRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveSpin = resolve; });
      }
      if (request.url.endsWith("/sessions/refresh")) {
        refreshRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      return response(acknowledgementEnvelopeFromRequest(init));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      requestTimeoutMs: 10_000,
    }, false));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(spinRequestId).not.toBe(""));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(refreshRequestId).not.toBe(""));

    resolveSpin?.(response(successEnvelope(spinRequestId, committedResult())));
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    resolveRefresh?.(response(exchangeEnvelope(refreshRequestId, {
      expiresAt: "2030-02-01T00:00:00Z",
    }, TOKEN_TWO)));
    await vi.waitFor(() => expect(observed.log.sessions).toHaveLength(2));

    expect(observed.log.sessions.at(-1)).toMatchObject({
      balanceMinor: "900",
      idleDisconnectAt: "2029-12-31T23:45:00Z",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(observed.log.errors).toEqual([]);
    expect(operatorRecovery).not.toHaveBeenCalled();
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
    const acknowledgement = requests.find(({ url }) => url.endsWith("/results/acknowledgements"));
    expect(acknowledgement?.headers.get("Authorization")).toBe(`Bearer ${TOKEN_TWO}`);
  });

  it("fails closed when the overlapping start snapshot changes an economic projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const hintedToken = schedulingToken(100, 132);
    let resolveSpin: ((value: Response) => void) | undefined;
    let resolveRefresh: ((value: Response) => void) | undefined;
    let spinRequestId = "";
    let refreshRequestId = "";
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      if (target.endsWith("/spins")) {
        spinRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveSpin = resolve; });
      }
      refreshRequestId = requestId(init);
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      requestTimeoutMs: 10_000,
    }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(spinRequestId).not.toBe(""));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(refreshRequestId).not.toBe(""));
    resolveSpin?.(response(successEnvelope(spinRequestId, committedResult())));
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    resolveRefresh?.(response(exchangeEnvelope(refreshRequestId, {
      balanceMinor: "999",
      expiresAt: "2030-02-01T00:00:00Z",
    }, TOKEN_TWO)));
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(observed.log.sessions).toHaveLength(1);
    expect(observed.log.errors.at(-1)).toMatchObject({
      name: "RgsProtocolError",
      message: "refreshed RGS session is outside the pending round revision/sequence window",
    });
    expect(gateway.hasPendingSpin).toBe(true);
  });

  it("preserves the proactive refresh target across a brief offline interval", async () => {
    vi.useFakeTimers();
    let now = 100_000;
    let monotonicNow = 0;
    const hintedToken = schedulingToken(100, 200);
    let refreshCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      refreshCalls += 1;
      return response(exchangeEnvelope(requestId(init), {}, TOKEN_TWO));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      now: () => now,
      monotonicNow: () => monotonicNow,
    }));
    const observed = callbacks();
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        observed.log.sessions.push(opened);
        sessionReady();
      },
    });
    gateway.connect();
    await ready;

    monotonicNow = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    now = 110_000;
    gateway.setRuntimeAvailability({ online: false, visible: true });
    monotonicNow = 20_000;
    await vi.advanceTimersByTimeAsync(10_000);
    now = 120_000;
    gateway.setRuntimeAvailability({ online: true, visible: true });
    monotonicNow = 69_999;
    await vi.advanceTimersByTimeAsync(49_999);
    expect(refreshCalls).toBe(0);
    monotonicNow = 70_000;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    gateway.close();
  });

  it("retries a transient proactive refresh before token expiry", async () => {
    vi.useFakeTimers();
    const hintedToken = schedulingToken(100, 200);
    const requests: SeenRequest[] = [];
    let refreshCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      refreshCalls += 1;
      return refreshCalls === 1
        ? response(errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"), 503)
        : response(exchangeEnvelope(requestId(init), {}, TOKEN_TWO));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { now: () => 100_000 }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));

    expect(requests.filter(({ url }) => url.endsWith("/sessions/refresh"))).toHaveLength(2);
    expect(observed.log.sessions).toHaveLength(2);
    expect(observed.log.statuses.at(-1)).toBe("online");
    expect(observed.log.errors).toHaveLength(1);
    gateway.close();
  });

  it("uses admission Retry-After as a proactive refresh lower bound without extending token expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const hintedToken = schedulingToken(100, 300);
    let refreshCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      refreshCalls += 1;
      return refreshCalls === 1
        ? responseWithRetryAfter(
          errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"),
          503,
          "30",
        )
        : response(exchangeEnvelope(requestId(init), {}, TOKEN_TWO));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        observed.log.sessions.push(opened);
        sessionReady();
      },
    });
    gateway.connect();
    await ready;

    const refreshTargetMs = 260_000;
    await vi.advanceTimersByTimeAsync(refreshTargetMs - Date.now() - 1);
    expect(refreshCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refreshCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls).toBe(2);

    expect(observed.log.sessions).toHaveLength(2);
    expect(observed.log.errors).toHaveLength(1);
    gateway.close();
  });

  it("hands a non-retryable proactive refresh failure to the operator", async () => {
    vi.useFakeTimers();
    const hintedToken = schedulingToken(100, 200);
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ))
        : response(errorEnvelope(requestId(init), "INVALID_SESSION"), 400)
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { now: () => 100_000 }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onOperatorSessionRequired: operatorRecovery });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(gateway.requestSpin("round-a", "100")).toBe(false);
    expect(observed.log.errors).toHaveLength(1);
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    gateway.close();
  });

  it("retries 5xx while the token is valid, then requests an operator relaunch at hard expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const hintedToken = schedulingToken(100, 140);
    let refreshCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(
          requestId(init), {}, hintedToken, PROACTIVE_REFRESH_SERVER_TIME,
        ));
      }
      refreshCalls += 1;
      return response(errorEnvelope(requestId(init), "TEMPORARY_UNAVAILABLE"), 503);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { now: () => Date.now() }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({ ...observed.callbacks, onOperatorSessionRequired: operatorRecovery });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshCalls).toBe(1);
    expect(operatorRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshCalls).toBe(2);
    expect(operatorRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshCalls).toBe(3);
    expect(operatorRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refreshCalls).toBe(4);
    expect(operatorRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(refreshCalls).toBe(5);
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.errors.at(-1)).toMatchObject({
      name: "RgsProtocolError",
      message: "RGS access token could not be refreshed before expiry; operator relaunch is required",
    });
    expect(gateway.requestSpin("round-a", "100")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshCalls).toBe(5);
  });

  it("fails closed on malformed or foreign exchange envelopes", async () => {
    const foreignFetch = vi.fn<typeof fetch>(async (_url, init) => response(exchangeEnvelope(
      requestId(init),
      { sessionId: "foreign-session" },
    )));
    const foreign = new RgsGateway(config(foreignFetch));
    const foreignObserved = callbacks();
    foreign.setCallbacks(foreignObserved.callbacks);
    foreign.connect();
    await vi.waitFor(() => expect(foreignObserved.log.errors).toHaveLength(1));
    expect(foreignObserved.log.sessions).toEqual([]);
    expect(foreignObserved.log.statuses.at(-1)).toBe("offline");

    const malformedFetch = vi.fn<typeof fetch>(async (_url, init) => response({
      ...exchangeEnvelope(requestId(init)),
      unexpected: true,
    }));
    const malformed = new RgsGateway(config(malformedFetch));
    const malformedObserved = callbacks();
    malformed.setCallbacks(malformedObserved.callbacks);
    malformed.connect();
    await vi.waitFor(() => expect(malformedObserved.log.errors).toHaveLength(1));
    expect(malformedObserved.log.sessions).toEqual([]);
  });

  it("never presents a committed result with a foreign immutable binding", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      return response(successEnvelope(requestId(init), {
        ...committedResult(),
        definitionHash: "d".repeat(64),
      }));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.results).toEqual([]);
    expect(gateway.hasPendingSpin).toBe(true);
  });

  it("recovers the same committed round when response-body reading is interrupted", async () => {
    vi.useFakeTimers();
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        const interrupted = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError("connection closed while reading body"));
          },
        });
        return new Response(interrupted, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(1);
    expect(requests.filter(({ url }) => url.endsWith("/rounds/status"))).toHaveLength(1);
    expect(observed.log.errors).toHaveLength(1);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
  });

  it("keeps recovery evidence until the controller accepts a committed result", async () => {
    vi.useFakeTimers();
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (request.url.endsWith("/spins")) {
        return response(successEnvelope(requestId(init), committedResult()));
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    let deliveries = 0;
    gateway.setCallbacks({
      ...observed.callbacks,
      onSpinResult: (result, origin) => {
        deliveries += 1;
        if (deliveries === 1) throw new Error("controller is not ready");
        observed.callbacks.onSpinResult(result, origin);
      },
    });
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(deliveries).toBe(2);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(requests.filter(({ url }) => url.endsWith("/rounds/status"))).toHaveLength(1);
    expect(observed.log.errors).toHaveLength(1);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(storage.clear).toHaveBeenCalledTimes(1));
    expect(gateway.hasPendingSpin).toBe(false);
  });

  it("keeps the round pending when durable acknowledgement storage cannot clear", async () => {
    const storage = {
      load: () => null,
      save: vi.fn(),
      clear: vi.fn(() => { throw new Error("storage unavailable"); }),
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init)))
        : response(successEnvelope(requestId(init), committedResult()))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));
    expect(observed.log.errors[0]).toMatchObject({ message: "storage unavailable" });
    expect(gateway.hasPendingSpin).toBe(true);
  });

  it("aborts in-flight fetches on close and suppresses late callbacks", async () => {
    let signal: AbortSignal | undefined;
    const fetchImplementation = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    gateway.close();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await Promise.resolve();

    expect(observed.log.statuses).toEqual(["connecting", "offline"]);
    expect(observed.log.sessions).toEqual([]);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors).toEqual([]);
  });

  it("persists exact v2 Base, Kong Quest, and King Spin origins through one explicit allowlist", async () => {
    const cases = [
      {
        name: "Base",
        wireFeature: feature("NONE", 0, 0, "0", "0", 1, 11),
        origin: {
          mode: "BASE",
          freeSpinsRemaining: 0,
          freeSpinsPlayed: 0,
          rageLevel: 1,
          rageCollected: 11,
        },
      },
      {
        name: "Kong Quest",
        wireFeature: feature("EXPANSION", 2, 8, "100", "700", 2, 12),
        origin: {
          mode: "EXPANSION",
          freeSpinsRemaining: 2,
          freeSpinsPlayed: 6,
          rageLevel: 2,
          rageCollected: 12,
          baseBetMinor: "100",
          freeSpinsWinMinor: "700",
        },
      },
      {
        name: "King Spin",
        wireFeature: feature("OVERDRIVE", 1, 8, "100", "900", 2, 12),
        origin: {
          mode: "OVERDRIVE",
          freeSpinsRemaining: 1,
          freeSpinsPlayed: 7,
          rageLevel: 2,
          rageCollected: 12,
          baseBetMinor: "100",
          freeSpinsWinMinor: "900",
        },
      },
    ] as const;

    for (const test of cases) {
      const persisted = new Map<string, string>();
      const storage = {
        getItem: (key: string) => persisted.get(key) ?? null,
        setItem: (key: string, value: string) => persisted.set(key, value),
        removeItem: (key: string) => { persisted.delete(key); },
      };
      const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/sessions/exchange")) {
          return response(exchangeEnvelope(requestId(init), { feature: test.wireFeature }));
        }
        return new Promise<Response>(() => undefined);
      });
      const gateway = new RgsGateway(config(fetchImplementation, {
        ledgerStorage: new JsonRgsRecoveryLedgerStorage(storage),
      }));
      const observed = callbacks();
      gateway.setCallbacks(observed.callbacks);
      gateway.connect();
      await waitForSession(observed.log);
      expect(gateway.requestSpin("round-a", "100"), test.name).toBe(true);

      const encoded = [...persisted.values()][0];
      expect(encoded, test.name).toBeDefined();
      const ledger = JSON.parse(encoded!) as Record<string, unknown>;
      expect(Object.keys(ledger).sort(), test.name).toEqual([
        "betMinor",
        "bindingFingerprint",
        "originFeatureState",
        "roundId",
        "startRevision",
        "version",
      ]);
      expect(ledger).toMatchObject({
        version: 2,
        bindingFingerprint: FINGERPRINT,
        roundId: "round-a",
        betMinor: "100",
        startRevision: "0",
        originFeatureState: test.origin,
      });
      expect(Object.keys(ledger.originFeatureState as Record<string, unknown>).sort(), test.name)
        .toEqual(Object.keys(test.origin).sort());
      expect(encoded).not.toContain(TOKEN_ONE);
      expect(encoded).not.toContain(LAUNCH_CODE);
      expect(encoded).not.toMatch(/wallet|player|outcome|result|grid|wins|events|balance/i);

      gateway.close();
    }
  });

  it("fails closed on malformed, extended, incomplete, or unsupported persisted ledgers", async () => {
    const valid = {
      version: 2,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originFeatureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        freeSpinsPlayed: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    } as const;
    const { startRevision: _missingRevision, ...missingOuterField } = valid;
    const malformed = [
      { name: "array root", value: [] },
      { name: "unknown version", value: { ...valid, version: 3 } },
      { name: "extra outer field", value: { ...valid, accessToken: TOKEN_ONE } },
      { name: "missing outer field", value: missingOuterField },
      {
        name: "extra Base field",
        value: { ...valid, originFeatureState: { ...valid.originFeatureState, baseBetMinor: "100" } },
      },
      {
        name: "missing nested field",
        value: {
          ...valid,
          originFeatureState: {
            mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0,
          },
        },
      },
      {
        name: "non-canonical Base counters",
        value: {
          ...valid,
          originFeatureState: { ...valid.originFeatureState, freeSpinsRemaining: 1 },
        },
      },
      {
        name: "non-canonical empty Rage meter",
        value: { ...valid, originFeatureState: { ...valid.originFeatureState, rageLevel: 2 } },
      },
      {
        name: "active mode missing required fields",
        value: { ...valid, originFeatureState: { ...valid.originFeatureState, mode: "EXPANSION" } },
      },
      {
        name: "active mode has zero remaining",
        value: {
          ...valid,
          originFeatureState: {
            mode: "EXPANSION",
            freeSpinsRemaining: 0,
            freeSpinsPlayed: 8,
            rageLevel: 1,
            rageCollected: 0,
            baseBetMinor: "100",
            freeSpinsWinMinor: "0",
          },
        },
      },
      {
        name: "active locked bet differs from ledger",
        value: {
          ...valid,
          originFeatureState: {
            mode: "OVERDRIVE",
            freeSpinsRemaining: 1,
            freeSpinsPlayed: 7,
            rageLevel: 1,
            rageCollected: 0,
            baseBetMinor: "200",
            freeSpinsWinMinor: "0",
          },
        },
      },
      {
        name: "active running win is not canonical",
        value: {
          ...valid,
          originFeatureState: {
            mode: "EXPANSION",
            freeSpinsRemaining: 1,
            freeSpinsPlayed: 7,
            rageLevel: 1,
            rageCollected: 0,
            baseBetMinor: "100",
            freeSpinsWinMinor: "01",
          },
        },
      },
    ] as const;

    for (const test of malformed) {
      const storage = { load: () => test.value, save: vi.fn(), clear: vi.fn() };
      const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => (
        response(exchangeEnvelope(requestId(init)))
      ));
      const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
      const observed = callbacks();
      gateway.setCallbacks(observed.callbacks);
      gateway.connect();
      await vi.waitFor(() => expect(observed.log.errors, test.name).toHaveLength(1));

      expect(observed.log.statuses, test.name).toEqual(["connecting", "offline"]);
      expect(observed.log.sessions, test.name).toEqual([]);
      expect(observed.log.results, test.name).toEqual([]);
      expect(storage.save, test.name).not.toHaveBeenCalled();
      expect(storage.clear, test.name).not.toHaveBeenCalled();
      expect(fetchImplementation, test.name).toHaveBeenCalledTimes(1);
      gateway.close();
    }
  });

  it("fails closed when the JSON ledger itself is unreadable", async () => {
    const storage = {
      getItem: () => "{not-json",
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => (
      response(exchangeEnvelope(requestId(init)))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: new JsonRgsRecoveryLedgerStorage(storage),
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.errors[0]).toMatchObject({ name: "RgsProtocolError" });
    expect(observed.log.sessions).toEqual([]);
    expect(storage.removeItem).not.toHaveBeenCalled();
    gateway.close();
  });

  it("uses a persisted ledger to query the same committed round after relaunch", async () => {
    const ledger = {
      version: 1,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originMode: "BASE",
    };
    const storage = {
      load: () => ledger,
      save: vi.fn(),
      clear: vi.fn(),
    };
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "1",
          sequence: "1",
          balanceMinor: "900",
        }));
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requests.filter(({ url }) => url.endsWith("/rounds/status"))).toHaveLength(1);
    expect(requests.filter(({ url }) => url.endsWith("/spins"))).toHaveLength(0);
    expect(observed.log.results[0]?.origin).toMatchObject({ mode: "BASE" });
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(storage.clear).toHaveBeenCalledTimes(1));
  });

  it("discovers and ACKs the authoritative pending result after the browser ledger was cleared", async () => {
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const origin = feature("NONE", 0, 0, "0", "0", 1, 11);
    const result = levelTwoRageResult();
    const requestedUrls: string[] = [];
    const pendingRequests: RequestInit[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      requestedUrls.push(target);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "1",
          sequence: "1",
          balanceMinor: "900",
          feature: feature("NONE", 0, 0, "0", "0", 2, 12),
        }));
      }
      if (target.endsWith("/results/pending")) {
        pendingRequests.push(init ?? {});
        return response(pendingResultEnvelope(requestId(init), result, origin));
      }
      throw new Error(`unexpected request: ${target}`);
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const callbackOrder: string[] = [];
    let pendingAtSession = false;
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        pendingAtSession = gateway.hasPendingSpin;
        callbackOrder.push("session");
        observed.callbacks.onSession(opened);
      },
      onSpinResult: (delivered, deliveredOrigin) => {
        callbackOrder.push("result");
        observed.callbacks.onSpinResult(delivered, deliveredOrigin);
      },
    });

    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requestedUrls.filter((url) => url.endsWith("/results/pending"))).toHaveLength(1);
    expect(requestedUrls.some((url) => url.endsWith("/rounds/status"))).toBe(false);
    expect(requestedUrls.some((url) => url.endsWith("/spins"))).toBe(false);
    expect(pendingAtSession).toBe(true);
    expect(callbackOrder).toEqual(["session", "result"]);
    const pendingRequest = pendingRequests[0];
    const headers = new Headers(pendingRequest?.headers);
    expect(pendingRequest?.method).toBe("GET");
    expect(pendingRequest?.body).toBeUndefined();
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_ONE}`);
    expect(headers.get("X-Operator-Id")).toBe("operator-a");
    expect(headers.has("Content-Type")).toBe(false);
    expect(observed.log.results[0]?.origin).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      rageLevel: 1,
      rageCollected: 11,
    });
    expect(storage.save).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(gateway.hasPendingSpin).toBe(false));
    expect(storage.clear).toHaveBeenCalledTimes(1);
  });

  it("hands a discovered commit rejected after exchange publication to one operator relaunch", async () => {
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    const result = levelTwoRageResult();
    const malformedCommit = {
      ...result,
      // pending 游标的其余字段保持权威，使测试在恢复内存身份后精确触发
      // acceptCommitted 的会话截止时间不变量。
      idleDisconnectAt: "2030-01-01T00:00:01Z",
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init), {
            revision: "1",
            sequence: "1",
            balanceMinor: "900",
            feature: feature("NONE", 0, 0, "0", "0", 2, 12),
          }))
        : response(pendingResultEnvelope(
            requestId(init),
            malformedCommit,
            feature("NONE", 0, 0, "0", "0", 1, 11),
          ))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onStatus: (status) => {
        observed.callbacks.onStatus(status);
        if (status === "offline") throw new Error("status observer failed");
      },
      onError: (error) => {
        observed.callbacks.onError(error);
        throw new Error("diagnostic observer failed");
      },
      onOperatorSessionRequired: operatorRecovery,
    });

    gateway.connect();
    await vi.waitFor(() => expect(operatorRecovery).toHaveBeenCalledOnce());

    expect(observed.log.sessions).toHaveLength(1);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors).toHaveLength(1);
    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: expect.stringMatching(/idle deadline exceeds the session expiry/),
    });
    expect(operatorRecovery).toHaveBeenCalledWith(observed.log.errors[0]);
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
    gateway.setRuntimeAvailability({ online: false, visible: false });
    gateway.setRuntimeAvailability({ online: true, visible: true });
    gateway.connect();
    gateway.close();
    await Promise.resolve();
    expect(operatorRecovery).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("maps a bodyless edge rate limit during pending-result GET discovery", async () => {
    const requestedUrls: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      requestedUrls.push(target);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "1",
          sequence: "1",
          balanceMinor: "900",
        }));
      }
      if (target.endsWith("/results/pending")) return edgeRateLimitedResponse();
      throw new Error(`unexpected request: ${target}`);
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);

    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(requestedUrls.filter((url) => url.endsWith("/results/pending"))).toHaveLength(1);
    expect(observed.log.errors[0]).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      requestId: "request-2",
    });
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.sessions).toEqual([]);
  });

  it("hands malformed or foreign pending-result discovery to one operator relaunch", async () => {
    const result = levelTwoRageResult();
    const valid = pendingResultEnvelope(
      "request-2",
      result,
      feature("NONE", 0, 0, "0", "0", 1, 11),
    );
    const validData = valid.data as Record<string, unknown>;
    const { originFeature: _omitted, ...withoutOrigin } = validData;
    const cases = [
      { name: "missing authoritative origin", envelope: { ...valid, data: withoutOrigin } },
      {
        name: "foreign committed result",
        envelope: pendingResultEnvelope(
          "request-2",
          { ...result, sessionId: "session-b" },
          feature("NONE", 0, 0, "0", "0", 1, 11),
        ),
      },
      {
        name: "post-round origin substituted for pre-round origin",
        envelope: {
          ...valid,
          data: {
            ...validData,
            originFeature: feature("NONE", 0, 0, "0", "0", 2, 12),
          },
        },
      },
    ] as const;

    for (const test of cases) {
      const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
      const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/sessions/exchange")) {
          return response(exchangeEnvelope(requestId(init), {
            revision: "1",
            sequence: "1",
            balanceMinor: "900",
            feature: feature("NONE", 0, 0, "0", "0", 2, 12),
          }));
        }
        return response({ ...test.envelope, requestId: requestId(init) });
      });
      const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
      const observed = callbacks();
      const operatorRecovery = vi.fn();
      gateway.setCallbacks({
        ...observed.callbacks,
        onStatus: (status) => {
          observed.callbacks.onStatus(status);
          if (status === "offline") throw new Error("status observer failed");
        },
        onError: (error) => {
          observed.callbacks.onError(error);
          throw new Error("diagnostic observer failed");
        },
        onOperatorSessionRequired: operatorRecovery,
      });
      gateway.connect();

      await vi.waitFor(() => expect(operatorRecovery, test.name).toHaveBeenCalledOnce());
      expect(observed.log.statuses, test.name).toEqual(["connecting", "offline"]);
      expect(observed.log.sessions, test.name).toEqual([]);
      expect(observed.log.results, test.name).toEqual([]);
      expect(observed.log.errors, test.name).toHaveLength(1);
      expect(operatorRecovery, test.name).toHaveBeenCalledWith(observed.log.errors[0]);
      expect(gateway.hasPendingSpin, test.name).toBe(false);
      expect(storage.save, test.name).not.toHaveBeenCalled();
      expect(storage.clear, test.name).not.toHaveBeenCalled();
      gateway.setRuntimeAvailability({ online: false, visible: false });
      gateway.setRuntimeAvailability({ online: true, visible: true });
      gateway.connect();
      gateway.close();
      await Promise.resolve();
      expect(operatorRecovery, test.name).toHaveBeenCalledOnce();
      expect(storage.clear, test.name).not.toHaveBeenCalled();
    }
  });

  it("ignores a late pending-result discovery response after close", async () => {
    const storage = { load: () => null, save: vi.fn(), clear: vi.fn() };
    let discoverySignal: AbortSignal | undefined;
    let resolveDiscovery: ((value: Response) => void) | undefined;
    const result = levelTwoRageResult();
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "1",
          sequence: "1",
          balanceMinor: "900",
          feature: feature("NONE", 0, 0, "0", "0", 2, 12),
        }));
      }
      discoverySignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveDiscovery = resolve; });
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    const operatorRecovery = vi.fn();
    gateway.setCallbacks({
      ...observed.callbacks,
      onOperatorSessionRequired: operatorRecovery,
    });
    gateway.connect();
    await vi.waitFor(() => expect(discoverySignal).toBeDefined());

    gateway.close();
    expect(discoverySignal?.aborted).toBe(true);
    resolveDiscovery?.(response(pendingResultEnvelope(
      "request-2",
      { ...result, sessionId: "session-b" },
      feature("NONE", 0, 0, "0", "0", 1, 11),
    )));
    await Promise.resolve();
    await Promise.resolve();

    expect(operatorRecovery).not.toHaveBeenCalled();
    expect(observed.log.sessions).toEqual([]);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors).toEqual([]);
    expect(gateway.hasPendingSpin).toBe(false);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("reconstructs the provable Base origin for a committed v1 direct-three-Rage round", async () => {
    const ledger = {
      version: 1,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originMode: "BASE",
    } as const;
    const storage = { load: () => ledger, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init), {
            revision: "1",
            sequence: "1",
            balanceMinor: "900",
            feature: feature("EXPANSION", 8, 8, "100", "0", 1, 0),
          }))
        : response(statusEnvelope(requestId(init), "COMMITTED", directThreeRageResult()))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.results[0]?.origin).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      rageLevel: 1,
      rageCollected: 0,
    });
    expect(observed.log.errors).toEqual([]);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(storage.clear).toHaveBeenCalledTimes(1));
  });

  it("replays a committed level transition from the exact persisted v2 Base origin", async () => {
    const origin = {
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      rageLevel: 1,
      rageCollected: 11,
    } as const;
    const ledger = {
      version: 2,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originFeatureState: origin,
    } as const;
    const storage = { load: () => ledger, save: vi.fn(), clear: vi.fn() };
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "1",
          sequence: "1",
          balanceMinor: "900",
          feature: feature("NONE", 0, 0, "0", "0", 2, 12),
        }));
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", levelTwoRageResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(requests.filter(({ url }) => url.endsWith("/rounds/status"))).toHaveLength(1);
    expect(observed.log.results[0]?.origin).toEqual(origin);
    expect(observed.log.results[0]?.origin).not.toMatchObject({ rageLevel: 2, rageCollected: 11 });
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(true);
    await vi.waitFor(() => expect(storage.clear).toHaveBeenCalledTimes(1));
    expect(gateway.hasPendingSpin).toBe(false);
  });

  it("blocks an ambiguous committed v1 one-Rage recovery without delivery or ledger loss", async () => {
    const ledger = {
      version: 1,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originMode: "BASE",
    } as const;
    const storage = { load: () => ledger, save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init), {
            revision: "1",
            sequence: "1",
            balanceMinor: "900",
            feature: feature("NONE", 0, 0, "0", "0", 2, 12),
          }))
        : response(statusEnvelope(requestId(init), "COMMITTED", levelTwoRageResult()))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: expect.stringMatching(/cannot reconstruct a one\/two-Rage origin safely/),
    });
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.acknowledgeSpinResult("round-a", 1)).toBe(false);
  });

  it("uses the exact exchange pre-state for a revision-zero v1 recovery", async () => {
    const ledger = {
      version: 1,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originMode: "BASE",
    } as const;
    const storage = { load: () => ledger, save: vi.fn(), clear: vi.fn() };
    const result = committedResult({
      nextFeature: feature("NONE", 0, 0, "0", "0", 1, 11),
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init), {
            feature: feature("NONE", 0, 0, "0", "0", 1, 11),
          }))
        : response(statusEnvelope(requestId(init), "COMMITTED", result))
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.results[0]?.origin).toEqual({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      rageLevel: 1,
      rageCollected: 11,
    });
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save).toHaveBeenCalledWith({
      version: 2,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originFeatureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        freeSpinsPlayed: 0,
        rageLevel: 1,
        rageCollected: 11,
      },
    });
    expect(observed.log.errors).toEqual([]);
  });

  it("blocks revision-zero v1 recovery when its exact v2 upgrade cannot be persisted", async () => {
    const ledger = {
      version: 1,
      bindingFingerprint: FINGERPRINT,
      roundId: "round-a",
      betMinor: "100",
      startRevision: "0",
      originMode: "BASE",
    } as const;
    const storage = {
      load: vi.fn(() => ledger),
      save: vi.fn(() => {
        throw new Error("ledger storage unavailable");
      }),
      clear: vi.fn(),
    };
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      return response(exchangeEnvelope(requestId(init), {
        feature: feature("NONE", 0, 0, "0", "0", 1, 11),
      }));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.statuses).toEqual(["connecting", "offline"]);
    expect(observed.log.sessions).toEqual([]);
    expect(observed.log.results).toEqual([]);
    expect(observed.log.errors[0]).toMatchObject({
      name: "Error",
      message: "ledger storage unavailable",
    });
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.load()).toBe(ledger);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://rgs.example/client/v1/sessions/exchange");
    expect(gateway.hasPendingSpin).toBe(false);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
  });

  it("reconstructs an active Free Spin origin when relaunch sees the advanced session", async () => {
    const storage = {
      load: () => ({
        version: 1,
        bindingFingerprint: FINGERPRINT,
        roundId: "round-a",
        betMinor: "100",
        startRevision: "3",
        originMode: "EXPANSION",
      }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const expansionEvent = fullEvent("grid.expanded", { rows: 3, ways: 27 });
    const recoveredResult = committedResult({
      roundKind: "FREE_SPIN",
      startRevision: "3",
      endRevision: "4",
      sequence: "4",
      chargedBetMinor: "0",
      balanceMinor: "1000",
      events: [expansionEvent],
      nextFeature: feature("EXPANSION", 1, 8, "100", "0"),
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          revision: "4",
          sequence: "4",
          feature: feature("EXPANSION", 1, 8, "100", "0"),
        }));
      }
      return response(statusEnvelope(requestId(init), "COMMITTED", recoveredResult));
    });
    const gateway = new RgsGateway(config(fetchImplementation, { ledgerStorage: storage }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));

    expect(observed.log.results[0]?.origin).toMatchObject({
      mode: "EXPANSION",
      freeSpinsRemaining: 2,
      freeSpinsPlayed: 6,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
    });
  });

  it("uses exchange serverTime plus monotonic elapsed time instead of a skewed browser wall clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2050-01-01T00:00:00Z"));
    let monotonicNow = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => response(exchangeEnvelope(
      requestId(init),
      { idleDisconnectAt: "2029-12-31T23:00:10Z" },
    )));
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
      monotonicNow: () => monotonicNow,
    }));
    const observed = callbacks();
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        observed.log.sessions.push(opened);
        sessionReady();
      },
    });

    gateway.connect();
    await ready;
    expect(observed.log.timeouts).toEqual([]);
    monotonicNow = 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(observed.log.timeouts).toEqual([]);
    monotonicNow = 10_000;
    await vi.advanceTimersByTimeAsync(1);

    expect(observed.log.timeouts).toEqual([{
      code: "SESSION_TIMEOUT",
      idleDisconnectAt: "2029-12-31T23:00:10Z",
    }]);
    expect(observed.log.statuses).toEqual(["connecting", "online", "offline"]);
    expect(gateway.requestSpin("round-after-timeout", "100")).toBe(false);
    gateway.setRuntimeAvailability({ online: true, visible: true });
    expect(observed.log.timeouts).toHaveLength(1);
  });

  it("does not expire early when the browser wall clock jumps after server synchronization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00Z"));
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      return response(successEnvelope(requestId(init), committedResult()));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 30_000,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);

    vi.setSystemTime(new Date("2050-01-01T00:00:00Z"));
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    expect(observed.log.timeouts).toEqual([]);
    gateway.close();
  });

  it("sends authenticated read-only session status probes every injected 25-30 seconds and immediately on foreground", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00Z"));
    const statusRequests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      const request = seenRequest(url, init);
      statusRequests.push(request);
      return response(sessionStatusEnvelope(requestId(init)));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
    }));
    const observed = callbacks();
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        observed.log.sessions.push(opened);
        sessionReady();
      },
    });
    gateway.connect();
    await ready;

    await vi.advanceTimersByTimeAsync(24_999);
    expect(statusRequests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(statusRequests).toHaveLength(1));
    expect(statusRequests[0]?.url).toBe("https://rgs.example/client/v1/sessions/status");
    expect(statusRequests[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN_ONE}`);
    expect(statusRequests[0]?.body).toMatchObject({
      operatorId: "operator-a",
      sessionId: "session-a",
      gameId: "primal-rampage",
      definitionHash: HASH,
    });

    gateway.setRuntimeAvailability({ online: true, visible: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusRequests).toHaveLength(1);
    gateway.setRuntimeAvailability({ online: true, visible: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(statusRequests).toHaveLength(2));
    gateway.close();
  });

  it("rejects the legacy nested session-status shape instead of widening the cross-layer contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00Z"));
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      const topLevel = sessionStatusEnvelope(requestId(init));
      return response({
        requestId: topLevel.requestId,
        data: { session: topLevel.data },
      });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
    }));
    const observed = callbacks();
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    gateway.setCallbacks({
      ...observed.callbacks,
      onSession: (opened) => {
        observed.log.sessions.push(opened);
        sessionReady();
      },
    });
    gateway.connect();
    await ready;

    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: expect.stringMatching(/response\.data\.session/),
    });
    expect(observed.log.timeouts).toEqual([]);
    expect(observed.log.statuses.at(-1)).toBe("offline");
  });

  it("never overlaps session status probes and clears their cadence on close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00Z"));
    let statusCalls = 0;
    let resolveStatus: ((response: Response) => void) | undefined;
    let statusRequestId = "";
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      statusCalls += 1;
      statusRequestId = requestId(init);
      return new Promise<Response>((resolve) => { resolveStatus = resolve; });
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
      requestTimeoutMs: 120_000,
    }));
    gateway.setCallbacks(callbacks().callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statusCalls).toBe(1);

    resolveStatus?.(response(sessionStatusEnvelope(statusRequestId)));
    await vi.runAllTicks();
    gateway.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusCalls).toBe(1);
  });

  it("terminates once on authoritative SESSION_TIMEOUT while retaining an in-flight round ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00Z"));
    const storage = { load: vi.fn(() => null), save: vi.fn(), clear: vi.fn() };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      if (target.endsWith("/spins")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return response(errorEnvelope(requestId(init), "SESSION_TIMEOUT"), 410);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      ledgerStorage: storage,
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
      requestTimeoutMs: 120_000,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);

    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(observed.log.timeouts).toHaveLength(1));
    expect(observed.log.timeouts[0]).toMatchObject({ code: "SESSION_TIMEOUT" });
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
    gateway.close();
    expect(observed.log.timeouts).toHaveLength(1);
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("ignores a late stale ACTIVE status deadline after a committed spin extends the session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-12-31T23:00:00Z"));
    let resolveStatus: ((response: Response) => void) | undefined;
    let statusRequestId = "";
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {
          idleDisconnectAt: "2029-12-31T23:01:00Z",
        }));
      }
      if (target.endsWith("/sessions/status")) {
        statusRequestId = requestId(init);
        return new Promise<Response>((resolve) => { resolveStatus = resolve; });
      }
      return response(successEnvelope(requestId(init), committedResult({
        idleDisconnectAt: "2029-12-31T23:10:00Z",
      })));
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
      sessionStatusIntervalMs: () => 25_000,
      requestTimeoutMs: 120_000,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(statusRequestId).not.toBe(""));

    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.results).toHaveLength(1));
    resolveStatus?.(response(sessionStatusEnvelope(statusRequestId, {
      idleDisconnectAt: "2029-12-31T23:01:00Z",
      serverTime: "2029-12-31T23:00:25Z",
    })));
    await vi.runAllTicks();
    gateway.setRuntimeAvailability({ online: true, visible: false });

    await vi.advanceTimersByTimeAsync(35_000);
    expect(observed.log.timeouts).toEqual([]);
    await vi.advanceTimersByTimeAsync(540_000);
    expect(observed.log.timeouts).toEqual([{
      code: "SESSION_TIMEOUT",
      idleDisconnectAt: "2029-12-31T23:10:00Z",
    }]);
  });

  it("fails closed when exchange omits the signed-body serverTime field", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = exchangeEnvelope(requestId(init));
      delete (envelope.data as Record<string, unknown>).serverTime;
      return response(envelope);
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
      disableSessionMonitoringForTests: false,
    }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.sessions).toEqual([]);
    expect(observed.log.errors[0]).toMatchObject({
      name: "RgsProtocolError",
      message: expect.stringMatching(/response\.data\.serverTime/),
    });
  });

  it("rejects incomplete or insecure constructor configuration", () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    expect(() => new RgsGateway(config(fetchImplementation, { baseUrl: "http://rgs.example" })))
      .toThrow(RgsGatewayConfigurationError);
    expect(() => new RgsGateway(config(fetchImplementation, { launchCode: "secret" })))
      .toThrow(/launchCode/);
    expect(() => new RgsGateway(config(fetchImplementation, { defaultBetMinor: "300" })))
      .toThrow(/defaultBetMinor/);
    expect(() => new RgsGateway(config(fetchImplementation, {
      acknowledgementRetryBaseDelayMs: 2_000,
      acknowledgementRetryMaxDelayMs: 1_000,
    }))).toThrow(/base <= max <= window/);
    expect(() => new RgsGateway(config(fetchImplementation, {
      acknowledgementMaxAttempts: 0,
    }))).toThrow(/acknowledgementMaxAttempts/);
    expect(() => new RgsGateway(config(fetchImplementation, {
      acknowledgementRetryWindowMs: 999,
    }))).toThrow(/acknowledgementRetryWindowMs/);
  });
});
