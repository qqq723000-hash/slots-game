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
  type RgsGatewayConfig,
} from "../src/protocol/RgsGateway";
import type {
  GatewayCallbacks,
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
): Record<string, unknown> {
  return {
    data: { accessToken: token, session: session(overrides) },
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

function schedulingToken(issuedAt: number, expiresAt: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "EdDSA", typ: "RGS-ACCESS", v: 2 })}`
    + `.${encode({ iat: issuedAt, exp: expiresAt })}.${"s".repeat(86)}`;
}

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
    requestTimeoutMs: 5_000,
    pollDelayMs: 10,
    maxPollAttempts: 6,
    bindingFingerprint: async () => FINGERPRINT,
    ...overrides,
  };
}

function callbacks(): { log: CallbackLog; callbacks: GatewayCallbacks } {
  const log: CallbackLog = { statuses: [], sessions: [], results: [], errors: [] };
  return {
    log,
    callbacks: {
      onStatus: (status) => log.statuses.push(status),
      onSession: (opened) => log.sessions.push(opened),
      onSpinResult: (result, origin) => log.results.push({
        result,
        ...(origin ? { origin } : {}),
      }),
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
      balanceMinor: "1000",
      betOptionsMinor: ["50", "100", "200"],
      defaultBetMinor: "100",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://rgs.example/client/v1/sessions/exchange");
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
    expect(requests[0]?.headers.get("X-Request-Id")).toBe("request-1");
    expect(requests[0]?.redirect).toBe("error");
    expect(requests[0]?.body).toEqual({
      launchCode: LAUNCH_CODE,
      operatorId: "operator-a",
      sessionId: "session-a",
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

  it("cancels a scheduled acknowledgement retry on close", async () => {
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
        "2",
      );
    });
    const gateway = new RgsGateway(config(fetchImplementation, {
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
    expect(gateway.hasPendingSpin).toBe(true);
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
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(observed.log.errors[0]).toMatchObject({ code: "MANUAL_REVIEW", retryable: false });
    expect(gateway.hasPendingSpin).toBe(true);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
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

  it("blocks wagering and preserves the pending round when the one 401 refresh fails", async () => {
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init)));
      }
      return response(errorEnvelope(requestId(init), "UNAUTHORIZED"), 401);
    });
    const gateway = new RgsGateway(config(fetchImplementation));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await waitForSession(observed.log);
    expect(gateway.requestSpin("round-a", "100")).toBe(true);
    await vi.waitFor(() => expect(observed.log.errors).toHaveLength(1));

    expect(requests.filter(({ url }) => url.endsWith("/sessions/refresh"))).toHaveLength(1);
    expect(observed.log.statuses.at(-1)).toBe("offline");
    expect(gateway.hasPendingSpin).toBe(true);
    expect(gateway.requestSpin("round-b", "100")).toBe(false);
  });

  it("uses compact-token expiry only as a proactive refresh scheduling hint", async () => {
    vi.useFakeTimers();
    const hintedToken = schedulingToken(100, 200);
    const requests: SeenRequest[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {}, hintedToken));
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

  it("retries a transient proactive refresh before token expiry", async () => {
    vi.useFakeTimers();
    const hintedToken = schedulingToken(100, 200);
    const requests: SeenRequest[] = [];
    let refreshCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const request = seenRequest(url, init);
      requests.push(request);
      if (request.url.endsWith("/sessions/exchange")) {
        return response(exchangeEnvelope(requestId(init), {}, hintedToken));
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

  it("fails closed when a proactive refresh returns a non-retryable response", async () => {
    vi.useFakeTimers();
    const hintedToken = schedulingToken(100, 200);
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => (
      String(url).endsWith("/sessions/exchange")
        ? response(exchangeEnvelope(requestId(init), {}, hintedToken))
        : response(errorEnvelope(requestId(init), "INVALID_SESSION"), 400)
    ));
    const gateway = new RgsGateway(config(fetchImplementation, { now: () => 100_000 }));
    const observed = callbacks();
    gateway.setCallbacks(observed.callbacks);
    gateway.connect();
    await vi.runAllTicks();
    await waitForSession(observed.log);

    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => expect(observed.log.statuses.at(-1)).toBe("offline"));

    expect(gateway.requestSpin("round-a", "100")).toBe(false);
    expect(observed.log.errors).toHaveLength(1);
    gateway.close();
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

  it("fails closed on malformed or session-inconsistent pending-result discovery", async () => {
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
        name: "foreign outer session",
        envelope: { ...valid, data: { ...validData, sessionId: "session-b" } },
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
      const gateway = new RgsGateway(config(fetchImplementation));
      const observed = callbacks();
      gateway.setCallbacks(observed.callbacks);
      gateway.connect();

      await vi.waitFor(() => expect(observed.log.errors, test.name).toHaveLength(1));
      expect(observed.log.statuses, test.name).toEqual(["connecting", "offline"]);
      expect(observed.log.sessions, test.name).toEqual([]);
      expect(observed.log.results, test.name).toEqual([]);
      expect(gateway.hasPendingSpin, test.name).toBe(false);
      gateway.close();
    }
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
