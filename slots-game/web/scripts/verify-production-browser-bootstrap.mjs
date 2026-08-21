import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE,
  createReleaseContentSecurityPolicy,
  verifyReleaseContentSecurityPolicy,
} from "../../deploy/web/content-security-policy.mjs";
import { createControlledRgsTransactionFixture } from "./production-browser-transaction-fixture.mjs";
import { validateReleaseRgsBuildEnvironment } from "../src/validateReleaseRgsBuildConfig.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = distributionRootFromArguments(process.argv.slice(2));
const bootstrapFailureText = "The game could not start. Please try again.";
// 该时限覆盖隔离 Chrome 的首次资产解析、WebGL 装配和 200ms 减少动态介绍；
// 它不是线上启动性能预算。冷缓存机器仍必须在 30 秒内完成，否则门禁失败。
const startupTimeoutMs = 30_000;
const transactionTimeoutMs = 25_000;
const commandTimeoutMs = Math.max(startupTimeoutMs, transactionTimeoutMs) + 5_000;
const CONTINUOUS_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1_280, height: 720 }),
  Object.freeze({ width: 1_440, height: 900 }),
  Object.freeze({ width: 390, height: 844 }),
  Object.freeze({ width: 633, height: 844 }),
  Object.freeze({ width: 844, height: 390 }),
  Object.freeze({ width: 844, height: 633 }),
  Object.freeze({ width: 1_024, height: 768 }),
]);
const DESKTOP_VIEWPORT_SURFACE = Object.freeze({
  profile: "desktop",
  designWidth: 1_280,
  designHeight: 720,
});
const MOBILE_VIEWPORT_SURFACES = Object.freeze({
  "1280x720": Object.freeze({ profile: "tablet-ls", designWidth: 844, designHeight: 633 }),
  "1440x900": Object.freeze({ profile: "tablet-ls", designWidth: 844, designHeight: 633 }),
  "390x844": Object.freeze({ profile: "phone-pt", designWidth: 390, designHeight: 844 }),
  "633x844": Object.freeze({ profile: "tablet-pt", designWidth: 633, designHeight: 844 }),
  "844x390": Object.freeze({ profile: "phone-ls", designWidth: 844, designHeight: 390 }),
  "844x633": Object.freeze({ profile: "tablet-ls", designWidth: 844, designHeight: 633 }),
  "1024x768": Object.freeze({ profile: "tablet-ls", designWidth: 844, designHeight: 633 }),
});
validateReleaseRgsBuildEnvironment(process.env);
const browserRgsBaseUrl = process.env.VITE_RGS_BASE_URL;
const browserHostOrigin = process.env.VITE_RGS_HOST_ORIGIN;
const browserBetMinor = process.env.VITE_RGS_DEFAULT_BET_MINOR;
const initialBalanceMinor = (BigInt(browserBetMinor) + 800n).toString();
const finalBalanceMinor = "800";
const expectedInitialBalance = formatMinor(initialBalanceMinor, 2);
const expectedFinalBalance = formatMinor(finalBalanceMinor, 2);
const browserContentSecurityPolicy = createReleaseContentSecurityPolicy({
  rgsBaseUrl: browserRgsBaseUrl,
  hostOrigin: browserHostOrigin,
});
verifyReleaseContentSecurityPolicy(browserContentSecurityPolicy, {
  rgsBaseUrl: browserRgsBaseUrl,
  hostOrigin: browserHostOrigin,
});

const BROWSER_TRANSACTION_PROBE_SOURCE = `
  (() => {
    const probe = {
      operatorSessionRequests: [],
      playerErrors: [],
      runtimeErrors: [],
      unhandledRejections: [],
      transaction: null,
    };
    Object.defineProperty(globalThis, "__slotsProductionTransactionProbe", {
      configurable: false,
      enumerable: false,
      value: probe,
      writable: false,
    });
    addEventListener("slots-game:operator-session-required", (event) => {
      probe.operatorSessionRequests.push({
        code: String(event?.detail?.code ?? "unknown").slice(0, 64),
        reason: String(event?.detail?.reason ?? "unknown").slice(0, 64),
      });
    });
    addEventListener("slots-game:player-error", (event) => {
      probe.playerErrors.push(String(event?.detail?.code ?? "unknown").slice(0, 64));
    });
    addEventListener("error", (event) => {
      probe.runtimeErrors.push(String(event?.error?.name ?? "Error").slice(0, 64));
    });
    addEventListener("unhandledrejection", (event) => {
      probe.unhandledRejections.push(String(event?.reason?.name ?? "UnhandledRejection").slice(0, 64));
    });
    try {
      localStorage.setItem("primal-rampage.feature-preview.dismissed.v1", "1");
    } catch {
      probe.runtimeErrors.push("FeaturePreviewStorageUnavailable");
    }
  })();
`;

const contentTypes = Object.freeze({
  ".atlas": "text/plain; charset=utf-8",
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".fnt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".skel": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
});

function distributionRootFromArguments(argumentsValue) {
  if (argumentsValue.length === 0) return resolve(webRoot, "dist");
  if (argumentsValue.length !== 2 || argumentsValue[0] !== "--distribution-root"
    || argumentsValue[1] === "") {
    throw new Error("用法：verify-production-browser-bootstrap.mjs [--distribution-root PATH]");
  }
  return resolve(argumentsValue[1]);
}

await access(resolve(distributionRoot, "index.html"));
const distributionRealRoot = await realpath(distributionRoot);
const modulePaths = await productionModulePaths(distributionRoot);
await verifyEmbeddedBuildConfiguration(distributionRoot, modulePaths);
const chromeExecutable = findChromeExecutable();
const profileDirectory = await mkdtemp(join(tmpdir(), "slots-production-browser-"));
const server = createDistributionServer();
const chrome = await launchChrome(chromeExecutable, profileDirectory);
let pageSocket;
let verifiedEntryPath;

