// @ts-nocheck -- 该测试直接验证 Node 侧 Chrome Fetch 夹具，不进入浏览器类型域。
import { describe, expect, it } from "vitest";
import { createControlledRgsTransactionFixture } from "../scripts/production-browser-transaction-fixture.mjs";

const baseOptions = Object.freeze({
  baseUrl: "https://rgs.ci.invalid",
  pageOrigin: "http://127.0.0.1:43123",
  launchCode: `lc_${"b".repeat(43)}`,
  operatorId: "browser-smoke",
  sessionId: "browser-smoke",
  initialBalanceMinor: "1000",
  betMinor: "200",
  finalBalanceMinor: "800",
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

describe("production browser transaction fixture", () => {
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
    const token = (decodedBody(exchange).data as { accessToken: string }).accessToken;
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

    expect(result.balanceMinor).toBe("800");
    expect(fixture.snapshot()).toMatchObject({
      exchangeCount: 1,
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
    expect(fixture.snapshot()).toMatchObject({
      exchangeCount: 0,
      spinCount: 0,
      acknowledgementCount: 0,
      order: [],
    });
    expect(() => fixture.responseForPausedRequest(paused(
      "https://rgs.ci.invalid/client/v1/undeclared",
      "OPTIONS",
    ))).toThrow(/未声明路径/);
  });
});
