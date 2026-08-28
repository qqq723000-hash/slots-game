// @ts-nocheck -- 该测试直接验证 Node 侧 Chrome Fetch 夹具，不进入浏览器类型域。
import { describe, expect, it } from "vitest";
import {
  assertSessionStatusCadence,
  BROWSER_FIXTURE_ENGINE_RULES_VERSION,
  createControlledRgsTransactionFixture,
  economicTransactionStateEqual,
  MIN_SESSION_STATUS_INTERVAL_MS,
} from "../scripts/production-browser-transaction-fixture.mjs";

const baseOptions = Object.freeze({
  baseUrl: "https://rgs.ci.invalid",
  pageOrigin: "http://127.0.0.1:43123",
  launchCode: `lc_${"b".repeat(43)}`,
  operatorId: "browser-smoke",
  sessionId: "browser-smoke",
  initialBalanceMinor: "1000",
  betMinor: "200",
  finalBalanceMinor: "850",
});

const binding = Object.freeze({
  operatorId: "browser-smoke",
  sessionId: "browser-smoke",
  gameId: "primal-rampage",
  definitionVersion: "browser-gate-v1",
  definitionHash: "a".repeat(64),
  currency: "EUR",
  currencyExponent: 2,
  jurisdiction: "GB",
});

function paused(
  url: string,
  method: string,
  body?: Record<string, unknown>,
  authorization?: string,
): Record<string, unknown> {
  return {
    request: {
      url,
      method,
      headers: {
        Origin: baseOptions.pageOrigin,
        "Content-Type": "application/json",
        "X-Request-Id": `request-${method.toLowerCase()}`,
        ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "POST" } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      ...(body ? { postData: JSON.stringify(body) } : {}),
    },
  };
}

function decodedBody(response: { body?: string }): Record<string, unknown> {
  if (!response.body) throw new Error("夹具响应缺少 JSON 正文");
  return JSON.parse(response.body) as Record<string, unknown>;
}

function exchangeFixture(fixture: ReturnType<typeof createControlledRgsTransactionFixture>): string {
  const response = fixture.responseForPausedRequest(paused(
    "https://rgs.ci.invalid/client/v1/sessions/exchange",
    "POST",
    {
      launchCode: baseOptions.launchCode,
      operatorId: baseOptions.operatorId,
      sessionId: baseOptions.sessionId,
    },
  ));
  return (decodedBody(response).data as { accessToken: string }).accessToken;
}

function probeSessionStatus(
  fixture: ReturnType<typeof createControlledRgsTransactionFixture>,
  token: string,
): void {
  fixture.responseForPausedRequest(paused(
    "https://rgs.ci.invalid/client/v1/sessions/status",
    "POST",
    binding,
    `Bearer ${token}`,
  ));
}

function cadenceSnapshot(timestamps: readonly number[]): Record<string, unknown> {
  let index = 0;
  const fixture = createControlledRgsTransactionFixture({
    ...baseOptions,
    now: () => timestamps[index++],
  });
  const token = exchangeFixture(fixture);
  for (let probe = 1; probe < timestamps.length; probe += 1) {
    probeSessionStatus(fixture, token);
  }
  return fixture.snapshot();
}