try {
  const address = await listenOnLoopback(server);
  const launchCode = `lc_${"b".repeat(43)}`;
  const operatorId = "browser-smoke";
  const sessionId = "browser-smoke";
  const pageOrigin = `http://127.0.0.1:${address.port}`;
  const pageUrl = `${pageOrigin}/?channel=desktop#${new URLSearchParams({
    rgsLaunchCode: launchCode,
    rgsOperatorId: operatorId,
    rgsSessionId: sessionId,
  })}`;
  const transactionFixture = createControlledRgsTransactionFixture({
    baseUrl: browserRgsBaseUrl,
    pageOrigin: new URL(pageUrl).origin,
    launchCode,
    operatorId,
    sessionId,
    initialBalanceMinor,
    betMinor: browserBetMinor,
    finalBalanceMinor,
  });
  const mobileLaunchCode = `lc_${"m".repeat(43)}`;
  const mobileOperatorId = "browser-smoke-mobile";
  const mobileSessionId = "browser-smoke-mobile";
  const mobilePageUrl = `${pageOrigin}/?channel=mobile#${new URLSearchParams({
    rgsLaunchCode: mobileLaunchCode,
    rgsOperatorId: mobileOperatorId,
    rgsSessionId: mobileSessionId,
  })}`;
  const mobileLayoutFixture = createControlledRgsTransactionFixture({
    baseUrl: browserRgsBaseUrl,
    pageOrigin,
    launchCode: mobileLaunchCode,
    operatorId: mobileOperatorId,
    sessionId: mobileSessionId,
    initialBalanceMinor,
    betMinor: browserBetMinor,
    finalBalanceMinor,
  });
  const debuggingPort = await chrome.debuggingPort;
  const target = await waitForPageTarget(debuggingPort);
  pageSocket = await connectDevTools(target.webSocketDebuggerUrl);
  const result = await verifyBootstrap(
    pageSocket,
    pageUrl,
    modulePaths,
    transactionFixture,
    mobilePageUrl,
    mobileLayoutFixture,
  );
  if (!Array.isArray(result.cspViolations)) {
    throw new Error("生产浏览器 CSP 违规探针未返回可信结果");
  }
  if (result.cspViolations.length > 0) {
    throw new Error(`生产模块求值触发 CSP 违规：${JSON.stringify(result.cspViolations)}`);
  }
  if (result.moduleFailures.length > 0) {
    const detail = result.moduleFailures
      .map(({ path, name, message, stack }) => [path, name, message, stack].filter(Boolean).join("\n"))
      .join("\n\n");
    throw new Error(`生产入口在真实浏览器中求值失败：\n${detail}`);
  }
  if (!result.rendererReady) {
    throw new Error(
      `生产入口没有完成严格 CSP Pixi/WebGL 装配：${JSON.stringify(result.rendererEvidence)}`,
    );
  }
  if (result.status === bootstrapFailureText) {
    throw new Error("生产入口被启动边界判定为模块加载失败");
  }
  if (result.operatorSessionRequests.length > 0
    || result.playerErrors.includes("OPERATOR_SESSION_REQUIRED")) {
    throw new Error("生产浏览器事务触发 OPERATOR_SESSION_REQUIRED，禁止把会话失败页判绿");
  }
  if (result.playerErrors.length > 0) {
    throw new Error(`生产浏览器事务触发玩家错误码：${JSON.stringify({
      codes: result.playerErrors,
      diagnostics: result.diagnostics,
      finalState: result.finalState,
      transactionEvidence: result.transactionEvidence,
    })}`);
  }
  if (result.runtimeErrors.length > 0 || result.unhandledRejections.length > 0) {
    throw new Error("生产浏览器事务发生未处理的运行时异常");
  }
  const transactionEvidence = result.transactionEvidence;
  if (transactionEvidence.exchangeCount !== 1
    || transactionEvidence.spinCount !== 1
    || transactionEvidence.acknowledgementCount !== 1
    || !transactionEvidence.committedRoundObserved
    || JSON.stringify(transactionEvidence.order)
      !== JSON.stringify(["session-exchange", "spin", "result-acknowledgement"])) {
    throw new Error(`生产浏览器 RGS 事务不完整：${JSON.stringify(transactionEvidence)}`);
  }
  for (const stage of ["decode-complete", "controller-dispatch", "callback", "accepted"]) {
    if (!result.deliveryStages.includes(stage)) {
      throw new Error(`生产浏览器事务没有观察到结果交付阶段：${stage}`);
    }
  }
  for (const state of [
    "Spin_Start",
    "Spinning",
    "Spin_Stopping",
    "Reel_Stop_One_By_One",
    "Result_Show",
    "Win_Line_Animation",
    "Idle",
  ]) {
    if (!result.reelStates.includes(state)) {
      throw new Error(`生产浏览器事务没有观察到转轴表现状态：${state}`);
    }
  }
  const finalState = result.finalState;
  if (finalState.balance !== "8.00" || finalState.balance !== expectedFinalBalance
    || finalState.lastWin !== "0.00"
    || finalState.reelState !== "Idle"
    || finalState.hasReelRoundId
    || finalState.spinMode !== "ready"
    || finalState.spinAction !== "spin"
    || finalState.spinDisabled
    || finalState.launchPhase !== "ready") {
    throw new Error(`生产浏览器事务完成后没有恢复可下注状态：${JSON.stringify(finalState)}`);
  }
  if (!result.balanceValues.includes(expectedInitialBalance)
    || !result.balanceValues.includes(expectedFinalBalance)) {
    throw new Error("生产浏览器事务没有观察到权威余额从会话值更新为结算值");
  }
  const visualEvidence = result.visualEvidence;
  if (!visualEvidence
    || visualEvidence.baselineBytes < 10_000
    || visualEvidence.activeBytes < 10_000
    || visualEvidence.finalBytes < 10_000
    || visualEvidence.activeReelState === "Idle"
    || new Set([
      visualEvidence.baselineDigest,
      visualEvidence.activeDigest,
      visualEvidence.finalDigest,
    ]).size !== 3) {
    throw new Error(`生产浏览器事务缺少真实 WebGL 画面变化证据：${JSON.stringify(visualEvidence)}`);
  }
  validateContinuousViewportEvidence(result.viewportEvidence);
  const mobileSessionEvidence = result.mobileSessionEvidence;
  if (!mobileSessionEvidence
    || mobileSessionEvidence.exchangeCount !== 1
    || mobileSessionEvidence.spinCount !== 0
    || mobileSessionEvidence.acknowledgementCount !== 0
    || mobileSessionEvidence.committedRoundObserved
    || JSON.stringify(mobileSessionEvidence.order) !== JSON.stringify(["session-exchange"])) {
    throw new Error(`移动布局会话被黑边点击或视口切换污染：${JSON.stringify(mobileSessionEvidence)}`);
  }
  verifiedEntryPath = basename(result.entryPath);
} finally {
  await cleanupBrowserResources({
    browser: chrome.process,
    pageSocket,
    profileDirectory,
    server,
  });
}

process.stdout.write(
  `生产浏览器事务门禁通过：${verifiedEntryPath} 已在精确 CSP 下完成桌面/移动连续视口等比黑边门禁，以及会话交换、旋转、结果解码与表现、余额更新及结果 ACK。\n`,
);

function createDistributionServer() {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
      const candidate = resolve(distributionRoot, `.${requestedPath}`);
      const relativePath = relative(distributionRoot, candidate);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        response.writeHead(404).end();
        return;
      }
      const filePath = await realpath(candidate);
      const realRelativePath = relative(distributionRealRoot, filePath);
      if (realRelativePath.startsWith(`..${sep}`) || realRelativePath === "..") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": browserContentSecurityPolicy,
        "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function verifyEmbeddedBuildConfiguration(root, productionModules) {
  const javascript = (await Promise.all(productionModules.map((modulePath) => (
    readFile(resolve(root, `.${modulePath}`), "utf8")
  )))).join("\n");
  const expectedValues = [
    process.env.VITE_RGS_BASE_URL,
    process.env.VITE_RGS_BET_OPTIONS_MINOR,
    process.env.VITE_RGS_DEFAULT_BET_MINOR,
    process.env.VITE_RGS_HOST_ORIGIN,
  ];
  for (const value of expectedValues) {
    if (!javascript.includes(JSON.stringify(value).slice(1, -1))) {
      throw new Error("生产浏览器门禁环境与 dist 内联的 RGS 配置不一致");
    }
  }
}

