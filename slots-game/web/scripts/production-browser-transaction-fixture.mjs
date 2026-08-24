import { performance } from "node:perf_hooks";

const DEFINITION_HASH = "a".repeat(64);
const RESULT_HASH = "c".repeat(64);
const ACCESS_TOKEN = "browser-gate-token".padEnd(80, "x");
export const MIN_SESSION_STATUS_INTERVAL_MS = 25_000;

const BASE_GRID = Object.freeze([
  Object.freeze([{ symbol: "ORBIT" }, { symbol: "PRISM" }, { symbol: "PULSE" }]),
  Object.freeze([{ symbol: "NOVA" }, { symbol: "CIRCUIT" }, { symbol: "TANK" }]),
  Object.freeze([{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "NOVA" }]),
]);

function economicTransactionProjection(snapshot) {
  return Object.freeze({
    exchangeCount: snapshot?.exchangeCount,
    spinCount: snapshot?.spinCount,
    acknowledgementCount: snapshot?.acknowledgementCount,
    order: Array.isArray(snapshot?.order) ? Object.freeze([...snapshot.order]) : snapshot?.order,
    committedRoundObserved: snapshot?.committedRoundObserved,
  });
}

export function economicTransactionStateEqual(expected, actual) {
  return JSON.stringify(economicTransactionProjection(expected))
    === JSON.stringify(economicTransactionProjection(actual));
}

export function assertSessionStatusCadence(snapshot) {
  const count = snapshot?.sessionStatusCount;
  const observed = snapshot?.sessionStatusObservedAtMs;
  if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(observed)
    || observed.length !== count) {
    throw new Error("RGS 会话状态探测计数与单调时间证据不一致");
  }
  if (snapshot?.exchangeCount === 0) {
    if (snapshot.exchangeObservedAtMs !== null || count !== 0) {
      throw new Error("RGS 会话状态探测发生在会话交换之前");
    }
    return true;
  }
  if (snapshot?.exchangeCount !== 1 || !Number.isFinite(snapshot?.exchangeObservedAtMs)) {
    throw new Error("RGS 会话交换缺少唯一单调时间证据");
  }
  let previous = snapshot.exchangeObservedAtMs;
  for (const timestamp of observed) {
    if (!Number.isFinite(timestamp)
      || timestamp - previous < MIN_SESSION_STATUS_INTERVAL_MS) {
      throw new Error("RGS 会话状态探测间隔短于 25 秒下界");
    }
    previous = timestamp;
  }
  return true;
}

function endpoint(baseUrl, path) {
  const result = new URL(baseUrl);
  result.pathname = `${result.pathname.replace(/\/$/, "")}${path}`;
  return result;
}

function header(headers, expectedName) {
  const found = Object.entries(headers ?? {}).find(([name]) => (
    name.toLowerCase() === expectedName.toLowerCase()
  ));
  return found ? String(found[1]) : null;
}

function exactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} 字段集合不符合受控事务契约`);
  }
}

function parseBody(request, expectedKeys, label) {
  if (typeof request.postData !== "string" || request.postData.length === 0) {
    throw new Error(`${label} 缺少 JSON 请求体`);
  }
  let value;
  try {
    value = JSON.parse(request.postData);
  } catch {
    throw new Error(`${label} 请求体不是合法 JSON`);
  }
  exactKeys(value, expectedKeys, label);
  return value;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 与受控事务不一致`);
}

function requireRequestId(request) {
  const value = header(request.headers, "X-Request-Id");
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("RGS 请求缺少规范 X-Request-Id");
  }
  return value;
}

function requireAuthorization(request, expected) {
  const authorization = header(request.headers, "Authorization");
  requireEqual(authorization, expected, "RGS Authorization");
}

function requireJsonCorsRequest(request, pageOrigin) {
  requireEqual(header(request.headers, "Origin"), pageOrigin, "RGS Origin");
  const contentType = header(request.headers, "Content-Type")?.split(";", 1)[0]?.trim();
  requireEqual(contentType, "application/json", "RGS Content-Type");
}

function feature() {
  return {
    mode: "NONE",
    remaining: 0,
    awarded: 0,
    betMinor: "0",
    winMinor: "0",
    rageLevel: 1,
    rageCollected: 0,
  };
}

function binding(options) {
  return {
    operatorId: options.operatorId,
    sessionId: options.sessionId,
    gameId: "primal-rampage",
    definitionVersion: "browser-gate-v1",
    definitionHash: DEFINITION_HASH,
    currency: "EUR",
    currencyExponent: 2,
    jurisdiction: "GB",
  };
}