describe("production browser transaction fixture", () => {
  it("can bind the same strict transaction to an approved presentation definition", () => {
    const approved = {
      gameId: "iron-colossus",
      definitionVersion: "approved-browser-matrix-v1",
      definitionHash: "9".repeat(64),
    };
    const fixture = createControlledRgsTransactionFixture({ ...baseOptions, ...approved });
    const response = fixture.responseForPausedRequest(paused(
      "https://rgs.ci.invalid/client/v1/sessions/exchange",
      "POST",
      {
        launchCode: baseOptions.launchCode,
        operatorId: baseOptions.operatorId,
        sessionId: baseOptions.sessionId,
      },
    ));
    expect((decodedBody(response).data as { session: Record<string, unknown> }).session)
      .toMatchObject(approved);
  });

  it("requires the exact exchange, spin and result acknowledgement order", () => {
    const fixture = createControlledRgsTransactionFixture(baseOptions);
    const root = "https://rgs.ci.invalid/client/v1";
    const exchange = fixture.responseForPausedRequest(paused(
      `${root}/sessions/exchange`,
      "POST",
      {
        launchCode: baseOptions.launchCode,
        operatorId: baseOptions.operatorId,
        sessionId: baseOptions.sessionId,
      },
    ));
    const exchangeData = decodedBody(exchange).data as {
      accessToken: string;
      session: { engineRulesVersion: string };
    };
    const token = exchangeData.accessToken;
    expect(exchangeData.session.engineRulesVersion).toBe(BROWSER_FIXTURE_ENGINE_RULES_VERSION);
    const sessionStatus = fixture.responseForPausedRequest(paused(
      `${root}/sessions/status`,
      "POST",
      binding,
      `Bearer ${token}`,
    ));
    expect(decodedBody(sessionStatus).data).toEqual({
      operatorId: baseOptions.operatorId,
      sessionId: baseOptions.sessionId,
      status: "ACTIVE",
      idleDisconnectAt: "2098-12-31T23:30:00Z",
      serverTime: "2026-08-21T08:00:00Z",
    });
    const spin = fixture.responseForPausedRequest(paused(
      `${root}/spins`,
      "POST",
      {
        ...binding,
        roundId: "round-browser-gate",
        roundKind: "BASE",
        betMinor: "200",
        startRevision: "0",
      },
      `Bearer ${token}`,
    ));
    const result = decodedBody(spin).data as {
      roundId: string;
      sequence: string;
      resultHash: string;
      balanceMinor: string;
      totalWinMinor: string;
      wins: Array<{
        nominalAmountMinor: string;
        amountMinor: string;
        pathAwards: Array<{ nominalAmountMinor: string; amountMinor: string }>;
      }>;
    };
    fixture.responseForPausedRequest(paused(
      `${root}/results/acknowledgements`,
      "POST",
      {
        ...binding,
        roundId: result.roundId,
        sequence: result.sequence,
        resultHash: result.resultHash,
      },
      `Bearer ${token}`,
    ));

    expect(result.balanceMinor).toBe("850");
    expect(result.totalWinMinor).toBe("50");
    expect(result.wins).toEqual([
      expect.objectContaining({
        nominalAmountMinor: "50",
        amountMinor: "50",
        pathAwards: [expect.objectContaining({
          nominalAmountMinor: "50",
          amountMinor: "50",
        })],
      }),
    ]);
    expect(fixture.snapshot()).toMatchObject({
      exchangeCount: 1,
      sessionStatusCount: 1,
      spinCount: 1,
      acknowledgementCount: 1,
      order: ["session-exchange", "spin", "result-acknowledgement"],
      committedRoundObserved: true,
    });
  });

  it("fails closed when an acknowledgement appears without a committed spin", () => {
    const fixture = createControlledRgsTransactionFixture(baseOptions);
    expect(() => fixture.responseForPausedRequest(paused(
      "https://rgs.ci.invalid/client/v1/results/acknowledgements",
      "POST",
      {},
      "Bearer invalid",
    ))).toThrow(/ACK 次数或顺序/);
    expect(fixture.snapshot().acknowledgementCount).toBe(0);
  });

  it("answers only target-origin CORS preflights without advancing the transaction", () => {
    const fixture = createControlledRgsTransactionFixture(baseOptions);
    const response = fixture.responseForPausedRequest(paused(
      "https://rgs.ci.invalid/client/v1/sessions/exchange",
      "OPTIONS",
    ));
    expect(response.responseCode).toBe(204);
    expect(response.responseHeaders).toContainEqual({
      name: "Access-Control-Allow-Origin",
      value: baseOptions.pageOrigin,
    });
    expect(response.responseHeaders).toContainEqual({
      name: "Access-Control-Allow-Headers",
      value: "Authorization, Content-Type, Traceparent, X-Operator-Id, X-Request-Id",
    });
    expect(fixture.snapshot()).toMatchObject({
      exchangeCount: 0,
      sessionStatusCount: 0,
      spinCount: 0,
      acknowledgementCount: 0,
      order: [],
    });
    expect(() => fixture.responseForPausedRequest(paused(
      "https://rgs.ci.invalid/client/v1/undeclared",
      "OPTIONS",
    ))).toThrow(/未声明路径/);
  });

  it("separates read-only status probes from the economic transaction state", () => {
    let now = 1_000;
    const fixture = createControlledRgsTransactionFixture({ ...baseOptions, now: () => now });
    const token = exchangeFixture(fixture);
    const before = fixture.snapshot();
    now += MIN_SESSION_STATUS_INTERVAL_MS;
    probeSessionStatus(fixture, token);
    const after = fixture.snapshot();

    expect(economicTransactionStateEqual(before, after)).toBe(true);
    expect(() => assertSessionStatusCadence(after)).not.toThrow();
    expect(economicTransactionStateEqual(before, { ...after, spinCount: 1 })).toBe(false);
    expect(economicTransactionStateEqual(before, {
      ...after,
      order: ["session-exchange", "spin"],
    })).toBe(false);
    expect(economicTransactionStateEqual(before, {
      ...after,
      acknowledgementCount: 1,
    })).toBe(false);
  });

  it("rejects first and subsequent status probes below the 25 second cadence", () => {
    expect(() => assertSessionStatusCadence(cadenceSnapshot([1_000, 25_999])))
      .toThrow(/短于 25 秒/);
    expect(() => assertSessionStatusCadence(cadenceSnapshot([1_000, 26_000])))
      .not.toThrow();
    expect(() => assertSessionStatusCadence(cadenceSnapshot([1_000, 26_000, 50_999])))
      .toThrow(/短于 25 秒/);
    expect(() => assertSessionStatusCadence(cadenceSnapshot([1_000, 26_000, 51_000])))
      .not.toThrow();
  });
});