async function productionModulePaths(root, parent = root) {
  const paths = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const path = resolve(parent, entry.name);
    if (entry.isDirectory()) paths.push(...await productionModulePaths(root, path));
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      paths.push(`/${relative(root, path).split(sep).join("/")}`);
    }
  }
  return paths.sort((left, right) => {
    const leftMain = /(^|\/)main-[^/]+\.js$/.test(left);
    const rightMain = /(^|\/)main-[^/]+\.js$/.test(right);
    if (leftMain !== rightMain) return leftMain ? -1 : 1;
    return left.localeCompare(right);
  });
}

function listenOnLoopback(serverValue) {
  return new Promise((resolvePromise, rejectPromise) => {
    serverValue.once("error", rejectPromise);
    serverValue.listen(0, "127.0.0.1", () => {
      serverValue.off("error", rejectPromise);
      resolvePromise(serverValue.address());
    });
  });
}

function closeServer(serverValue, timeoutMs = 2_000) {
  if (!serverValue.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let forceTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(forceTimer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const deadlineTimer = setTimeout(() => {
      serverValue.closeAllConnections?.();
      forceTimer = setTimeout(() => {
        finish(new Error("生产浏览器静态服务器在强制关闭连接后仍未退出"));
      }, 500);
    }, timeoutMs);
    serverValue.close((error) => finish(error));
    serverValue.closeIdleConnections?.();
  });
}

async function cleanupBrowserResources({ browser, pageSocket: socket, profileDirectory: profile, server: serverValue }) {
  const cleanupErrors = [];
  const capture = (error) => {
    cleanupErrors.push(error instanceof Error ? error : new Error("生产浏览器资源清理失败"));
  };

  try {
    socket?.close();
  } catch (error) {
    capture(error);
  }
  // 先终止 Chrome 释放其 HTTP/CDP 连接，再关闭本地静态服务器；各步骤独立失败闭合。
  try {
    await stopChrome(browser);
  } catch (error) {
    capture(error);
  } finally {
    // Crashpad 可能在 Chrome 主进程退出后继续继承 stderr 写端；主动销毁本门禁的读端，
    // 避免孤儿 crashpad 让 Node 的事件循环永久等待管道 EOF。
    browser.stderr?.destroy();
  }
  try {
    await closeServer(serverValue);
  } catch (error) {
    capture(error);
  }
  try {
    // Chrome 主进程退出后，Linux 上的短命子进程仍可能在极短时间内关闭配置文件。
    // 使用有界重试清理专用临时目录，既避免 CI 的 ENOTEMPTY 竞态，也不遗留浏览器状态。
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    capture(error);
  }

  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "生产浏览器资源清理发生多个错误");
  }
}

function findChromeExecutable() {
  const configured = process.env.CHROME_BIN;
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("未找到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定固定路径");
}

function launchChrome(executable, profileDirectoryValue) {
  // Linux CI runner 没有实体 GPU；只对隔离的本地发布字节启用 Chrome 自带软件 WebGL，
  // macOS 验收仍走真实图形栈，生产浏览器不会继承此参数。
  const softwareWebglArguments = process.platform === "linux"
    ? ["--enable-unsafe-swiftshader"]
    : [];
  const browser = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--force-prefers-reduced-motion=reduce",
    ...softwareWebglArguments,
    "--disable-sync",
    "--no-first-run",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectoryValue}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const debuggingPort = new Promise((resolvePromise, rejectPromise) => {
    let diagnostics = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error("等待浏览器调试端口超时"));
    }, startupTimeoutMs);
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4_096);
      const match = diagnostics.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timer);
      resolvePromise(Number(match[1]));
    });
    browser.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    browser.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`浏览器提前退出：code=${code ?? "none"}, signal=${signal ?? "none"}`));
    });
  });
  return { process: browser, debuggingPort };
}