function corsHeaders(pageOrigin, contentType = true) {
  return [
    { name: "Access-Control-Allow-Origin", value: pageOrigin },
    { name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
    {
      name: "Access-Control-Allow-Headers",
      value: "Authorization, Content-Type, Traceparent, X-Operator-Id, X-Request-Id",
    },
    { name: "Cache-Control", value: "no-store" },
    { name: "Vary", value: "Origin" },
    ...(contentType ? [{ name: "Content-Type", value: "application/json; charset=utf-8" }] : []),
  ];
}

function jsonFulfillment(pageOrigin, value) {
  return Object.freeze({
    responseCode: 200,
    responseHeaders: corsHeaders(pageOrigin),
    body: JSON.stringify(value),
  });
}

export function createControlledRgsTransactionFixture(options) {
  const baseUrl = new URL(options.baseUrl);
  const pageOrigin = new URL(options.pageOrigin).origin;
  const exchangeUrl = endpoint(baseUrl, "/client/v1/sessions/exchange");
  const sessionStatusUrl = endpoint(baseUrl, "/client/v1/sessions/status");
  const spinUrl = endpoint(baseUrl, "/client/v1/spins");
  const acknowledgementUrl = endpoint(baseUrl, "/client/v1/results/acknowledgements");
  const expectedBinding = binding(options);
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const order = [];
  let exchangeCount = 0;
  let exchangeObservedAtMs = null;
  let sessionStatusCount = 0;
  const sessionStatusObservedAtMs = [];
  let spinCount = 0;
  let acknowledgementCount = 0;
  let committedRound = null;

  function preflight(request) {
    requireEqual(header(request.headers, "Origin"), pageOrigin, "RGS 预检 Origin");
    requireEqual(
      header(request.headers, "Access-Control-Request-Method"),
      "POST",
      "RGS 预检方法",
    );
    return Object.freeze({
      responseCode: 204,
      responseHeaders: corsHeaders(pageOrigin, false),
    });
  }

  function exchange(request) {
    if (exchangeCount !== 0 || spinCount !== 0 || acknowledgementCount !== 0) {
      throw new Error("RGS 会话交换次数或顺序不符合事务契约");
    }
    requireEqual(request.method, "POST", "RGS 会话交换方法");
    requireJsonCorsRequest(request, pageOrigin);
    requireAuthorization(request, null);
    const requestId = requireRequestId(request);
    const body = parseBody(
      request,
      ["launchCode", "operatorId", "sessionId"],
      "RGS 会话交换",
    );
    requireEqual(body.launchCode, options.launchCode, "RGS 一次性启动码");
    requireEqual(body.operatorId, options.operatorId, "RGS 运营方标识");
    requireEqual(body.sessionId, options.sessionId, "RGS 会话标识");
    exchangeObservedAtMs = observedNow(now, "RGS 会话交换");
    exchangeCount += 1;
    order.push("session-exchange");
    return jsonFulfillment(pageOrigin, {
      data: {
        accessToken: ACCESS_TOKEN,
        serverTime: "2026-08-21T08:00:00Z",
        session: {
          ...expectedBinding,
          status: "ACTIVE",
          expiresAt: "2099-01-01T00:00:00Z",
          idleDisconnectAt: "2098-12-31T23:30:00Z",
          balanceMinor: options.initialBalanceMinor,
          revision: "0",
          sequence: "0",
          feature: feature(),
        },
      },
      requestId,
    });
  }

  function spin(request) {
    if (exchangeCount !== 1 || spinCount !== 0 || acknowledgementCount !== 0) {
      throw new Error("RGS 旋转次数或顺序不符合事务契约");
    }
    requireEqual(request.method, "POST", "RGS 旋转方法");
    requireJsonCorsRequest(request, pageOrigin);
    requireAuthorization(request, `Bearer ${ACCESS_TOKEN}`);
    const requestId = requireRequestId(request);
    const body = parseBody(request, [
      "operatorId",
      "sessionId",
      "gameId",
      "definitionVersion",
      "definitionHash",
      "currency",
      "currencyExponent",
      "jurisdiction",
      "roundId",
      "roundKind",
      "betMinor",
      "startRevision",
    ], "RGS 旋转");
    for (const [name, value] of Object.entries(expectedBinding)) {
      requireEqual(body[name], value, `RGS 旋转 ${name}`);
    }
    requireEqual(body.roundKind, "BASE", "RGS 旋转类型");
    requireEqual(body.betMinor, options.betMinor, "RGS 下注金额");
    requireEqual(body.startRevision, "0", "RGS 起始修订号");
    if (typeof body.roundId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.roundId)) {
      throw new Error("RGS 轮次标识不规范");
    }
    committedRound = Object.freeze({
      roundId: body.roundId,
      sequence: "1",
      resultHash: RESULT_HASH,
    });
    spinCount += 1;
    order.push("spin");
    return jsonFulfillment(pageOrigin, {
      data: {
        operatorId: expectedBinding.operatorId,
        sessionId: expectedBinding.sessionId,
        gameId: expectedBinding.gameId,
        definitionVersion: expectedBinding.definitionVersion,
        definitionHash: expectedBinding.definitionHash,
        currency: expectedBinding.currency,
        roundId: committedRound.roundId,
        roundKind: "BASE",
        serverTransactionId: "server-browser-gate-1",
        walletTransactionId: "wallet-browser-gate-1",
        startRevision: "0",
        endRevision: "1",
        resultHash: RESULT_HASH,
        idleDisconnectAt: "2098-12-31T23:45:00Z",
        sequence: "1",
        betMinor: options.betMinor,
        chargedBetMinor: options.betMinor,
        balanceMinor: options.finalBalanceMinor,
        totalWinMinor: "0",
        grid: BASE_GRID,
        wins: [],
        events: [],
        feature: feature(),
      },
      requestId,
    });
  }

  function sessionStatus(request) {
    if (exchangeCount !== 1) {
      throw new Error("RGS 会话状态探测发生在受控会话交换之前");
    }
    requireEqual(request.method, "POST", "RGS 会话状态方法");
    requireJsonCorsRequest(request, pageOrigin);
    requireAuthorization(request, `Bearer ${ACCESS_TOKEN}`);
    const requestId = requireRequestId(request);
    const body = parseBody(request, [
      "operatorId",
      "sessionId",
      "gameId",
      "definitionVersion",
      "definitionHash",
      "currency",
      "currencyExponent",
      "jurisdiction",
    ], "RGS 会话状态");
    for (const [name, value] of Object.entries(expectedBinding)) {
      requireEqual(body[name], value, `RGS 会话状态 ${name}`);
    }
    sessionStatusObservedAtMs.push(observedNow(now, "RGS 会话状态"));
    sessionStatusCount += 1;
    return jsonFulfillment(pageOrigin, {
      data: {
        operatorId: options.operatorId,
        sessionId: options.sessionId,
        status: "ACTIVE",
        idleDisconnectAt: committedRound === null
          ? "2098-12-31T23:30:00Z"
          : "2098-12-31T23:45:00Z",
        serverTime: "2026-08-21T08:00:00Z",
      },
      requestId,
    });
  }

  function acknowledge(request) {
    if (exchangeCount !== 1 || spinCount !== 1 || acknowledgementCount !== 0
      || committedRound === null) {
      throw new Error("RGS 结果 ACK 次数或顺序不符合事务契约");
    }
    requireEqual(request.method, "POST", "RGS 结果 ACK 方法");
    requireJsonCorsRequest(request, pageOrigin);
    requireAuthorization(request, `Bearer ${ACCESS_TOKEN}`);
    const requestId = requireRequestId(request);
    const body = parseBody(request, [
      "operatorId",
      "sessionId",
      "gameId",
      "definitionVersion",
      "definitionHash",
      "currency",
      "currencyExponent",
      "jurisdiction",
      "roundId",
      "sequence",
      "resultHash",
    ], "RGS 结果 ACK");
    for (const [name, value] of Object.entries(expectedBinding)) {
      requireEqual(body[name], value, `RGS 结果 ACK ${name}`);
    }
    requireEqual(body.roundId, committedRound.roundId, "RGS ACK 轮次标识");
    requireEqual(body.sequence, committedRound.sequence, "RGS ACK 序列号");
    requireEqual(body.resultHash, committedRound.resultHash, "RGS ACK 结果摘要");
    acknowledgementCount += 1;
    order.push("result-acknowledgement");
    return jsonFulfillment(pageOrigin, {
      data: {
        operatorId: options.operatorId,
        sessionId: options.sessionId,
        roundId: committedRound.roundId,
        sequence: committedRound.sequence,
        resultHash: committedRound.resultHash,
        acknowledgedAt: "2026-08-21T08:00:00Z",
      },
      requestId,
    });
  }

  function responseForPausedRequest(parameters) {
    const request = parameters?.request;
    if (!request || typeof request.url !== "string") {
      throw new Error("Chrome Fetch 事件缺少请求信息");
    }
    const target = new URL(request.url);
    if (target.origin !== baseUrl.origin) throw new Error("拦截到非目标 RGS 来源");
    const route = target.href === exchangeUrl.href
      ? exchange
      : target.href === sessionStatusUrl.href
        ? sessionStatus
        : target.href === spinUrl.href
          ? spin
          : target.href === acknowledgementUrl.href
            ? acknowledge
            : null;
    if (route === null) throw new Error(`受控 RGS 收到未声明路径：${target.pathname}`);
    if (request.method === "OPTIONS") return preflight(request);
    return route(request);
  }

  function snapshot() {
    return Object.freeze({
      exchangeCount,
      exchangeObservedAtMs,
      sessionStatusCount,
      sessionStatusObservedAtMs: Object.freeze([...sessionStatusObservedAtMs]),
      spinCount,
      acknowledgementCount,
      order: Object.freeze([...order]),
      committedRoundObserved: committedRound !== null,
    });
  }

  return Object.freeze({
    interceptedOriginPattern: `${baseUrl.origin}/*`,
    responseForPausedRequest,
    snapshot,
  });
}

function observedNow(now, label) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} 缺少有效单调时间`);
  }
  return value;
}