async function waitForPageTarget(debuggingPort) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const createResponse = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent("about:blank")}`,
        { method: "PUT" },
      );
      if (!createResponse.ok) throw new Error(`DevTools target HTTP ${createResponse.status}`);
      const target = await createResponse.json();
      if (typeof target.webSocketDebuggerUrl === "string") return target;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("无法创建生产浏览器测试页");
}

function connectDevTools(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolvePromise(socket), { once: true });
    socket.addEventListener("error", () => rejectPromise(new Error("无法连接浏览器调试协议")), {
      once: true,
    });
  });
}

async function verifyBootstrap(
  socket,
  pageUrl,
  productionModules,
  transactionFixture,
  mobilePageUrl,
  mobileLayoutFixture,
) {
  let identifier = 0;
  let documentContentSecurityPolicy;
  let transportFailure = null;
  let activeTransactionFixture = transactionFixture;
  let expectedDocumentUrl = documentUrlWithoutHash(pageUrl);
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.responseReceived") {
      const response = message.params?.response;
      if (message.params?.type === "Document" && response?.url === expectedDocumentUrl.href) {
        const policyHeader = Object.entries(response.headers ?? {})
          .find(([name]) => name.toLowerCase() === "content-security-policy");
        documentContentSecurityPolicy = policyHeader ? String(policyHeader[1]) : undefined;
      }
    }
    if (message.method === "Fetch.requestPaused") {
      void fulfillControlledRgsRequest(message.params).catch((error) => {
        transportFailure = error instanceof Error ? error : new Error("受控 RGS 响应失败");
      });
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("浏览器调试连接提前关闭"));
    }
    pending.clear();
  }, { once: true });

  const send = (method, params = {}) => {
    const id = ++identifier;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`浏览器调试命令超时：${method}`));
      }, commandTimeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  async function fulfillControlledRgsRequest(parameters) {
    try {
      const fulfillment = activeTransactionFixture.responseForPausedRequest(parameters);
      await send("Fetch.fulfillRequest", {
        requestId: parameters.requestId,
        responseCode: fulfillment.responseCode,
        responseHeaders: fulfillment.responseHeaders,
        ...(fulfillment.body === undefined
          ? {}
          : { body: Buffer.from(fulfillment.body, "utf8").toString("base64") }),
      });
    } catch (error) {
      transportFailure = error instanceof Error ? error : new Error("受控 RGS 请求不符合契约");
      try {
        await send("Fetch.failRequest", {
          requestId: parameters.requestId,
          errorReason: "Failed",
        });
      } catch {
        // 首个协议失败仍是根因；浏览器调试连接的后续失败不能覆盖它。
      }
      throw transportFailure;
    }
  }

  await Promise.all([
    send("Page.enable"),
    send("Runtime.enable"),
    send("Network.enable"),
    send("Fetch.enable", {
      patterns: [{
        urlPattern: transactionFixture.interceptedOriginPattern,
        requestStage: "Request",
      }],
    }),
  ]);
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: BROWSER_TRANSACTION_PROBE_SOURCE,
  });
  await send("Page.navigate", { url: pageUrl });
  await waitForDocumentReady(send);
  if (documentContentSecurityPolicy !== browserContentSecurityPolicy) {
    throw new Error("生产浏览器主文档未收到共享的精确发布 CSP");
  }
  const bootstrap = await evaluateValue(send, {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      (async () => {
        const readCspViolations = () => {
          const snapshot = globalThis.__slotsContentSecurityPolicyProbe?.violations;
          if (!Array.isArray(snapshot)) {
            return [{ effectiveDirective: "probe-missing", disposition: "enforce" }];
          }
          return snapshot.slice(0, 16).map((violation) => ({
            effectiveDirective: String(violation?.effectiveDirective ?? '').slice(0, 64),
            violatedDirective: String(violation?.violatedDirective ?? '').slice(0, 64),
            disposition: String(violation?.disposition ?? '').slice(0, 32),
            blockedTarget: String(violation?.blockedTarget ?? '').slice(0, 256),
          }));
        };
        const entry = document.querySelector('script[type="module"][src]');
        if (!entry) return {
          entryPath: "missing",
          moduleFailures: [{ message: "missing production module entry" }],
          status: null,
          cspViolations: readCspViolations(),
        };
        const productionModules = ${JSON.stringify(productionModules)};
        const moduleFailures = [];
        for (const path of productionModules) {
          const url = new URL(path, location.href).href;
          try {
            await import(url);
          } catch (error) {
            moduleFailures.push({
              path: new URL(url).pathname,
              name: error?.name,
              message: error?.message,
              stack: error?.stack,
            });
          }
        }
        const observedStages = [];
        const deadline = Date.now() + ${startupTimeoutMs};
        let rendererReady = false;
        let rendererEvidence = null;
        while (Date.now() < deadline) {
          const root = document.querySelector('#app');
          const stage = root?.dataset.startupAssemblyStage ?? null;
          if (stage !== null && observedStages.at(-1) !== stage) observedStages.push(stage);
          const canvas = root?.querySelector('[data-role="canvas"] canvas');
          let webgl = false;
          if (canvas instanceof HTMLCanvasElement) {
            try {
              webgl = Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
            } catch {
              webgl = false;
            }
          }
          rendererEvidence = {
            canvasHeight: canvas instanceof HTMLCanvasElement ? canvas.height : 0,
            canvasWidth: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
            pixiCspMode: root?.dataset.pixiCspMode ?? null,
            stage,
            observedStages: observedStages.slice(-16),
            webgl,
          };
          rendererReady = rendererEvidence.pixiCspMode === 'static-uniform-sync'
            && rendererEvidence.canvasWidth > 0
            && rendererEvidence.canvasHeight > 0
            && rendererEvidence.webgl
            && ['renderer-mounted', 'controller-wired', 'readiness-complete-painted'].includes(stage);
          if (rendererReady || stage === 'assembly-failed') break;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        return {
          entryPath: new URL(entry.src).pathname,
          moduleFailures,
          rendererEvidence,
          rendererReady,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          status: document.querySelector('.launch-loading__status')?.textContent ?? null,
          cspViolations: readCspViolations(),
        };
      })()
    `,
  });
  let browserState = await waitForApplicationReady(send, () => transportFailure);
  if (!browserState.ready) {
    return completeBrowserResult(bootstrap, browserState, transactionFixture.snapshot());
  }
  if (!bootstrap.reducedMotion) {
    throw new Error("生产浏览器事务夹具没有启用系统级减少动态效果配置");
  }
  const desktopViewportEvidence = await verifyContinuousViewportTransitions(
    send,
    transactionFixture,
    {
      channel: "desktop",
      surfaceForViewport: () => DESKTOP_VIEWPORT_SURFACE,
      transportFailure: () => transportFailure,
    },
  );
  await armTransactionObservation(send);
  const baselineCapture = await captureGameCanvas(send);
  await clickPrimarySpin(send);
  const activeState = await waitForActivePresentation(
    send,
    transactionFixture,
    () => transportFailure,
  );
  const activeCapture = await captureGameCanvas(send);
  browserState = await waitForTransactionCompletion(
    send,
    transactionFixture,
    () => transportFailure,
  );
  const finalCapture = await captureGameCanvas(send);
  const transactionResult = completeBrowserResult(
    bootstrap,
    browserState,
    transactionFixture.snapshot(),
    {
      baselineBytes: baselineCapture.bytes,
      baselineDigest: baselineCapture.digest,
      activeBytes: activeCapture.bytes,
      activeDigest: activeCapture.digest,
      activeReelState: activeState.finalState.reelState,
      finalBytes: finalCapture.bytes,
      finalDigest: finalCapture.digest,
    },
  );

  // 通道在 ResponsiveLayout 构造时冻结。移动四表面必须使用新的、独立的受控会话，
  // 不能靠同一文档中改查询参数或伪造 pointer media 结果来绕过该生产契约。
  activeTransactionFixture = mobileLayoutFixture;
  transportFailure = null;
  documentContentSecurityPolicy = undefined;
  expectedDocumentUrl = documentUrlWithoutHash(mobilePageUrl);
  await send("Page.navigate", { url: mobilePageUrl });
  await waitForDocumentReady(send);
  if (documentContentSecurityPolicy !== browserContentSecurityPolicy) {
    throw new Error("移动布局生产主文档未收到共享的精确发布 CSP");
  }
  const mobileBrowserState = await waitForApplicationReady(send, () => transportFailure);
  if (!mobileBrowserState.ready || mobileBrowserState.explicitFailure) {
    throw new Error(`移动布局生产会话没有进入可下注状态：${JSON.stringify({
      finalState: mobileBrowserState.finalState,
      diagnostics: mobileBrowserState.diagnostics,
      playerErrors: mobileBrowserState.playerErrors,
      runtimeErrors: mobileBrowserState.runtimeErrors,
      unhandledRejections: mobileBrowserState.unhandledRejections,
      cspViolations: mobileBrowserState.cspViolations,
    })}`);
  }
  const mobileViewportEvidence = await verifyContinuousViewportTransitions(
    send,
    mobileLayoutFixture,
    {
      channel: "mobile",
      surfaceForViewport: ({ width, height }) => (
        MOBILE_VIEWPORT_SURFACES[`${width}x${height}`]
      ),
      transportFailure: () => transportFailure,
    },
  );
  const mobilePostViewportState = await readBrowserState(send);
  if (!mobilePostViewportState.ready || mobilePostViewportState.explicitFailure) {
    throw new Error(`移动布局连续视口切换后出现运行时失败：${JSON.stringify({
      finalState: mobilePostViewportState.finalState,
      playerErrors: mobilePostViewportState.playerErrors,
      runtimeErrors: mobilePostViewportState.runtimeErrors,
      unhandledRejections: mobilePostViewportState.unhandledRejections,
      cspViolations: mobilePostViewportState.cspViolations,
    })}`);
  }
  return Object.freeze({
    ...transactionResult,
    mobileFinalState: mobilePostViewportState.finalState,
    mobileSessionEvidence: mobileLayoutFixture.snapshot(),
    viewportEvidence: Object.freeze({
      desktop: desktopViewportEvidence,
      mobile: mobileViewportEvidence,
    }),
  });
}

async function verifyContinuousViewportTransitions(send, fixture, options) {
  const initialSnapshot = await readViewportLayout(send);
  if (!initialSnapshot || initialSnapshot.frameCount !== 1 || !initialSnapshot.nodeIdentityPreserved) {
    throw new Error(`连续视口门禁无法建立唯一游戏框架身份：${JSON.stringify(initialSnapshot)}`);
  }
  const initialState = initialSnapshot.state;
  const steps = [];
  let blackBorderClickCount = 0;

  for (const viewport of CONTINUOUS_VIEWPORTS) {
    const transportError = options.transportFailure?.();
    if (transportError) throw transportError;
    const surface = options.surfaceForViewport(viewport);
    if (!surface) {
      throw new Error(`连续视口缺少设计表面：${viewport.width}x${viewport.height}`);
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    const snapshot = await waitForStableViewportLayout(
      send,
      viewport,
      surface,
      options.channel,
      options.transportFailure,
    );
    assertViewportGeometry(snapshot, viewport, surface, options.channel);
    assertViewportStatePreserved(initialState, snapshot.state, viewport, options.channel);

    const borderPoint = blackBorderPoint(snapshot);
    let blackBorderClicked = false;
    if (borderPoint !== null) {
      const beforeTransaction = fixture.snapshot();
      await dispatchMouseClick(send, borderPoint);
      await delay(100);
      const clickTransportError = options.transportFailure?.();
      if (clickTransportError) throw clickTransportError;
      const afterTransaction = fixture.snapshot();
      const afterClick = await readViewportLayout(send);
      if (JSON.stringify(afterTransaction) !== JSON.stringify(beforeTransaction)) {
        throw new Error(`黑边点击触发了 RGS 事务：${JSON.stringify({
          viewport,
          beforeTransaction,
          afterTransaction,
        })}`);
      }
      assertViewportStatePreserved(initialState, afterClick.state, viewport, options.channel);
      if (!afterClick.nodeIdentityPreserved) {
        throw new Error(`黑边点击替换了游戏框架节点：${viewport.width}x${viewport.height}`);
      }
      blackBorderClickCount += 1;
      blackBorderClicked = true;
    }

    steps.push(Object.freeze({
      width: viewport.width,
      height: viewport.height,
      channel: snapshot.channel,
      profile: snapshot.profile,
      designWidth: snapshot.designWidth,
      designHeight: snapshot.designHeight,
      scale: snapshot.datasetScale,
      x: snapshot.frameRect.left,
      y: snapshot.frameRect.top,
      balance: snapshot.state.balance,
      reelState: snapshot.state.reelState,
      roundId: snapshot.state.roundId,
      nodeIdentityPreserved: snapshot.nodeIdentityPreserved,
      statePreserved: true,
      blackBorderClicked,
    }));
  }

  return Object.freeze({
    blackBorderClickCount,
    channel: options.channel,
    steps: Object.freeze(steps),
  });
}

async function waitForStableViewportLayout(
  send,
  viewport,
  surface,
  channel,
  transportFailure,
) {
  const deadline = Date.now() + 5_000;
  let previousKey = null;
  let stableReads = 0;
  let snapshot = null;
  while (Date.now() < deadline) {
    const transportError = transportFailure?.();
    if (transportError) throw transportError;
    snapshot = await readViewportLayout(send);
    const expectedScale = Math.min(
      viewport.width / surface.designWidth,
      viewport.height / surface.designHeight,
    );
    const expectedWidth = surface.designWidth * expectedScale;
    const expectedHeight = surface.designHeight * expectedScale;
    const eligible = snapshot?.viewportWidth === viewport.width
      && snapshot?.viewportHeight === viewport.height
      && snapshot?.frameCount === 1
      && snapshot?.channel === channel
      && snapshot?.profile === surface.profile
      && snapshot?.designWidth === surface.designWidth
      && snapshot?.designHeight === surface.designHeight
      && Math.abs(snapshot.datasetScale - expectedScale) <= 0.000_001
      && Math.abs(snapshot.frameRect.width - expectedWidth) <= 0.75
      && Math.abs(snapshot.frameRect.height - expectedHeight) <= 0.75;
    if (eligible) {
      const stabilityKey = JSON.stringify([
        snapshot.viewportWidth,
        snapshot.viewportHeight,
        snapshot.channel,
        snapshot.profile,
        snapshot.designWidth,
        snapshot.designHeight,
        rounded(snapshot.datasetScale),
        rounded(snapshot.frameRect.left),
        rounded(snapshot.frameRect.top),
        rounded(snapshot.frameRect.width),
        rounded(snapshot.frameRect.height),
      ]);
      stableReads = stabilityKey === previousKey ? stableReads + 1 : 1;
      previousKey = stabilityKey;
      if (stableReads >= 2) return snapshot;
    } else {
      previousKey = null;
      stableReads = 0;
    }
    await delay(50);
  }
  throw new Error(`生产布局未稳定到目标视口：${JSON.stringify({
    viewport,
    surface,
    channel,
    snapshot,
  })}`);
}

async function readViewportLayout(send) {
  return evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const probe = globalThis.__slotsProductionTransactionProbe;
        const root = document.querySelector('#app');
        const viewport = root?.querySelector('[data-role="viewport"]');
        const safeArea = root?.querySelector('[data-role="safe-area"]');
        const frames = root?.querySelectorAll('[data-role="frame"]') ?? [];
        const frame = frames.item(0);
        const spin = root?.querySelector('[data-role="spin"]');
        const balance = root?.querySelector('[data-role="balance"]');
        const bet = root?.querySelector('[data-role="bet"]');
        const lastWin = root?.querySelector('[data-role="last-win"]');
        const overlay = root?.querySelector('[data-role="overlay"]');
        if (!probe || !(root instanceof HTMLElement) || !(viewport instanceof HTMLElement)
          || !(safeArea instanceof HTMLElement) || !(frame instanceof HTMLElement)) {
          return {
            frameCount: frames.length,
            nodeIdentityPreserved: false,
            probeMissing: !probe,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
          };
        }
        if (!probe.viewportIdentity) {
          probe.viewportIdentity = { root, viewport, safeArea, frame, spin, balance, bet, lastWin };
        }
        const identity = probe.viewportIdentity;
        const frameStyle = getComputedStyle(frame);
        const frameRect = frame.getBoundingClientRect();
        const safeAreaRect = safeArea.getBoundingClientRect();
        let matrix = null;
        try {
          const parsed = new DOMMatrixReadOnly(frameStyle.transform === 'none'
            ? undefined
            : frameStyle.transform);
          matrix = {
            a: parsed.a,
            b: parsed.b,
            c: parsed.c,
            d: parsed.d,
            e: parsed.e,
            f: parsed.f,
            is2D: parsed.is2D,
          };
        } catch {
          matrix = null;
        }
        return {
          backgroundColors: {
            html: getComputedStyle(document.documentElement).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            root: getComputedStyle(root).backgroundColor,
            viewport: getComputedStyle(viewport).backgroundColor,
            safeArea: getComputedStyle(safeArea).backgroundColor,
          },
          channel: frame.dataset.channel ?? null,
          computedHeight: frameStyle.height,
          computedLeft: frameStyle.left,
          computedTop: frameStyle.top,
          computedWidth: frameStyle.width,
          datasetScale: Number(frame.dataset.frameScale),
          datasetX: Number(frame.dataset.frameX),
          datasetY: Number(frame.dataset.frameY),
          designHeight: Number(frame.dataset.designHeight),
          designWidth: Number(frame.dataset.designWidth),
          frameCount: frames.length,
          frameRect: {
            bottom: frameRect.bottom,
            height: frameRect.height,
            left: frameRect.left,
            right: frameRect.right,
            top: frameRect.top,
            width: frameRect.width,
          },
          matrix,
          nodeIdentityPreserved: identity.root === root
            && identity.viewport === viewport
            && identity.safeArea === safeArea
            && identity.frame === frame
            && identity.spin === spin
            && identity.balance === balance
            && identity.bet === bet
            && identity.lastWin === lastWin,
          profile: frame.dataset.surfaceProfile ?? null,
          safeAreaRect: {
            bottom: safeAreaRect.bottom,
            height: safeAreaRect.height,
            left: safeAreaRect.left,
            right: safeAreaRect.right,
            top: safeAreaRect.top,
            width: safeAreaRect.width,
          },
          state: {
            balance: balance?.textContent ?? null,
            bet: bet?.textContent ?? null,
            lastWin: lastWin?.textContent ?? null,
            launchPhase: overlay?.dataset.launch ?? null,
            reelState: frame.dataset.reelState ?? null,
            roundId: frame.dataset.reelRoundId ?? null,
            rgsSession: root.dataset.rgsSession ?? null,
            spinAction: spin?.dataset.action ?? null,
            spinDisabled: !(spin instanceof HTMLButtonElement) || spin.disabled,
            spinMode: spin?.dataset.mode ?? null,
          },
          transformOrigin: frameStyle.transformOrigin,
          viewportHeight: innerHeight,
          viewportWidth: innerWidth,
        };
      })()
    `,
  });
}

function assertViewportGeometry(snapshot, viewport, surface, channel) {
  const expectedScale = Math.min(
    viewport.width / surface.designWidth,
    viewport.height / surface.designHeight,
  );
  const expectedWidth = surface.designWidth * expectedScale;
  const expectedHeight = surface.designHeight * expectedScale;
  const expectedX = (viewport.width - expectedWidth) / 2;
  const expectedY = (viewport.height - expectedHeight) / 2;
  const detail = () => JSON.stringify({ viewport, surface, snapshot });
  if (snapshot.frameCount !== 1 || !snapshot.nodeIdentityPreserved
    || snapshot.channel !== channel || snapshot.profile !== surface.profile
    || snapshot.designWidth !== surface.designWidth
    || snapshot.designHeight !== surface.designHeight) {
    throw new Error(`生产布局没有唯一且冻结通道的设计框架：${detail()}`);
  }
  requireNear(snapshot.datasetScale, expectedScale, 0.000_001, "数据 scale", detail);
  requireNear(snapshot.datasetX, expectedX, 0.000_001, "数据 x", detail);
  requireNear(snapshot.datasetY, expectedY, 0.000_001, "数据 y", detail);
  requireNear(snapshot.frameRect.width, expectedWidth, 0.75, "框架宽度", detail);
  requireNear(snapshot.frameRect.height, expectedHeight, 0.75, "框架高度", detail);
  requireNear(snapshot.frameRect.left, expectedX, 0.75, "左黑边", detail);
  requireNear(snapshot.frameRect.top, expectedY, 0.75, "上黑边", detail);
  requireNear(viewport.width - snapshot.frameRect.right, expectedX, 0.75, "右黑边", detail);
  requireNear(viewport.height - snapshot.frameRect.bottom, expectedY, 0.75, "下黑边", detail);
  requireNear(snapshot.safeAreaRect.left, 0, 0.25, "安全区左边", detail);
  requireNear(snapshot.safeAreaRect.top, 0, 0.25, "安全区上边", detail);
  requireNear(snapshot.safeAreaRect.width, viewport.width, 0.25, "安全区宽度", detail);
  requireNear(snapshot.safeAreaRect.height, viewport.height, 0.25, "安全区高度", detail);
  if (snapshot.frameRect.left < -0.75 || snapshot.frameRect.top < -0.75
    || snapshot.frameRect.right > viewport.width + 0.75
    || snapshot.frameRect.bottom > viewport.height + 0.75) {
    throw new Error(`生产布局发生视口裁切：${detail()}`);
  }
  const matrix = snapshot.matrix;
  if (!matrix || matrix.is2D !== true) {
    throw new Error(`生产布局没有唯一二维缩放矩阵：${detail()}`);
  }
  requireNear(matrix.a, expectedScale, 0.000_001, "矩阵 scaleX", detail);
  requireNear(matrix.d, expectedScale, 0.000_001, "矩阵 scaleY", detail);
  requireNear(matrix.b, 0, 0.000_001, "矩阵 skewY", detail);
  requireNear(matrix.c, 0, 0.000_001, "矩阵 skewX", detail);
  requireNear(matrix.e, 0, 0.000_001, "矩阵 translateX", detail);
  requireNear(matrix.f, 0, 0.000_001, "矩阵 translateY", detail);
  if (!snapshot.transformOrigin.startsWith("0px 0px")) {
    throw new Error(`生产布局缩放原点不是左上角：${detail()}`);
  }
  for (const [name, color] of Object.entries(snapshot.backgroundColors ?? {})) {
    if (color !== "rgb(0, 0, 0)" && color !== "rgba(0, 0, 0, 1)") {
      throw new Error(`生产布局 ${name} 黑边背景不是纯黑：${detail()}`);
    }
  }
  if (Object.keys(snapshot.backgroundColors ?? {}).length !== 5) {
    throw new Error(`生产布局黑边背景证据不完整：${detail()}`);
  }
}

function assertViewportStatePreserved(expected, actual, viewport, channel) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`连续视口切换重置了状态、余额或 roundId：${JSON.stringify({
      channel,
      viewport,
      expected,
      actual,
    })}`);
  }
}

function blackBorderPoint(snapshot) {
  const margin = 1;
  const rectangle = snapshot.frameRect;
  if (rectangle.left > margin) {
    return Object.freeze({ x: rectangle.left / 2, y: snapshot.viewportHeight / 2 });
  }
  if (snapshot.viewportWidth - rectangle.right > margin) {
    return Object.freeze({
      x: (rectangle.right + snapshot.viewportWidth) / 2,
      y: snapshot.viewportHeight / 2,
    });
  }
  if (rectangle.top > margin) {
    return Object.freeze({ x: snapshot.viewportWidth / 2, y: rectangle.top / 2 });
  }
  if (snapshot.viewportHeight - rectangle.bottom > margin) {
    return Object.freeze({
      x: snapshot.viewportWidth / 2,
      y: (rectangle.bottom + snapshot.viewportHeight) / 2,
    });
  }
  return null;
}

async function dispatchMouseClick(send, point) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

function requireNear(actual, expected, tolerance, label, detail) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`生产布局 ${label} 不符合等比居中契约：${detail()}`);
  }
}

function rounded(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function validateContinuousViewportEvidence(viewportEvidence) {
  const desktop = viewportEvidence?.desktop;
  const mobile = viewportEvidence?.mobile;
  if (!desktop || !mobile
    || desktop.channel !== "desktop" || mobile.channel !== "mobile"
    || desktop.steps?.length !== CONTINUOUS_VIEWPORTS.length
    || mobile.steps?.length !== CONTINUOUS_VIEWPORTS.length
    || desktop.blackBorderClickCount !== 6
    || mobile.blackBorderClickCount !== 2) {
    throw new Error(`生产浏览器连续视口证据不完整：${JSON.stringify(viewportEvidence)}`);
  }
  for (let index = 0; index < CONTINUOUS_VIEWPORTS.length; index += 1) {
    const expected = CONTINUOUS_VIEWPORTS[index];
    for (const evidence of [desktop, mobile]) {
      const step = evidence.steps[index];
      if (step.width !== expected.width || step.height !== expected.height
        || !step.nodeIdentityPreserved || !step.statePreserved) {
        throw new Error(`生产浏览器连续视口顺序或状态证据失真：${JSON.stringify({
          expected,
          step,
        })}`);
      }
    }
  }
  const observedProfiles = [...new Set([
    ...desktop.steps.map((step) => step.profile),
    ...mobile.steps.map((step) => step.profile),
  ])].sort();
  const expectedProfiles = ["desktop", "phone-ls", "phone-pt", "tablet-ls", "tablet-pt"];
  if (JSON.stringify(observedProfiles) !== JSON.stringify(expectedProfiles)) {
    throw new Error(`生产浏览器没有覆盖五个设计表面：${JSON.stringify(observedProfiles)}`);
  }
}

function documentUrlWithoutHash(url) {
  const documentUrl = new URL(url);
  documentUrl.hash = "";
  return documentUrl;
}

function completeBrowserResult(bootstrap, browserState, transactionEvidence, visualEvidence = null) {
  const observed = browserState.transaction ?? {};
  return {
    ...bootstrap,
    status: browserState.status,
    cspViolations: browserState.cspViolations,
    operatorSessionRequests: browserState.operatorSessionRequests,
    playerErrors: browserState.playerErrors,
    runtimeErrors: browserState.runtimeErrors,
    unhandledRejections: browserState.unhandledRejections,
    deliveryStages: observed.deliveryStages ?? [],
    reelStates: observed.reelStates ?? [],
    spinModes: observed.spinModes ?? [],
    balanceValues: observed.balanceValues ?? [],
    transactionEvidence,
    visualEvidence,
    diagnostics: browserState.diagnostics,
    finalState: browserState.finalState,
  };
}

async function evaluateValue(send, options) {
  const evaluation = await send("Runtime.evaluate", options);
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description
      ?? evaluation.exceptionDetails.text
      ?? "浏览器求值失败");
  }
  return evaluation.result.value;
}

async function readBrowserState(send) {
  return evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const probe = globalThis.__slotsProductionTransactionProbe;
        const cspSnapshot = globalThis.__slotsContentSecurityPolicyProbe?.violations;
        const root = document.querySelector('#app');
        const frame = root?.querySelector('[data-role="frame"]');
        const overlay = root?.querySelector('[data-role="overlay"]');
        const spin = root?.querySelector('[data-role="spin"]');
        const balance = root?.querySelector('[data-role="balance"]');
        const lastWin = root?.querySelector('[data-role="last-win"]');
        const operatorSessionRequests = Array.isArray(probe?.operatorSessionRequests)
          ? probe.operatorSessionRequests.slice(0, 16)
          : [{ code: "probe-missing", reason: "probe-missing" }];
        const playerErrors = Array.isArray(probe?.playerErrors)
          ? probe.playerErrors.slice(0, 16)
          : ["probe-missing"];
        const runtimeErrors = Array.isArray(probe?.runtimeErrors)
          ? probe.runtimeErrors.slice(0, 16)
          : ["probe-missing"];
        const unhandledRejections = Array.isArray(probe?.unhandledRejections)
          ? probe.unhandledRejections.slice(0, 16)
          : ["probe-missing"];
        const transaction = probe?.transaction;
        const cspViolations = Array.isArray(cspSnapshot)
          ? cspSnapshot.slice(0, 16).map((violation) => ({
              effectiveDirective: String(violation?.effectiveDirective ?? '').slice(0, 64),
              violatedDirective: String(violation?.violatedDirective ?? '').slice(0, 64),
              disposition: String(violation?.disposition ?? '').slice(0, 32),
              blockedTarget: String(violation?.blockedTarget ?? '').slice(0, 256),
            }))
          : [{ effectiveDirective: "probe-missing", disposition: "enforce" }];
        const finalState = {
          balance: balance?.textContent ?? null,
          lastWin: lastWin?.textContent ?? null,
          reelState: frame?.dataset.reelState ?? null,
          hasReelRoundId: Boolean(frame?.dataset.reelRoundId),
          spinMode: spin?.dataset.mode ?? null,
          spinAction: spin?.dataset.action ?? null,
          spinDisabled: !(spin instanceof HTMLButtonElement) || spin.disabled,
          launchPhase: overlay?.dataset.launch ?? null,
        };
        const diagnostics = {
          hasRgsSession: root?.dataset.rgsSession === 'online',
          rgsDeliveryStage: root?.dataset.rgsDeliveryStage ?? null,
          startupAssemblyStage: root?.dataset.startupAssemblyStage ?? null,
          startupReadinessStage: root?.dataset.startupReadinessStage ?? null,
          startupReadiness: root?.dataset.startupReadiness ?? null,
          loadingStage: root?.querySelector('[data-role="launch-loading"]')?.dataset.stage ?? null,
        };
        return {
          ready: finalState.launchPhase === 'ready'
            && finalState.reelState === 'Idle'
            && finalState.spinMode === 'ready'
            && finalState.spinAction === 'spin'
            && finalState.spinDisabled === false,
          explicitFailure: root?.dataset.startupAssemblyStage === 'assembly-failed'
            || finalState.launchPhase === 'failed'
            || operatorSessionRequests.length > 0
            || playerErrors.length > 0
            || runtimeErrors.length > 0
            || unhandledRejections.length > 0
            || cspViolations.length > 0,
          status: document.querySelector('.launch-loading__status')?.textContent ?? null,
          cspViolations,
          operatorSessionRequests,
          playerErrors,
          runtimeErrors,
          unhandledRejections,
          transaction: transaction ? {
            balanceValues: transaction.balanceValues.slice(0, 32),
            deliveryStages: transaction.deliveryStages.slice(0, 64),
            reelStates: transaction.reelStates.slice(0, 32),
            spinModes: transaction.spinModes.slice(0, 32),
          } : null,
          diagnostics,
          finalState,
        };
      })()
    `,
  });
}

async function waitForApplicationReady(send, transportFailure) {
  const deadline = Date.now() + startupTimeoutMs;
  let state;
  while (Date.now() < deadline) {
    const transportError = transportFailure();
    if (transportError) throw transportError;
    state = await readBrowserState(send);
    if (state.ready || state.explicitFailure) return state;
    await delay(50);
  }
  throw new Error(`生产应用没有进入可下注状态：${JSON.stringify({
    finalState: state?.finalState ?? null,
    diagnostics: state?.diagnostics ?? null,
    status: state?.status ?? null,
    runtimeErrors: state?.runtimeErrors ?? [],
    unhandledRejections: state?.unhandledRejections ?? [],
    playerErrors: state?.playerErrors ?? [],
    operatorSessionRequests: state?.operatorSessionRequests ?? [],
    cspViolations: state?.cspViolations ?? [],
  })}`);
}

async function armTransactionObservation(send) {
  const armed = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const probe = globalThis.__slotsProductionTransactionProbe;
        if (!probe || probe.transaction) return false;
        const transaction = {
          balanceValues: [],
          deliveryStages: [],
          reelStates: [],
          spinModes: [],
        };
        const append = (values, value) => {
          if (typeof value !== 'string' || value === '') return;
          if (values.at(-1) !== value) values.push(value);
        };
        const capture = () => {
          const root = document.querySelector('#app');
          const frame = root?.querySelector('[data-role="frame"]');
          const spin = root?.querySelector('[data-role="spin"]');
          append(transaction.balanceValues, root?.querySelector('[data-role="balance"]')?.textContent);
          append(transaction.deliveryStages, root?.dataset.rgsDeliveryStage);
          append(transaction.reelStates, frame?.dataset.reelState);
          append(transaction.spinModes, spin?.dataset.mode);
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type !== 'attributes') continue;
            if (record.attributeName === 'data-rgs-delivery-stage') {
              append(transaction.deliveryStages, record.oldValue);
            }
            if (record.attributeName === 'data-reel-state') {
              append(transaction.reelStates, record.oldValue);
            }
            if (record.attributeName === 'data-mode') {
              append(transaction.spinModes, record.oldValue);
            }
          }
          capture();
        });
        observer.observe(document.documentElement, {
          attributeOldValue: true,
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        probe.transaction = transaction;
        capture();
        return true;
      })()
    `,
  });
  if (armed !== true) throw new Error("生产浏览器事务观察器未能唯一装配");
}

async function clickPrimarySpin(send) {
  const target = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const spin = document.querySelector('[data-role="spin"]');
        if (!(spin instanceof HTMLButtonElement) || spin.disabled
          || spin.dataset.mode !== 'ready' || spin.dataset.action !== 'spin') return null;
        spin.scrollIntoView({ block: 'center', inline: 'center' });
        const rectangle = spin.getBoundingClientRect();
        return {
          x: rectangle.left + rectangle.width / 2,
          y: rectangle.top + rectangle.height / 2,
        };
      })()
    `,
  });
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error("生产浏览器主旋转控件不可点击");
  }
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
}

async function captureGameCanvas(send) {
  const clip = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const canvas = document.querySelector('[data-role="canvas"] canvas');
        if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) {
          return null;
        }
        const rectangle = canvas.getBoundingClientRect();
        if (rectangle.width <= 0 || rectangle.height <= 0) return null;
        return {
          x: Math.max(0, rectangle.left),
          y: Math.max(0, rectangle.top),
          width: Math.min(innerWidth, rectangle.right) - Math.max(0, rectangle.left),
          height: Math.min(innerHeight, rectangle.bottom) - Math.max(0, rectangle.top),
          scale: 1,
        };
      })()
    `,
  });
  if (!clip || clip.width <= 0 || clip.height <= 0) {
    throw new Error("生产 WebGL 画布没有可截图的视口区域");
  }
  const screenshot = await send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    clip,
    format: "png",
    fromSurface: true,
  });
  if (typeof screenshot.data !== "string") throw new Error("Chrome 没有返回画布截图");
  const bytes = Buffer.from(screenshot.data, "base64");
  return Object.freeze({
    bytes: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function waitForActivePresentation(send, fixture, transportFailure) {
  const deadline = Date.now() + startupTimeoutMs;
  let state;
  while (Date.now() < deadline) {
    const transportError = transportFailure();
    if (transportError) throw transportError;
    state = await readBrowserState(send);
    if (state.explicitFailure) return state;
    if (fixture.snapshot().spinCount === 1
      && state.finalState.reelState !== null
      && state.finalState.reelState !== "Idle") return state;
    await delay(20);
  }
  throw new Error(`生产浏览器没有进入真实转轴表现：${JSON.stringify(state?.finalState ?? null)}`);
}

async function waitForTransactionCompletion(send, fixture, transportFailure) {
  const deadline = Date.now() + transactionTimeoutMs;
  let state;
  while (Date.now() < deadline) {
    const transportError = transportFailure();
    if (transportError) throw transportError;
    state = await readBrowserState(send);
    const evidence = fixture.snapshot();
    if (state.explicitFailure) return state;
    if (evidence.acknowledgementCount === 1
      && state.ready
      && state.finalState.balance === expectedFinalBalance
      && !state.finalState.hasReelRoundId) return state;
    await delay(50);
  }
  throw new Error(
    `生产浏览器事务超时：${JSON.stringify({
      finalState: state?.finalState ?? null,
      transactionEvidence: fixture.snapshot(),
    })}`,
  );
}

async function waitForDocumentReady(send) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const evaluation = await send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (evaluation.result.value === "complete") return;
    await delay(50);
  }
  throw new Error("生产页面加载超时");
}

async function stopChrome(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGTERM");
  if (await waitForProcessExit(browser, 2_000)) return;
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGKILL");
  if (!await waitForProcessExit(browser, 2_000)) {
    throw new Error("浏览器进程在强制终止后仍未退出");
  }
}

function waitForProcessExit(browser, timeoutMs) {
  if (browser.exitCode !== null || browser.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const handleExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      browser.off("exit", handleExit);
      resolvePromise(false);
    }, timeoutMs);
    browser.once("exit", handleExit);
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function formatMinor(value, exponent) {
  const digits = BigInt(value).toString().padStart(exponent + 1, "0");
  if (exponent === 0) return digits;
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
