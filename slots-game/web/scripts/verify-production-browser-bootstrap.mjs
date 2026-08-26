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
import {
  assertSessionStatusCadence,
  createControlledRgsTransactionFixture,
  economicTransactionStateEqual,
} from "./production-browser-transaction-fixture.mjs";
import {
  BROWSER_RUNTIME_PHASES,
  BROWSER_TRANSACTION_PROBE_SOURCE,
} from "./production-browser-runtime-probe.mjs";
import { validateReleaseRgsBuildEnvironment } from "../src/validateReleaseRgsBuildConfig.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = distributionRootFromArguments(process.argv.slice(2));
const bootstrapFailureText = "The game could not start. Please try again.";
// 该时限覆盖隔离 Chrome 的首次资产解析、WebGL 装配和 200ms 减少动态介绍；
// 它不是线上启动性能预算。冷缓存机器仍必须在 30 秒内完成，否则门禁失败。
const startupTimeoutMs = 30_000;
const transactionTimeoutMs = 25_000;
const commandTimeoutMs = Math.max(startupTimeoutMs, transactionTimeoutMs) + 5_000;
// 文档创建前只观察 policy 名称是否匹配以及创建次数。探针不保存 createPolicy 的
// 返回值，也不把 factory、policy 或铸造函数发布到全局对象。
const TRUSTED_TYPES_POLICY_OBSERVATION_PROBE_SOURCE = `(() => {
  let staticHtmlPolicyCreateCount = 0;
  let unexpectedPolicyCreateCount = 0;
  const trustedTypesFactory = globalThis.trustedTypes;
  const nativeCreatePolicy = trustedTypesFactory?.createPolicy;
  const enforcementSupported = typeof nativeCreatePolicy === 'function';
  let observerInstalled = false;
  if (enforcementSupported) {
    try {
      Object.defineProperty(trustedTypesFactory, 'createPolicy', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function observedCreatePolicy(name) {
          if (name === 'slots-game-static-html') {
            staticHtmlPolicyCreateCount += 1;
          } else {
            unexpectedPolicyCreateCount += 1;
          }
          return Reflect.apply(nativeCreatePolicy, trustedTypesFactory, arguments);
        },
      });
      observerInstalled = trustedTypesFactory.createPolicy !== nativeCreatePolicy;
    } catch {
      observerInstalled = false;
    }
  }
  const observation = {};
  Object.defineProperties(observation, {
    enforcementSupported: { enumerable: true, value: enforcementSupported },
    observerInstalled: { enumerable: true, value: observerInstalled },
    staticHtmlPolicyNameObserved: {
      enumerable: true,
      get: () => staticHtmlPolicyCreateCount > 0,
    },
    staticHtmlPolicyCreateCount: {
      enumerable: true,
      get: () => staticHtmlPolicyCreateCount,
    },
    unexpectedPolicyCreateCount: {
      enumerable: true,
      get: () => unexpectedPolicyCreateCount,
    },
  });
  Object.freeze(observation);
  Object.defineProperty(globalThis, '__slotsTrustedTypesPolicyObservation', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: observation,
  });
})();`;
const IMAGE_DECODE_OBSERVATION_PROBE_SOURCE = `(() => {
  const nativeDecode = HTMLImageElement.prototype.decode;
  if (typeof nativeDecode !== 'function') return;
  let calls = 0;
  let fulfilled = 0;
  let pending = 0;
  let rejected = 0;
  const failures = [];
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function observedDecode() {
      calls += 1;
      pending += 1;
      let result;
      try {
        result = Reflect.apply(nativeDecode, this, arguments);
      } catch (error) {
        pending -= 1;
        rejected += 1;
        failures.push({
          name: error?.name ?? 'Error',
          source: String(this.currentSrc || this.src || '').slice(0, 192),
        });
        throw error;
      }
      Promise.resolve(result).then(
        () => {
          pending -= 1;
          fulfilled += 1;
        },
        (error) => {
          pending -= 1;
          rejected += 1;
          failures.push({
            name: error?.name ?? 'Error',
            source: String(this.currentSrc || this.src || '').slice(0, 192),
          });
        },
      );
      return result;
    },
  });
  const observation = {};
  Object.defineProperties(observation, {
    calls: { enumerable: true, get: () => calls },
    fulfilled: { enumerable: true, get: () => fulfilled },
    pending: { enumerable: true, get: () => pending },
    rejected: { enumerable: true, get: () => rejected },
    failures: { enumerable: true, get: () => failures.slice(-16) },
  });
  Object.freeze(observation);
  Object.defineProperty(globalThis, '__slotsImageDecodeObservation', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: observation,
  });
})();`;
// 真实设备尺寸不是白名单。前十三项覆盖主流手机/平板纵横态，末两项专门证明
// 超出 9:22/22:9 的病态视口只会产生等比黑边，不会拉伸设计域。
const CONTINUOUS_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 360, height: 640 }),
  Object.freeze({ width: 375, height: 812 }),
  Object.freeze({ width: 390, height: 844 }),
  Object.freeze({ width: 393, height: 852 }),
  Object.freeze({ width: 412, height: 915 }),
  Object.freeze({ width: 600, height: 960 }),
  Object.freeze({ width: 633, height: 844 }),
  Object.freeze({ width: 768, height: 1_024 }),
  Object.freeze({ width: 800, height: 1_280 }),
  Object.freeze({ width: 844, height: 390 }),
  Object.freeze({ width: 1_024, height: 600 }),
  Object.freeze({ width: 1_024, height: 768 }),
  Object.freeze({ width: 1_366, height: 1_024 }),
  Object.freeze({ width: 320, height: 1_000 }),
  Object.freeze({ width: 1_200, height: 300 }),
]);
const DESKTOP_TRANSITION_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1_024, height: 768 }),
  Object.freeze({ width: 1_366, height: 1_024 }),
  Object.freeze({ width: 1_440, height: 900 }),
  // 事务截图最终回到原始桌面设计面，避免响应式门禁改变表现截图的基准。
  Object.freeze({ width: 1_280, height: 720 }),
]);
const OFFICIAL_HELP_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 360, height: 640 }),
  Object.freeze({ width: 768, height: 1_024 }),
  Object.freeze({ width: 844, height: 390 }),
]);
const DESKTOP_VIEWPORT_SURFACE = Object.freeze({
  profile: "desktop",
  designWidth: 1_280,
  designHeight: 720,
});
const DESKTOP_AUTHORED_WIDTH = 1_200;
const DESKTOP_AUTHORED_HEIGHT = 900;
const MOBILE_DESIGN_LONG_EDGE = 844;
const MOBILE_MIN_DESIGN_ASPECT = 9 / 22;
const MOBILE_MAX_DESIGN_ASPECT = 22 / 9;
const TABLET_SHORT_EDGE_MIN = 600;
// currencyExponent=2 下 int64 最大 minor value 的真实玩家显示值。
const MAXIMUM_STATUS_VALUE = "92233720368547758.07";
const PRESENTATION_APPROVED_BINDING = Object.freeze({
  gameId: "iron-colossus",
  definitionVersion: "local-production-2026-08-26.3",
  definitionHash: "9e9b9b5f23f0f2cfed0a4a5ff5961dbc76a91ba9e614f3cfadb47824a46d2205",
});
const TRANSACTION_FIXTURE_BINDING = Object.freeze({
  gameId: "primal-rampage",
  definitionVersion: "browser-gate-v1",
  definitionHash: "a".repeat(64),
});
validateReleaseRgsBuildEnvironment(process.env);
const browserRgsBaseUrl = process.env.VITE_RGS_BASE_URL;
const browserHostOrigin = process.env.VITE_RGS_HOST_ORIGIN;
const browserBetMinor = process.env.VITE_RGS_DEFAULT_BET_MINOR;
const initialBalanceMinor = (BigInt(browserBetMinor) + 800n).toString();
const finalBalanceMinor = "850";
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
let verifiedEvidence;

try {
  const address = await listenOnLoopback(server);
  const launchCode = `lc_${"b".repeat(43)}`;
  const operatorId = "browser-smoke";
  const sessionId = "browser-smoke";
  const pageOrigin = `http://127.0.0.1:${address.port}`;
  const pageUrl = `${pageOrigin}/?channel=desktop&featurePreview=force#${new URLSearchParams({
    rgsLaunchCode: launchCode,
    rgsOperatorId: operatorId,
    rgsSessionId: sessionId,
  })}`;
  const transactionFixture = createPresentationApprovedFixture(
    createControlledRgsTransactionFixture({
    baseUrl: browserRgsBaseUrl,
    pageOrigin: new URL(pageUrl).origin,
    launchCode,
    operatorId,
    sessionId,
    initialBalanceMinor,
    betMinor: browserBetMinor,
    finalBalanceMinor,
    }),
  );
  const debuggingPort = await chrome.debuggingPort;
  const target = await waitForPageTarget(debuggingPort);
  pageSocket = await connectDevTools(target.webSocketDebuggerUrl);
  const result = await verifyBootstrap(
    pageSocket,
    pageUrl,
    modulePaths,
    transactionFixture,
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
  if (result.trustedTypesEvidence?.enforcementSupported !== true
    || result.trustedTypesEvidence?.observerInstalled !== true
    || result.trustedTypesEvidence?.staticHtmlPolicyNameObserved !== true
    || result.trustedTypesEvidence?.staticHtmlPolicyCreateCount !== 1
    || result.trustedTypesEvidence?.unexpectedPolicyCreateCount !== 0
    || result.trustedTypesEvidence?.policyObservationCapabilityFree !== true
    || result.trustedTypesEvidence?.policyObservationGlobalLocked !== true) {
    throw new Error(
      `生产入口没有在强制 Trusted Types 下精确创建唯一模块私有静态 HTML policy：${JSON.stringify(result.trustedTypesEvidence)}`,
    );
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
  if (result.runtimeDiagnostics.fatalCount > 0) {
    throw new Error(
      `生产浏览器事务发生未处理的运行时异常：${JSON.stringify(result.runtimeDiagnostics)}`,
    );
  }
  const transactionEvidence = result.transactionEvidence;
  assertSessionStatusCadence(transactionEvidence);
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
  if (finalState.balance !== "8.50" || finalState.balance !== expectedFinalBalance
    || finalState.lastWin !== "0.50"
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
  const layoutTransitionEvidence = result.layoutTransitionEvidence;
  if (!layoutTransitionEvidence?.mobileToDesktopWithoutReload
    || !layoutTransitionEvidence?.nodeIdentityPreserved
    || !layoutTransitionEvidence?.statePreserved
    || !layoutTransitionEvidence?.transactionStatePreserved) {
    throw new Error(`同文档布局通道迁移证据不完整：${JSON.stringify(layoutTransitionEvidence)}`);
  }
  verifiedEntryPath = basename(result.entryPath);
  verifiedEvidence = Object.freeze({
    cspViolationCount: result.cspViolations.length,
    deliveryStages: ["decode-complete", "controller-dispatch", "callback", "accepted"],
    rendererReady: result.rendererReady,
    transaction: Object.freeze({
      acknowledgementCount: transactionEvidence.acknowledgementCount,
      exchangeCount: transactionEvidence.exchangeCount,
      order: transactionEvidence.order,
      spinCount: transactionEvidence.spinCount,
    }),
    trustedTypes: Object.freeze({
      nameObserved: result.trustedTypesEvidence.staticHtmlPolicyNameObserved,
      policyCreateCount: result.trustedTypesEvidence.staticHtmlPolicyCreateCount,
      unexpectedPolicyCreateCount: result.trustedTypesEvidence.unexpectedPolicyCreateCount,
    }),
    webgl: result.rendererEvidence?.webgl === true,
  });
} finally {
  await cleanupBrowserResources({
    browser: chrome.process,
    pageSocket,
    profileDirectory,
    server,
  });
}

process.stdout.write(
  `生产浏览器事务门禁通过：${verifiedEntryPath} 已在精确 CSP 下完成同文档桌面资产会话的连续移动/桌面布局迁移、等比黑边与控件排版门禁，以及会话交换、旋转、结果解码与表现、余额更新及结果 ACK。\n证据：${JSON.stringify(verifiedEvidence)}\n`,
);

/**
 * 浏览器门禁使用一份经批准的真实帮助绑定，同时保留受控事务夹具对其内部
 * browser-gate 绑定的严格断言。双向翻译只发生在隔离 CDP 传输边界；玩家页
 * 看到的 exchange/spin 始终是同一份批准绑定，完整 Spin/ACK 顺序仍由原夹具核验。
 */
function createPresentationApprovedFixture(fixture) {
  const translateRequest = (parameters) => {
    const request = parameters?.request;
    if (!request || typeof request.postData !== "string") return parameters;
    let payload;
    try {
      payload = JSON.parse(request.postData);
    } catch {
      return parameters;
    }
    if (!rewriteExactBinding(
      payload,
      PRESENTATION_APPROVED_BINDING,
      TRANSACTION_FIXTURE_BINDING,
    )) return parameters;
    return {
      ...parameters,
      request: {
        ...request,
        postData: JSON.stringify(payload),
      },
    };
  };

  const translateResponse = (response) => {
    if (typeof response.body !== "string") return response;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      return response;
    }
    const translated = rewriteExactBinding(
      payload?.data?.session,
      TRANSACTION_FIXTURE_BINDING,
      PRESENTATION_APPROVED_BINDING,
    ) || rewriteExactBinding(
      payload?.data,
      TRANSACTION_FIXTURE_BINDING,
      PRESENTATION_APPROVED_BINDING,
    );
    return translated
      ? Object.freeze({ ...response, body: JSON.stringify(payload) })
      : response;
  };

  return Object.freeze({
    interceptedOriginPattern: fixture.interceptedOriginPattern,
    responseForPausedRequest: (parameters) => translateResponse(
      fixture.responseForPausedRequest(translateRequest(parameters)),
    ),
    snapshot: () => fixture.snapshot(),
  });
}

function rewriteExactBinding(target, from, to) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) return false;
  if (!Object.entries(from).every(([name, value]) => target[name] === value)) return false;
  for (const [name, value] of Object.entries(to)) target[name] = value;
  return true;
}

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
  // RGS 在后台/隐藏页面上按设计停放一次性 launch code。浏览器验收模拟玩家
  // 实际打开的活动游戏页，必须先将目标前置，否则只会测到正确的后台保护分支。
  await send("Page.bringToFront");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: TRUSTED_TYPES_POLICY_OBSERVATION_PROBE_SOURCE,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: BROWSER_TRANSACTION_PROBE_SOURCE,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: IMAGE_DECODE_OBSERVATION_PROBE_SOURCE,
  });
  await send("Page.navigate", { url: pageUrl });
  await waitForDocumentReady(send);
  await setBrowserProbePhase(send, "bootstrap");
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
            sourceFile: typeof violation?.sourceFile === 'string'
              ? violation.sourceFile.slice(0, 128)
              : undefined,
            lineNumber: Number.isSafeInteger(violation?.lineNumber)
              ? violation.lineNumber
              : undefined,
            columnNumber: Number.isSafeInteger(violation?.columnNumber)
              ? violation.columnNumber
              : undefined,
            trustedTypesSink: typeof violation?.trustedTypesSink === 'string'
              ? violation.trustedTypesSink.slice(0, 64)
              : undefined,
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
        const policyObservationDescriptor = Object.getOwnPropertyDescriptor(
          globalThis,
          '__slotsTrustedTypesPolicyObservation',
        );
        const policyObservation = policyObservationDescriptor?.value;
        const policyObservationIsObject = policyObservation !== null
          && typeof policyObservation === 'object';
        const policyObservationOwnKeys = policyObservationIsObject
          ? Reflect.ownKeys(policyObservation)
          : [];
        const expectedPolicyObservationKeys = [
          'enforcementSupported',
          'observerInstalled',
          'staticHtmlPolicyNameObserved',
          'staticHtmlPolicyCreateCount',
          'unexpectedPolicyCreateCount',
        ];
        const policyObservationCapabilityFree = policyObservationIsObject
          && Object.isFrozen(policyObservation)
          && policyObservationOwnKeys.length === expectedPolicyObservationKeys.length
          && expectedPolicyObservationKeys.every((key) => policyObservationOwnKeys.includes(key))
          && !Reflect.has(policyObservation, 'policy')
          && !Reflect.has(policyObservation, 'factory')
          && !Reflect.has(policyObservation, 'createPolicy')
          && !Reflect.has(policyObservation, 'createHTML');
        return {
          entryPath: new URL(entry.src).pathname,
          moduleFailures,
          rendererEvidence,
          rendererReady,
          trustedTypesEvidence: {
            enforcementSupported: policyObservation?.enforcementSupported === true,
            observerInstalled: policyObservation?.observerInstalled === true,
            staticHtmlPolicyNameObserved: policyObservation?.staticHtmlPolicyNameObserved === true,
            staticHtmlPolicyCreateCount: Number.isSafeInteger(policyObservation?.staticHtmlPolicyCreateCount)
              ? policyObservation.staticHtmlPolicyCreateCount
              : -1,
            unexpectedPolicyCreateCount: Number.isSafeInteger(policyObservation?.unexpectedPolicyCreateCount)
              ? policyObservation.unexpectedPolicyCreateCount
              : -1,
            policyObservationCapabilityFree,
            policyObservationGlobalLocked: policyObservationDescriptor?.enumerable === false
              && policyObservationDescriptor?.writable === false
              && policyObservationDescriptor?.configurable === false,
          },
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          status: document.querySelector('.launch-loading__status')?.textContent ?? null,
          cspViolations: readCspViolations(),
        };
      })()
    `,
  });
  await setBrowserProbePhase(send, "opening-overlay");
  const openingOverlayEvidence = bootstrap.rendererReady && bootstrap.moduleFailures.length === 0
    ? await verifyOpeningOverlayLayout(send, transactionFixture, () => transportFailure)
    : null;
  await setBrowserProbePhase(send, "ready");
  let browserState = await waitForApplicationReady(send, () => transportFailure);
  if (!browserState.ready) {
    return completeBrowserResult(bootstrap, browserState, transactionFixture.snapshot());
  }
  if (!bootstrap.reducedMotion) {
    throw new Error("生产浏览器事务夹具没有启用系统级减少动态效果配置");
  }

  // 资产会话固定为 desktop；显式 launcher 通道也必须让触屏 PC 保持 PC 构图。
  // 浏览器矩阵只通过更高优先级的 layout= 测试接缝在同一文档切换构图，期间不
  // 导航、不刷新，也不允许预先消费 Spin/ACK 事务。
  const preTransitionLayout = await readViewportLayout(send);
  if (!preTransitionLayout || preTransitionLayout.frameCount !== 1
    || !preTransitionLayout.nodeIdentityPreserved
    || typeof preTransitionLayout.documentIdentityToken !== "string"
    || preTransitionLayout.documentIdentityToken === "") {
    throw new Error(`同文档布局迁移无法建立初始框架身份：${JSON.stringify(preTransitionLayout)}`);
  }
  const preTransitionState = preTransitionLayout.state;
  const preTransitionTransaction = transactionFixture.snapshot();
  const preTransitionDocumentIdentity = preTransitionLayout.documentIdentityToken;

  await setBrowserProbePhase(send, "mobile-matrix");
  await setLayoutChannelOverride(send, "mobile");
  await setTouchLayoutCapability(send, true);
  const mobileViewportEvidence = await verifyContinuousViewportTransitions(
    send,
    transactionFixture,
    {
      channel: "mobile",
      expectedDocumentIdentity: preTransitionDocumentIdentity,
      expectedState: preTransitionState,
      expectedTransaction: preTransitionTransaction,
      surfaceForViewport: (viewport) => responsiveSurfaceForViewport(viewport, "mobile"),
      transportFailure: () => transportFailure,
      viewports: CONTINUOUS_VIEWPORTS,
    },
  );
  await setBrowserProbePhase(send, "help-matrix");
  const helpViewportEvidence = await verifyOfficialHelpLayout(
    send,
    transactionFixture,
    {
      expectedDocumentIdentity: preTransitionDocumentIdentity,
      expectedState: preTransitionState,
      expectedTransaction: preTransitionTransaction,
      transportFailure: () => transportFailure,
    },
  );

  await setBrowserProbePhase(send, "desktop-matrix");
  await setLayoutChannelOverride(send, "desktop");
  await setTouchLayoutCapability(send, false);
  const desktopViewportEvidence = await verifyContinuousViewportTransitions(
    send,
    transactionFixture,
    {
      channel: "desktop",
      expectedDocumentIdentity: preTransitionDocumentIdentity,
      expectedState: preTransitionState,
      expectedTransaction: preTransitionTransaction,
      surfaceForViewport: (viewport) => responsiveSurfaceForViewport(viewport, "desktop"),
      transportFailure: () => transportFailure,
      viewports: DESKTOP_TRANSITION_VIEWPORTS,
    },
  );
  const postTransitionLayout = await readViewportLayout(send);
  const postTransitionTransaction = transactionFixture.snapshot();
  assertViewportStatePreserved(
    preTransitionState,
    postTransitionLayout.state,
    DESKTOP_TRANSITION_VIEWPORTS.at(-1),
    "desktop",
  );
  assertTransactionStatePreserved(
    preTransitionTransaction,
    postTransitionTransaction,
    DESKTOP_TRANSITION_VIEWPORTS.at(-1),
    "desktop",
  );
  const layoutTransitionEvidence = Object.freeze({
    mobileToDesktopWithoutReload: mobileViewportEvidence.steps.every(
      (step) => step.channel === "mobile" && step.maxTouchPoints > 0
        && step.documentIdentityPreserved,
    ) && desktopViewportEvidence.steps.every(
      (step) => step.channel === "desktop" && step.maxTouchPoints === 0
        && step.documentIdentityPreserved,
    ),
    nodeIdentityPreserved: mobileViewportEvidence.steps.every(
      (step) => step.nodeIdentityPreserved,
    ) && desktopViewportEvidence.steps.every(
      (step) => step.nodeIdentityPreserved,
    ) && postTransitionLayout.nodeIdentityPreserved
      && postTransitionLayout.documentIdentityToken === preTransitionDocumentIdentity,
    statePreserved: mobileViewportEvidence.steps.every((step) => step.statePreserved)
      && desktopViewportEvidence.steps.every((step) => step.statePreserved),
    transactionStatePreserved: economicTransactionStateEqual(
      preTransitionTransaction,
      postTransitionTransaction,
    ),
  });

  await setBrowserProbePhase(send, "transaction-active");
  await armTransactionObservation(send);
  const baselineCapture = await captureGameCanvas(send);
  await clickPrimarySpin(send);
  const activeState = await waitForActivePresentation(
    send,
    transactionFixture,
    () => transportFailure,
  );
  const activeCapture = await captureGameCanvas(send);
  await setBrowserProbePhase(send, "transaction-settle");
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
  return Object.freeze({
    ...transactionResult,
    layoutTransitionEvidence,
    viewportEvidence: Object.freeze({
      desktop: desktopViewportEvidence,
      help: helpViewportEvidence,
      mobile: mobileViewportEvidence,
      openingOverlay: openingOverlayEvidence,
    }),
  });
}

async function verifyContinuousViewportTransitions(send, fixture, options) {
  const initialSnapshot = await readViewportLayout(send);
  if (!initialSnapshot || initialSnapshot.frameCount !== 1 || !initialSnapshot.nodeIdentityPreserved) {
    throw new Error(`连续视口门禁无法建立唯一游戏框架身份：${JSON.stringify(initialSnapshot)}`);
  }
  const initialState = options.expectedState ?? initialSnapshot.state;
  const initialTransaction = options.expectedTransaction ?? fixture.snapshot();
  const steps = [];
  let blackBorderClickCount = 0;

  for (const viewport of options.viewports) {
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
    if (snapshot.documentIdentityToken !== options.expectedDocumentIdentity) {
      throw new Error(`连续视口切换重新加载了文档：${JSON.stringify({
        channel: options.channel,
        viewport,
        expected: options.expectedDocumentIdentity,
        actual: snapshot.documentIdentityToken,
      })}`);
    }
    assertViewportStatePreserved(initialState, snapshot.state, viewport, options.channel);
    assertTransactionStatePreserved(
      initialTransaction,
      fixture.snapshot(),
      viewport,
      options.channel,
    );
    const controlLayout = options.channel === "mobile" && surface.regularAspect
      ? assertMobileControlLayout(snapshot, viewport)
      : null;
    const desktopStatusLayout = options.channel === "desktop"
      ? assertDesktopStatusLayout(snapshot, viewport)
      : null;
    const maximumStatusLayout = options.channel === "mobile"
      ? await verifyMaximumStatusValues(send, viewport)
      : null;
    const afterMaximumStatus = await readViewportLayout(send);
    assertViewportStatePreserved(
      initialState,
      afterMaximumStatus.state,
      viewport,
      options.channel,
    );
    assertTransactionStatePreserved(
      initialTransaction,
      fixture.snapshot(),
      viewport,
      options.channel,
    );
    if (!afterMaximumStatus.nodeIdentityPreserved
      || afterMaximumStatus.documentIdentityToken !== options.expectedDocumentIdentity) {
      throw new Error(`最大金额排版探针替换了文档或游戏节点：${viewport.width}x${viewport.height}`);
    }

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
      assertTransactionStatePreserved(
        beforeTransaction,
        afterTransaction,
        viewport,
        options.channel,
      );
      assertViewportStatePreserved(initialState, afterClick.state, viewport, options.channel);
      if (!afterClick.nodeIdentityPreserved
        || afterClick.documentIdentityToken !== options.expectedDocumentIdentity) {
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
      frameHeight: snapshot.frameRect.height,
      frameWidth: snapshot.frameRect.width,
      scale: snapshot.datasetScale,
      statusLayout: desktopStatusLayout,
      visibleInsetX: snapshot.visibleInsetX,
      x: snapshot.frameRect.left,
      y: snapshot.frameRect.top,
      coarsePointer: snapshot.coarsePointer,
      maxTouchPoints: snapshot.maxTouchPoints,
      maximumStatusLayout,
      balance: snapshot.state.balance,
      reelState: snapshot.state.reelState,
      roundId: snapshot.state.roundId,
      nodeIdentityPreserved: snapshot.nodeIdentityPreserved,
      documentIdentityPreserved: snapshot.documentIdentityToken
        === options.expectedDocumentIdentity,
      statePreserved: true,
      transactionStatePreserved: true,
      controlLayout,
      regularAspect: surface.regularAspect,
      blackBorderClicked,
    }));
  }

  return Object.freeze({
    blackBorderClickCount,
    channel: options.channel,
    steps: Object.freeze(steps),
  });
}

function responsiveSurfaceForViewport(viewport, channel) {
  if (channel === "desktop") return DESKTOP_VIEWPORT_SURFACE;
  const rawAspect = viewport.width / viewport.height;
  const designAspect = Math.min(
    MOBILE_MAX_DESIGN_ASPECT,
    Math.max(MOBILE_MIN_DESIGN_ASPECT, rawAspect),
  );
  const portrait = designAspect <= 1;
  const shortEdge = Math.min(viewport.width, viewport.height);
  return Object.freeze({
    profile: portrait
      ? (shortEdge >= TABLET_SHORT_EDGE_MIN ? "tablet-pt" : "phone-pt")
      : (shortEdge >= TABLET_SHORT_EDGE_MIN ? "tablet-ls" : "phone-ls"),
    designWidth: portrait ? MOBILE_DESIGN_LONG_EDGE * designAspect : MOBILE_DESIGN_LONG_EDGE,
    designHeight: portrait ? MOBILE_DESIGN_LONG_EDGE : MOBILE_DESIGN_LONG_EDGE / designAspect,
    regularAspect: rawAspect >= MOBILE_MIN_DESIGN_ASPECT
      && rawAspect <= MOBILE_MAX_DESIGN_ASPECT,
  });
}

async function setTouchLayoutCapability(send, enabled) {
  await send("Emulation.setTouchEmulationEnabled", {
    enabled,
    ...(enabled ? { maxTouchPoints: 5 } : {}),
  });
  // CDP 会触发 pointer media-query change；给应用一帧机会同步布局通道，首个
  // setDeviceMetricsOverride 随后仍会等待两次稳定采样，不依赖这个短延迟判绿。
  await delay(50);
}

async function setLayoutChannelOverride(send, channel) {
  if (channel !== "desktop" && channel !== "mobile") {
    throw new Error(`生产浏览器布局测试接缝不受支持：${channel}`);
  }
  const accepted = await evaluateValue(send, {
    returnByValue: true,
    expression: `(() => {
      const url = new URL(location.href);
      url.searchParams.set('layout', ${JSON.stringify(channel)});
      history.replaceState(history.state, '', url);
      window.dispatchEvent(new Event('resize'));
      return new URL(location.href).searchParams.get('layout') === ${JSON.stringify(channel)};
    })()`,
  });
  if (!accepted) throw new Error("生产浏览器无法提交同文档布局测试接缝");
  await delay(50);
}

async function setBrowserProbePhase(send, phase) {
  if (!BROWSER_RUNTIME_PHASES.includes(phase)) {
    throw new Error("生产浏览器运行时探针阶段不受支持");
  }
  const accepted = await evaluateValue(send, {
    returnByValue: true,
    expression: `(() => {
      const probe = globalThis.__slotsProductionTransactionProbe;
      if (!probe || typeof probe.setPhase !== 'function') return false;
      probe.setPhase(${JSON.stringify(phase)});
      return probe.phase === ${JSON.stringify(phase)};
    })()`,
  });
  if (!accepted) throw new Error("生产浏览器运行时探针无法提交阶段");
}

async function verifyOpeningOverlayLayout(send, fixture, transportFailure) {
  // 开场预览位于完整预加载之后；真实字体、Spine 与 GPU 首次编译不得被一个
  // 比正式启动门禁更短的任意 5s 窗口误判为不可达。
  const overlayDeadline = Date.now() + startupTimeoutMs;
  let opening = null;
  while (Date.now() < overlayDeadline) {
    const transportError = transportFailure?.();
    if (transportError) throw transportError;
    opening = await readOpeningOverlayLayout(send);
    if (opening?.visible && opening?.authored && !opening?.continueDisabled
      && fixture.snapshot().exchangeCount === 1) break;
    await delay(50);
  }
  if (!opening?.visible || !opening.authored || opening.continueDisabled) {
    throw new Error(`正式浏览器无法到达已启用的开场 Feature Preview：${JSON.stringify({
      fixture: fixture.snapshot(),
      opening,
    })}`);
  }
  const initialLayout = await readViewportLayout(send);
  const expectedDocumentIdentity = initialLayout.documentIdentityToken;
  const expectedState = initialLayout.state;
  const expectedTransaction = fixture.snapshot();
  const steps = [];

  // URL 中的 channel=desktop 是正式 launcher 合约。即使浏览器暴露 coarse pointer，
  // Feature Preview 与游戏根也必须先保持 PC 构图，避免桌面资产落入移动坐标域。
  await setTouchLayoutCapability(send, true);
  const desktopTouchViewport = Object.freeze({ width: 1_440, height: 900 });
  await send("Emulation.setDeviceMetricsOverride", {
    width: desktopTouchViewport.width,
    height: desktopTouchViewport.height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: desktopTouchViewport.width,
    screenHeight: desktopTouchViewport.height,
  });
  const desktopTouchLayout = await waitForStableViewportLayout(
    send,
    desktopTouchViewport,
    DESKTOP_VIEWPORT_SURFACE,
    "desktop",
    transportFailure,
  );
  assertViewportGeometry(
    desktopTouchLayout,
    desktopTouchViewport,
    DESKTOP_VIEWPORT_SURFACE,
    "desktop",
  );
  if (!desktopTouchLayout.coarsePointer || desktopTouchLayout.maxTouchPoints <= 0) {
    throw new Error(`触屏 PC 能力探针没有生效：${JSON.stringify(desktopTouchLayout)}`);
  }
  assertViewportStatePreserved(expectedState, desktopTouchLayout.state, desktopTouchViewport,
    "desktop");
  assertTransactionStatePreserved(expectedTransaction, fixture.snapshot(), desktopTouchViewport,
    "desktop");
  if (desktopTouchLayout.documentIdentityToken !== expectedDocumentIdentity) {
    throw new Error("触屏 PC Feature Preview 视口切换替换了文档");
  }
  opening = await readOpeningOverlayLayout(send);
  assertOpeningOverlayGeometry(opening, desktopTouchViewport, DESKTOP_VIEWPORT_SURFACE);

  await setLayoutChannelOverride(send, "mobile");
  for (const viewport of OFFICIAL_HELP_VIEWPORTS) {
    const surface = responsiveSurfaceForViewport(viewport, "mobile");
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    const layout = await waitForStableViewportLayout(
      send,
      viewport,
      surface,
      "mobile",
      transportFailure,
    );
    assertViewportGeometry(layout, viewport, surface, "mobile");
    assertViewportStatePreserved(expectedState, layout.state, viewport, "mobile");
    assertTransactionStatePreserved(
      expectedTransaction,
      fixture.snapshot(),
      viewport,
      "mobile",
    );
    if (!layout.nodeIdentityPreserved
      || layout.documentIdentityToken !== expectedDocumentIdentity) {
      throw new Error(`开场 overlay 视口切换替换了文档或游戏节点：${viewport.width}x${viewport.height}`);
    }
    opening = await readOpeningOverlayLayout(send);
    assertOpeningOverlayGeometry(opening, viewport, surface);
    steps.push(Object.freeze({
      height: viewport.height,
      noControlOverlap: true,
      nodeIdentityPreserved: true,
      scaleX: opening.featuresMatrix.a,
      scaleY: opening.featuresMatrix.d,
      width: viewport.width,
    }));
  }

  await clickElement(send, '[data-role="preview-continue"]');
  await waitForElementDataset(send, '[data-role="feature-preview"]', "visible", "false");
  assertTransactionStatePreserved(
    expectedTransaction,
    fixture.snapshot(),
    OFFICIAL_HELP_VIEWPORTS.at(-1),
    "mobile",
  );
  return Object.freeze({
    desktopTouchLocked: Object.freeze({
      coarsePointer: desktopTouchLayout.coarsePointer,
      featurePreviewContained: true,
      frameHeight: desktopTouchLayout.frameRect.height,
      frameWidth: desktopTouchLayout.frameRect.width,
      maxTouchPoints: desktopTouchLayout.maxTouchPoints,
      verified: desktopTouchLayout.channel === "desktop",
      visibleInsetX: desktopTouchLayout.visibleInsetX,
      x: desktopTouchLayout.frameRect.left,
      y: desktopTouchLayout.frameRect.top,
    }),
    freeSpinsHud: Object.freeze({
      reachable: false,
      reason: "controlled-transaction-fixture-feature-mode-none",
      verified: false,
    }),
    steps: Object.freeze(steps),
  });
}

function assertOpeningOverlayGeometry(opening, viewport, surface) {
  const detail = () => JSON.stringify({ viewport, surface, opening });
  if (!opening?.visible || !opening.authored || opening.continueDisabled
    || !opening.previewRect || !opening.frameRect || !opening.featuresMatrix) {
    throw new Error(`开场 Feature Preview 缺少完整布局证据：${detail()}`);
  }
  requireNear(opening.featuresMatrix.a, opening.featuresMatrix.d, 0.000_01,
    "开场 overlay scaleX/scaleY", detail);
  if (opening.featuresMatrix.a <= 0) {
    throw new Error(`开场 Feature Preview 没有正向等比投影：${detail()}`);
  }
  requireNear(opening.featuresMatrix.b, 0, 0.000_001, "开场 overlay skewY", detail);
  requireNear(opening.featuresMatrix.c, 0, 0.000_001, "开场 overlay skewX", detail);
  requireNear(opening.previewRect.left, opening.frameRect.left, 0.75,
    "开场 overlay 左边界", detail);
  requireNear(opening.previewRect.top, opening.frameRect.top, 0.75,
    "开场 overlay 上边界", detail);
  requireNear(opening.previewRect.width, opening.frameRect.width, 0.75,
    "开场 overlay 宽度", detail);
  requireNear(opening.previewRect.height, opening.frameRect.height, 0.75,
    "开场 overlay 高度", detail);
  for (const [name, rectangle] of Object.entries(opening.controls ?? {})) {
    if (!rectangle
      || rectangle.width <= 0 || rectangle.height <= 0
      || rectangle.left < opening.previewRect.left - 0.75
      || rectangle.right > opening.previewRect.right + 0.75
      || rectangle.top < opening.previewRect.top - 0.75
      || rectangle.bottom > opening.previewRect.bottom + 0.75
      || rectangle.left < -0.75 || rectangle.right > viewport.width + 0.75
      || rectangle.top < -0.75 || rectangle.bottom > viewport.height + 0.75) {
      throw new Error(`开场 Feature Preview ${name} 控件越出可见画面：${detail()}`);
    }
  }
  if (rectangleIntersectionArea(opening.controls.continue, opening.controls.optOut) > 0.75
    || rectangleIntersectionArea(opening.controls.continue, opening.controls.sound) > 0.75
    || rectangleIntersectionArea(opening.controls.optOut, opening.controls.sound) > 0.75) {
    throw new Error(`开场 Feature Preview 控件发生交叠：${detail()}`);
  }
}

async function readOpeningOverlayLayout(send) {
  return evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const root = document.querySelector('#app');
        const frame = document.querySelector('[data-role="frame"]');
        const overlay = document.querySelector('[data-role="overlay"]');
        const preview = document.querySelector('[data-role="feature-preview"]');
        const features = document.querySelector('.feature-preview__features');
        const continuation = document.querySelector('[data-role="preview-continue"]');
        const optOut = document.querySelector('.feature-preview__opt-out');
        const sound = document.querySelector('[data-role="preview-sound"]');
        const logo = document.querySelector('.feature-preview__logo');
        const powered = document.querySelector('.launcher-powered-by');
        const rectangle = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        let featuresMatrix = null;
        if (features instanceof HTMLElement) {
          try {
            const parsed = new DOMMatrixReadOnly(getComputedStyle(features).transform);
            featuresMatrix = {
              a: parsed.a,
              b: parsed.b,
              c: parsed.c,
              d: parsed.d,
            };
          } catch {
            featuresMatrix = null;
          }
        }
        return {
          authored: preview instanceof HTMLElement && preview.dataset.authored === 'true',
          continueDisabled: !(continuation instanceof HTMLButtonElement) || continuation.disabled,
          controls: {
            continue: rectangle(continuation),
            logo: rectangle(logo),
            optOut: rectangle(optOut),
            powered: rectangle(powered),
            sound: rectangle(sound),
          },
          featuresMatrix,
          frameRect: rectangle(frame),
          launch: {
            assemblyStage: root instanceof HTMLElement
              ? root.dataset.startupAssemblyStage ?? null
              : null,
            domImages: (() => {
              const images = Array.from(root?.querySelectorAll('img') ?? []);
              return {
                complete: images.filter((image) => image.complete).length,
                naturalSize: images.filter((image) => image.naturalWidth > 0).length,
                total: images.length,
              };
            })(),
            fontStatus: document.fonts?.status ?? null,
            navigatorOnline: navigator.onLine,
            visibilityState: document.visibilityState,
            imageDecode: (() => {
              const observation = globalThis.__slotsImageDecodeObservation;
              return observation ? {
                calls: observation.calls,
                failures: observation.failures,
                fulfilled: observation.fulfilled,
                pending: observation.pending,
                rejected: observation.rejected,
              } : null;
            })(),
            launchPhase: overlay instanceof HTMLElement ? overlay.dataset.launch ?? null : null,
            loadingStatus: document.querySelector('[data-role="loading-status"]')?.textContent ?? null,
            loadingValue: document.querySelector('[data-role="loading-value"]')?.textContent ?? null,
            readiness: root instanceof HTMLElement ? root.dataset.startupReadiness ?? null : null,
            readinessProgress: root instanceof HTMLElement
              ? root.dataset.startupReadinessProgress ?? null
              : null,
            readinessStage: root instanceof HTMLElement
              ? root.dataset.startupReadinessStage ?? null
              : null,
            rgsSession: root instanceof HTMLElement ? root.dataset.rgsSession ?? null : null,
            domReadiness: root instanceof HTMLElement ? {
              completed: root.dataset.startupDomImageCompleted ?? null,
              errorClass: root.dataset.startupDomImageErrorClass ?? null,
              state: root.dataset.startupDomImageState ?? null,
              total: root.dataset.startupDomImageTotal ?? null,
            } : null,
            toast: (() => {
              const toast = document.querySelector('[data-role="toast"]');
              return toast instanceof HTMLElement
                ? { text: toast.textContent, visible: toast.dataset.visible ?? null }
                : null;
            })(),
          },
          previewRect: rectangle(preview),
          visible: preview instanceof HTMLElement && preview.dataset.visible === 'true',
        };
      })()
    `,
  });
}

async function verifyOfficialHelpLayout(send, fixture, options) {
  const steps = [];
  for (const viewport of OFFICIAL_HELP_VIEWPORTS) {
    const transportError = options.transportFailure?.();
    if (transportError) throw transportError;
    const surface = responsiveSurfaceForViewport(viewport, "mobile");
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    const layout = await waitForStableViewportLayout(
      send,
      viewport,
      surface,
      "mobile",
      options.transportFailure,
    );
    assertViewportGeometry(layout, viewport, surface, "mobile");
    if (layout.documentIdentityToken !== options.expectedDocumentIdentity) {
      throw new Error(`帮助页视口切换重新加载了文档：${JSON.stringify({
        viewport,
        expected: options.expectedDocumentIdentity,
        actual: layout.documentIdentityToken,
      })}`);
    }
    assertViewportStatePreserved(options.expectedState, layout.state, viewport, "mobile");
    assertTransactionStatePreserved(
      options.expectedTransaction,
      fixture.snapshot(),
      viewport,
      "mobile",
    );

    await clickElement(send, '[data-role="paytable"]');
    const deadline = Date.now() + 5_000;
    let help = null;
    while (Date.now() < deadline) {
      const helpTransportError = options.transportFailure?.();
      if (helpTransportError) throw helpTransportError;
      help = await readOfficialHelpLayout(send);
      if (help?.menuOpen && help?.presentationRulesStatus === "bound"
        && !help?.viewportHidden && Number.isFinite(help?.scaleX)
        && Number.isFinite(help?.scaleY)
        && officialHelpProjectionSettled(help)) break;
      await delay(50);
    }
    const detail = () => JSON.stringify({ viewport, surface, help });
    if (!help?.menuOpen || help.presentationRulesStatus !== "bound" || help.viewportHidden) {
      throw new Error(`正式浏览器帮助页未使用已批准 definition binding：${detail()}`);
    }
    requireNear(help.scaleX, help.scaleY, 0.000_000_01, "帮助页 scaleX/scaleY", detail);
    if (help.scaleX <= 0 || help.scaleX > 1
      || help.authoredWidth !== String(750)
      || help.horizontalOverflowDataset !== "false") {
      throw new Error(`正式浏览器帮助页没有发布单一等比投影契约：${detail()}`);
    }
    // 作者面保持未缩放的 750px 布局，projection 使用 overflow:clip 封装它；因此
    // 只把玩家实际可滚动的 viewport 当作溢出边界，不能把内部作者坐标误判成滚动。
    if (help.viewportScrollWidth > help.viewportClientWidth + 1) {
      throw new Error(`正式浏览器帮助页发生水平滚动溢出：${detail()}`);
    }
    if (help.projectionScrollWidth > help.projectionClientWidth + 1) {
      throw new Error(`正式浏览器帮助页投影宽度没有按最终滚动条收敛：${detail()}`);
    }
    if (!help.viewportRect || !help.projectionRect || !help.authoredRect
      || help.projectionRect.left < help.viewportRect.left - 0.75
      || help.projectionRect.right > help.viewportRect.right + 0.75
      || help.authoredRect.left < help.viewportRect.left - 0.75
      || help.authoredRect.right > help.viewportRect.right + 0.75) {
      throw new Error(`正式浏览器帮助页投影越出可见横向边界：${detail()}`);
    }
    if (!help.tabsRect || !help.closeRect
      || rectangleIntersectionArea(help.tabsRect, help.closeRect) > 0.75) {
      throw new Error(`正式浏览器帮助页标签与关闭按钮发生交叠：${detail()}`);
    }
    const paytableContent = await verifyOfficialHelpBottomLayout(send, viewport);
    const gameRulesContent = await verifyBoundGameRulesLayout(send, viewport);
    const postHelpLayout = await readViewportLayout(send);
    if (!postHelpLayout.nodeIdentityPreserved
      || postHelpLayout.documentIdentityToken !== options.expectedDocumentIdentity) {
      throw new Error(`帮助页交互替换了文档或游戏节点：${detail()}`);
    }
    assertViewportStatePreserved(
      options.expectedState,
      postHelpLayout.state,
      viewport,
      "mobile",
    );
    assertTransactionStatePreserved(
      options.expectedTransaction,
      fixture.snapshot(),
      viewport,
      "mobile",
    );
    steps.push(Object.freeze({
      authoredWidth: help.authoredWidth,
      bound: true,
      height: viewport.height,
      horizontalOverflow: false,
      gameRulesBottomVisible: gameRulesContent.bottomVisible,
      gameRulesBound: gameRulesContent.bound,
      paytableBottomVisible: paytableContent.bottomVisible,
      scaleX: help.scaleX,
      scaleY: help.scaleY,
      width: viewport.width,
    }));

    await clickElement(send, '[data-role="game-menu-close"]');
    await waitForElementDataset(send, '[data-role="game-menu"]', "open", "false");
  }
  return Object.freeze({ steps: Object.freeze(steps) });
}

function officialHelpProjectionSettled(help) {
  if (!help?.viewportRect || !help?.projectionRect || !help?.authoredRect) return false;
  const expectedScale = help.viewportClientWidth / 750;
  return help.projectionScrollWidth <= help.projectionClientWidth + 1
    && Math.abs(help.scaleX - expectedScale) <= 0.000_000_1
    && Math.abs(help.scaleY - expectedScale) <= 0.000_000_1
    && Math.abs(help.projectionRect.width - help.viewportClientWidth) <= 0.75
    && Math.abs(help.authoredRect.width - help.projectionRect.width) <= 0.75
    && help.projectionRect.left >= help.viewportRect.left - 0.75
    && help.projectionRect.right <= help.viewportRect.right + 0.75
    && help.authoredRect.left >= help.viewportRect.left - 0.75
    && help.authoredRect.right <= help.viewportRect.right + 0.75;
}

async function readOfficialHelpLayout(send) {
  return evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const menu = document.querySelector('[data-role="game-menu"]');
        const viewport = document.querySelector('[data-role="presentation-rules-content"]');
        const projection = document.querySelector('[data-role="official-help-projection"]');
        const authored = document.querySelector('[data-role="official-help-authored-surface"]');
        const tabs = document.querySelector('.game-menu__tabs');
        const close = document.querySelector('[data-role="game-menu-close"]');
        const rectangle = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        return {
          authoredClientWidth: authored instanceof HTMLElement ? authored.clientWidth : -1,
          authoredRect: rectangle(authored),
          authoredScrollWidth: authored instanceof HTMLElement ? authored.scrollWidth : -1,
          authoredWidth: projection instanceof HTMLElement
            ? projection.dataset.authoredWidth ?? null
            : null,
          closeRect: rectangle(close),
          horizontalOverflowDataset: viewport instanceof HTMLElement
            ? viewport.dataset.horizontalOverflow ?? null
            : null,
          menuOpen: menu instanceof HTMLElement && menu.dataset.open === 'true',
          presentationRulesStatus: menu instanceof HTMLElement
            ? menu.dataset.presentationRulesStatus ?? null
            : null,
          projectionClientWidth: projection instanceof HTMLElement ? projection.clientWidth : -1,
          projectionRect: rectangle(projection),
          projectionScrollWidth: projection instanceof HTMLElement ? projection.scrollWidth : -1,
          scaleX: projection instanceof HTMLElement ? Number(projection.dataset.scaleX) : NaN,
          scaleY: projection instanceof HTMLElement ? Number(projection.dataset.scaleY) : NaN,
          tabsRect: rectangle(tabs),
          viewportClientWidth: viewport instanceof HTMLElement ? viewport.clientWidth : -1,
          viewportHidden: !(viewport instanceof HTMLElement) || viewport.hidden,
          viewportRect: rectangle(viewport),
          viewportScrollWidth: viewport instanceof HTMLElement ? viewport.scrollWidth : -1,
        };
      })()
    `,
  });
}

async function setGameMenuScrollPosition(send, position) {
  const requested = position === "bottom" ? "bottom" : "top";
  const deadline = Date.now() + 5_000;
  let metrics = null;
  let previousGeometry = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    await evaluateValue(send, {
      returnByValue: true,
      expression: `
        (() => {
          const content = document.querySelector('.game-menu__content');
          if (!(content instanceof HTMLElement)) return null;
          content.scrollTop = ${requested === "bottom" ? "content.scrollHeight" : "0"};
          return true;
        })()
      `,
    });
    // 冷缓存下帮助页素材与投影可能在首次滚动后继续改变 scrollHeight。
    // 等一帧布局窗口再取样，并要求最大滚动位置连续稳定，避免把旧最大值误判为底边。
    await delay(50);
    metrics = await evaluateValue(send, {
      returnByValue: true,
      expression: `
        (() => {
          const content = document.querySelector('.game-menu__content');
          if (!(content instanceof HTMLElement)) return null;
          return {
            clientHeight: content.clientHeight,
            scrollHeight: content.scrollHeight,
            scrollTop: content.scrollTop,
          };
        })()
      `,
    });
    if (metrics) {
      const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
      const settled = requested === "bottom"
        ? Math.abs(metrics.scrollTop - maximum) <= 1
        : metrics.scrollTop <= 1;
      if (settled) {
        const geometry = `${metrics.clientHeight}:${metrics.scrollHeight}:${maximum}`;
        stableSamples = previousGeometry === geometry
          ? stableSamples + 1
          : 1;
        previousGeometry = geometry;
        if (stableSamples >= 3) return metrics;
      } else {
        stableSamples = 0;
        previousGeometry = null;
      }
    }
  }
  throw new Error(`正式浏览器游戏菜单无法滚动到${requested === "bottom" ? "底部" : "顶部"}：${JSON.stringify(metrics)}`);
}

async function verifyOfficialHelpBottomLayout(send, viewport) {
  await setGameMenuScrollPosition(send, "bottom");
  const evidence = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const content = document.querySelector('.game-menu__content');
        const panel = document.querySelector('#game-menu-paytable');
        const bottomHeading = document.querySelector('[data-help-anchor="maximum-win-bottom"]');
        const lastSeparator = document.querySelector('[data-separator-index="8"]');
        const authoredSections = document.querySelector('[data-role="official-help-sections"]');
        const rectangle = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        return {
          amountTexts: [...document.querySelectorAll('.base-paytable__amount')]
            .map((element) => element.textContent?.trim() ?? ''),
          authorHeight: authoredSections instanceof HTMLElement
            ? authoredSections.dataset.authorHeight ?? null
            : null,
          bottomHeadingRect: rectangle(bottomHeading),
          bottomHeadingText: bottomHeading
            ?.querySelector('.official-help__title-fill')
            ?.textContent?.trim() ?? null,
          contentClientHeight: content instanceof HTMLElement ? content.clientHeight : -1,
          contentClientWidth: content instanceof HTMLElement ? content.clientWidth : -1,
          contentRect: rectangle(content),
          contentScrollHeight: content instanceof HTMLElement ? content.scrollHeight : -1,
          contentScrollTop: content instanceof HTMLElement ? content.scrollTop : -1,
          contentScrollWidth: content instanceof HTMLElement ? content.scrollWidth : -1,
          lastSeparatorRect: rectangle(lastSeparator),
          panelHidden: !(panel instanceof HTMLElement) || panel.hidden,
          selected: document.querySelector('[data-menu-tab="paytable"]')?.getAttribute('aria-selected'),
          separatorCount: document.querySelectorAll('[data-separator-index]').length,
          titles: [...document.querySelectorAll('.official-help__title-fill')]
            .map((element) => element.textContent?.trim() ?? ''),
        };
      })()
    `,
  });
  const requiredTitles = [
    "Win up to 2500x your bet!",
    "WILD",
    "VAULT BONUS",
    "RAGE SYMBOL",
    "PRIMAL WHEEL",
    "KONG QUEST",
    "KING SPIN",
    "PAYING SYMBOLS",
    "WAY WINS",
  ];
  const detail = () => JSON.stringify({ viewport, evidence });
  const maximumScrollTop = evidence
    ? Math.max(0, evidence.contentScrollHeight - evidence.contentClientHeight)
    : Number.NaN;
  if (!evidence || evidence.panelHidden || evidence.selected !== "true"
    || evidence.authorHeight !== String(7_565) || evidence.separatorCount !== 9
    || !requiredTitles.every((title) => evidence.titles?.includes(title))
    || evidence.bottomHeadingText !== "Win up to 2500x your bet!"
    || evidence.amountTexts?.length !== 6
    || evidence.amountTexts.some((value) => value === "" || value === "—")
    || Math.abs(evidence.contentScrollTop - maximumScrollTop) > 1
    || evidence.contentScrollWidth > evidence.contentClientWidth + 1
    || !evidence.contentRect || !evidence.bottomHeadingRect || !evidence.lastSeparatorRect
    || evidence.bottomHeadingRect.top < evidence.contentRect.top - 1
    || evidence.bottomHeadingRect.bottom > evidence.contentRect.bottom + 1
    || evidence.lastSeparatorRect.top < evidence.contentRect.top - 1
    || evidence.lastSeparatorRect.bottom > evidence.contentRect.bottom + 1
    || evidence.bottomHeadingRect.bottom > evidence.lastSeparatorRect.top + 1) {
    throw new Error(`正式浏览器 PAYTABLE 关键内容或底边不可达：${detail()}`);
  }
  return Object.freeze({ bottomVisible: true });
}

async function verifyBoundGameRulesLayout(send, viewport) {
  await clickElement(send, '[data-menu-tab="rules"]');
  await setGameMenuScrollPosition(send, "top");
  const topEvidence = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const menu = document.querySelector('[data-role="game-menu"]');
        const content = document.querySelector('.game-menu__content');
        const documentSurface = document.querySelector('[data-role="game-rules-document"]');
        const unavailable = document.querySelector('[data-role="game-rules-unavailable"]');
        const pageTitle = document.querySelector('[data-role="packaged-primal-game-rules-title"]');
        const rectangle = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        return {
          actionTerms: [...document.querySelectorAll('.packaged-game-rules__actions dt')]
            .map((element) => element.textContent?.trim() ?? ''),
          background: documentSurface instanceof HTMLElement
            ? getComputedStyle(documentSurface).backgroundColor
            : null,
          contentClientWidth: content instanceof HTMLElement ? content.clientWidth : -1,
          contentRect: rectangle(content),
          contentScrollWidth: content instanceof HTMLElement ? content.scrollWidth : -1,
          documentHidden: !(documentSurface instanceof HTMLElement) || documentSurface.hidden,
          documentRect: rectangle(documentSurface),
          pageTitleRect: rectangle(pageTitle),
          pageTitleText: pageTitle?.textContent?.trim() ?? null,
          rulesStatus: menu instanceof HTMLElement ? menu.dataset.gameRulesStatus ?? null : null,
          sectionTitles: [...document.querySelectorAll('[data-game-rules-section] > h4')]
            .map((element) => element.textContent?.trim() ?? ''),
          selected: document.querySelector('[data-menu-tab="rules"]')?.getAttribute('aria-selected'),
          unavailableHidden: unavailable instanceof HTMLElement && unavailable.hidden,
          visibleText: documentSurface?.textContent ?? '',
        };
      })()
    `,
  });
  const requiredSectionTitles = [
    "Information",
    "Game Rules",
    "WILD",
    "VAULT BONUS",
    "RAGE SYMBOL",
    "PRIMAL WHEEL",
    "KONG QUEST FREE SPINS",
    "KING SPIN FREE SPINS",
    "Actions",
  ];
  const expectedActionTerms = [
    "Paytable",
    "Auto Play",
    "Spin / Start / Spacebar",
    "Stop",
    "Fast Play",
  ];
  const topDetail = () => JSON.stringify({ viewport, topEvidence });
  if (!topEvidence || topEvidence.documentHidden || !topEvidence.unavailableHidden
    || topEvidence.rulesStatus !== "bound" || topEvidence.selected !== "true"
    || topEvidence.pageTitleText !== "Primal Rampage"
    || JSON.stringify(topEvidence.sectionTitles) !== JSON.stringify(requiredSectionTitles)
    || JSON.stringify(topEvidence.actionTerms) !== JSON.stringify(expectedActionTerms)
    || /Hyper Spin|holding down the SPACE button|Auto adjust bet|Automatically reduces the total bet/u
      .test(topEvidence.visibleText)
    || topEvidence.background !== "rgb(255, 255, 255)"
    || topEvidence.contentScrollWidth > topEvidence.contentClientWidth + 1
    || !topEvidence.contentRect || !topEvidence.documentRect || !topEvidence.pageTitleRect
    || topEvidence.documentRect.left < topEvidence.contentRect.left - 1
    || topEvidence.documentRect.right > topEvidence.contentRect.right + 1
    || topEvidence.pageTitleRect.top < topEvidence.contentRect.top - 1
    || topEvidence.pageTitleRect.bottom > topEvidence.contentRect.bottom + 1) {
    throw new Error(`正式浏览器 Game Rules 绑定、关键标题或顶部几何失真：${topDetail()}`);
  }

  await setGameMenuScrollPosition(send, "bottom");
  const bottomEvidence = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const content = document.querySelector('.game-menu__content');
        const documentSurface = document.querySelector('[data-role="game-rules-document"]');
        const descriptions = document.querySelectorAll('.packaged-game-rules__actions dd');
        const finalDescription = descriptions.item(descriptions.length - 1);
        const rectangle = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        return {
          contentClientHeight: content instanceof HTMLElement ? content.clientHeight : -1,
          contentRect: rectangle(content),
          contentScrollHeight: content instanceof HTMLElement ? content.scrollHeight : -1,
          contentScrollTop: content instanceof HTMLElement ? content.scrollTop : -1,
          documentRect: rectangle(documentSurface),
          finalDescriptionRect: rectangle(finalDescription),
          finalDescriptionText: finalDescription?.textContent?.trim() ?? null,
        };
      })()
    `,
  });
  const bottomDetail = () => JSON.stringify({ viewport, bottomEvidence });
  const maximumScrollTop = bottomEvidence
    ? Math.max(0, bottomEvidence.contentScrollHeight - bottomEvidence.contentClientHeight)
    : Number.NaN;
  if (!bottomEvidence || Math.abs(bottomEvidence.contentScrollTop - maximumScrollTop) > 1
    || !bottomEvidence.contentRect || !bottomEvidence.documentRect
    || !bottomEvidence.finalDescriptionRect
    || bottomEvidence.documentRect.bottom > bottomEvidence.contentRect.bottom + 1
    || bottomEvidence.documentRect.bottom < bottomEvidence.contentRect.top - 1
    || bottomEvidence.finalDescriptionRect.top < bottomEvidence.contentRect.top - 1
    || bottomEvidence.finalDescriptionRect.bottom > bottomEvidence.contentRect.bottom + 1
    || bottomEvidence.finalDescriptionText !== "- Toggle on for a significantly faster gameplay.") {
    throw new Error(`正式浏览器 Game Rules 底边不可达：${bottomDetail()}`);
  }
  return Object.freeze({ bound: true, bottomVisible: true });
}

async function clickElement(send, selector) {
  const point = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()
    `,
  });
  if (!point) throw new Error(`正式浏览器找不到可点击控件：${selector}`);
  await dispatchMouseClick(send, point);
}

async function waitForElementDataset(send, selector, name, expected) {
  const deadline = Date.now() + 5_000;
  let actual = null;
  while (Date.now() < deadline) {
    actual = await evaluateValue(send, {
      returnByValue: true,
      expression: `document.querySelector(${JSON.stringify(selector)})?.dataset?.[${JSON.stringify(name)}] ?? null`,
    });
    if (actual === expected) return;
    await delay(50);
  }
  throw new Error(`正式浏览器控件状态没有稳定：${selector} data-${name}=${actual}`);
}

function rectangleIntersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
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
    const expected = expectedViewportGeometry(viewport, surface, channel);
    const eligible = snapshot?.viewportWidth === viewport.width
      && snapshot?.viewportHeight === viewport.height
      && snapshot?.frameCount === 1
      && snapshot?.channel === channel
      && snapshot?.profile === surface.profile
      && Math.abs(snapshot?.designWidth - surface.designWidth) <= 0.000_001
      && Math.abs(snapshot?.designHeight - surface.designHeight) <= 0.000_001
      && Math.abs(snapshot.datasetScale - expected.scale) <= 0.000_001
      && Math.abs(snapshot.frameRect.width - expected.width) <= 0.75
      && Math.abs(snapshot.frameRect.height - expected.height) <= 0.75;
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
        const rectangle = (selector) => {
          const element = root?.querySelector(selector);
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        const statusPanel = root?.querySelector('.status-panel');
        const statusPanelStyle = statusPanel instanceof HTMLElement
          ? getComputedStyle(statusPanel)
          : null;
        const statusValues = [...(root?.querySelectorAll('.status-metric') ?? [])]
          .filter((element) => element instanceof HTMLElement)
          .map((element) => ({
            clientHeight: element.clientHeight,
            role: element.className,
            scrollHeight: element.scrollHeight,
          }));
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
        if (!probe.documentIdentityToken) {
          probe.documentIdentityToken = typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : String(performance.timeOrigin);
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
          coarsePointer: matchMedia('(pointer: coarse)').matches,
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
          documentOverflow: {
            bodyX: document.body.scrollWidth - innerWidth,
            bodyY: document.body.scrollHeight - innerHeight,
            rootX: document.documentElement.scrollWidth - innerWidth,
            rootY: document.documentElement.scrollHeight - innerHeight,
          },
          documentIdentityToken: probe.documentIdentityToken,
          matrix,
          maxTouchPoints: navigator.maxTouchPoints,
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
          controlLayout: {
            portrait: innerHeight >= innerWidth,
            round: rectangle('.round-state'),
            spin: rectangle('[data-role="spin-dock"]'),
            utility: rectangle('[data-role="tool-strip"]'),
            status: rectangle('.status-panel'),
            statusBoxShadow: statusPanelStyle?.boxShadow ?? null,
            statusClientHeight: statusPanel instanceof HTMLElement ? statusPanel.clientHeight : -1,
            statusScrollHeight: statusPanel instanceof HTMLElement ? statusPanel.scrollHeight : -1,
            statusValues,
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
          visibleInsetX: Number.parseFloat(frameStyle.getPropertyValue('--visible-inset-x')),
          viewportHeight: innerHeight,
          viewportWidth: innerWidth,
        };
      })()
    `,
  });
}

function assertViewportGeometry(snapshot, viewport, surface, channel) {
  const expected = expectedViewportGeometry(viewport, surface, channel);
  const detail = () => JSON.stringify({ viewport, surface, snapshot });
  if (snapshot.frameCount !== 1 || !snapshot.nodeIdentityPreserved
    || snapshot.channel !== channel || snapshot.profile !== surface.profile
    || Math.abs(snapshot.designWidth - surface.designWidth) > 0.000_001
    || Math.abs(snapshot.designHeight - surface.designHeight) > 0.000_001) {
    throw new Error(`生产布局没有唯一且动态匹配当前能力的设计框架：${detail()}`);
  }
  requireNear(snapshot.datasetScale, expected.scale, 0.000_001, "数据 scale", detail);
  requireNear(snapshot.datasetX, expected.x, 0.000_001, "数据 x", detail);
  requireNear(snapshot.datasetY, expected.y, 0.000_001, "数据 y", detail);
  requireNear(snapshot.frameRect.width, expected.width, 0.75, "框架宽度", detail);
  requireNear(snapshot.frameRect.height, expected.height, 0.75, "框架高度", detail);
  requireNear(snapshot.frameRect.left, expected.x, 0.75, "框架左偏移", detail);
  requireNear(snapshot.frameRect.top, expected.y, 0.75, "框架上偏移", detail);
  requireNear(
    viewport.width - snapshot.frameRect.right,
    expected.x,
    0.75,
    "框架右偏移",
    detail,
  );
  requireNear(
    viewport.height - snapshot.frameRect.bottom,
    expected.y,
    0.75,
    "框架下偏移",
    detail,
  );
  requireNear(snapshot.visibleInsetX, expected.visibleInsetX, 0.000_001, "可见横向内缩", detail);
  requireNear(snapshot.safeAreaRect.left, 0, 0.25, "安全区左边", detail);
  requireNear(snapshot.safeAreaRect.top, 0, 0.25, "安全区上边", detail);
  requireNear(snapshot.safeAreaRect.width, viewport.width, 0.25, "安全区宽度", detail);
  requireNear(snapshot.safeAreaRect.height, viewport.height, 0.25, "安全区高度", detail);
  if (channel === "mobile" && (
    snapshot.frameRect.left < -0.75 || snapshot.frameRect.top < -0.75
    || snapshot.frameRect.right > viewport.width + 0.75
    || snapshot.frameRect.bottom > viewport.height + 0.75
  )) {
    throw new Error(`生产布局发生视口裁切：${detail()}`);
  }
  const matrix = snapshot.matrix;
  if (!matrix || matrix.is2D !== true) {
    throw new Error(`生产布局没有唯一二维缩放矩阵：${detail()}`);
  }
  // getComputedStyle() 会把 CSS matrix 小数序列化为约 6 位；数据集仍保持完整精度。
  requireNear(matrix.a, expected.scale, 0.000_01, "矩阵 scaleX", detail);
  requireNear(matrix.d, expected.scale, 0.000_01, "矩阵 scaleY", detail);
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
  if (Object.values(snapshot.documentOverflow ?? {}).some((overflow) => overflow > 1)) {
    throw new Error(`生产布局产生文档级溢出：${detail()}`);
  }
  if (channel === "mobile" && surface.regularAspect) {
    requireNear(snapshot.frameRect.left, 0, 0.75, "常规比例左边", detail);
    requireNear(snapshot.frameRect.top, 0, 0.75, "常规比例上边", detail);
    requireNear(snapshot.frameRect.width, viewport.width, 0.75, "常规比例全视口宽度", detail);
    requireNear(snapshot.frameRect.height, viewport.height, 0.75, "常规比例全视口高度", detail);
  }
}

function expectedViewportGeometry(viewport, surface, channel) {
  if (channel === "desktop") {
    const height = Math.min(
      viewport.height,
      viewport.width * (DESKTOP_AUTHORED_HEIGHT / DESKTOP_AUTHORED_WIDTH),
    );
    const scale = height / surface.designHeight;
    const width = surface.designWidth * scale;
    const x = (viewport.width - width) / 2;
    const y = (viewport.height - height) / 2;
    return Object.freeze({
      height,
      scale,
      visibleInsetX: scale > 0 ? Math.max(0, -x / scale) : 0,
      width,
      x,
      y,
    });
  }
  const scale = Math.min(
    viewport.width / surface.designWidth,
    viewport.height / surface.designHeight,
  );
  const width = surface.designWidth * scale;
  const height = surface.designHeight * scale;
  return Object.freeze({
    height,
    scale,
    visibleInsetX: 0,
    width,
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
  });
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

function assertTransactionStatePreserved(expected, actual, viewport, channel) {
  assertSessionStatusCadence(expected);
  assertSessionStatusCadence(actual);
  if (!economicTransactionStateEqual(expected, actual)) {
    throw new Error(`连续视口切换或界面点击改变了 RGS 事务：${JSON.stringify({
      channel,
      viewport,
      expected,
      actual,
    })}`);
  }
}

function assertMobileControlLayout(snapshot, viewport) {
  const controls = snapshot.controlLayout;
  const detail = () => JSON.stringify({ viewport, controls, snapshot });
  const { round, spin, status, utility } = controls ?? {};
  if (!round || !spin || !status || !utility) {
    throw new Error(`移动布局缺少轮次、旋转、工具或状态栏几何：${detail()}`);
  }
  const tolerance = 0.75;
  if (controls.portrait) {
    if (round.bottom > spin.top + tolerance
      || spin.bottom > utility.top + tolerance
      || utility.bottom > status.top + tolerance) {
      throw new Error(`移动纵向轮次、旋转、工具与状态栏发生交叠：${detail()}`);
    }
  } else if (round.left < utility.right - tolerance
    || round.right > spin.left + tolerance) {
    throw new Error(`移动横向轮次提示没有位于两侧控件之间：${detail()}`);
  }
  if (controls.statusScrollHeight > controls.statusClientHeight + 1) {
    throw new Error(`移动状态栏内容发生纵向裁切：${detail()}`);
  }
  for (const metric of controls.statusValues ?? []) {
    if (metric.scrollHeight > metric.clientHeight + 1) {
      throw new Error(`移动状态值内容发生纵向裁切：${detail()}`);
    }
  }
  return Object.freeze({
    orientation: controls.portrait ? "portrait" : "landscape",
    roundBetweenControls: controls.portrait
      ? round.bottom <= spin.top + tolerance
      : round.left >= utility.right - tolerance && round.right <= spin.left + tolerance,
    statusContained: controls.statusScrollHeight <= controls.statusClientHeight + 1
      && (controls.statusValues ?? []).every(
        (metric) => metric.scrollHeight <= metric.clientHeight + 1,
      ),
  });
}

function assertDesktopStatusLayout(snapshot, viewport) {
  const status = snapshot.controlLayout?.status;
  const expected = expectedViewportGeometry(
    viewport,
    DESKTOP_VIEWPORT_SURFACE,
    "desktop",
  );
  const detail = () => JSON.stringify({ viewport, expected, status, snapshot });
  if (!status) throw new Error(`PC 状态栏缺少浏览器几何证据：${detail()}`);
  requireNear(status.left, 0, 0.75, "PC 状态栏可见左边", detail);
  requireNear(status.right, viewport.width, 0.75, "PC 状态栏可见右边", detail);
  requireNear(status.width, viewport.width, 0.75, "PC 状态栏可见宽度", detail);
  requireNear(status.height, 16 * expected.scale, 0.75, "PC 状态栏物理高度", detail);
  requireNear(status.bottom, viewport.height, 0.75, "PC 状态栏物理底边", detail);
  if (typeof snapshot.controlLayout.statusBoxShadow !== "string"
    || !/rgb\(19, 10, 3\) 0px -1px 0px(?: 0px)?/.test(
      snapshot.controlLayout.statusBoxShadow,
    )) {
    throw new Error(`PC 状态栏缺少原版顶部 1px 纹理接缝：${detail()}`);
  }
  if (snapshot.controlLayout.statusScrollHeight
      > snapshot.controlLayout.statusClientHeight + 1
    || snapshot.controlLayout.statusValues.some(
      (metric) => metric.scrollHeight > metric.clientHeight + 1,
    )) {
    throw new Error(`PC 状态栏内容发生纵向裁切：${detail()}`);
  }
  return Object.freeze({
    contained: true,
    height: status.height,
    physicalBottom: status.bottom,
  });
}

async function verifyMaximumStatusValues(send, viewport) {
  const evidence = await evaluateValue(send, {
    returnByValue: true,
    expression: `
      (() => {
        const maximum = ${JSON.stringify(MAXIMUM_STATUS_VALUE)};
        const panel = document.querySelector('.status-panel');
        const targets = [
          ['balance', document.querySelector('[data-role="balance"]')],
          ['bet', document.querySelector('[data-role="bet-status"]')],
          ['win', document.querySelector('[data-role="last-win"]')],
        ];
        if (!(panel instanceof HTMLElement)
          || targets.some(([, element]) => !(element instanceof HTMLElement))) return null;
        const panelZeroWin = panel.getAttribute('data-zero-win');
        const panelMoneyDensity = panel.getAttribute('data-money-density');
        const originals = targets.map(([name, element]) => ({
          element,
          name,
          text: element.textContent,
          zero: element.getAttribute('data-zero'),
        }));
        const rectangle = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        let result;
        try {
          panel.dataset.zeroWin = 'false';
          // 直接文本探针绕过 DomOverlay setter，因此必须同时模拟 setter 发布的
          // 固定低基数布局状态；不伪造或改变 RGS/玩家经济状态。
          panel.dataset.moneyDensity = 'extreme';
          for (const { element } of originals) {
            element.textContent = maximum;
            element.dataset.zero = 'false';
          }
          const panelRect = rectangle(panel);
          result = {
            maximum,
            panelRect,
            values: originals.map(({ element, name }) => {
              const metric = element.closest('.status-metric');
              return {
                clientHeight: element.clientHeight,
                clientWidth: element.clientWidth,
                metricRect: metric instanceof HTMLElement ? rectangle(metric) : null,
                name,
                rect: rectangle(element),
                scrollHeight: element.scrollHeight,
                scrollWidth: element.scrollWidth,
                text: element.textContent,
              };
            }),
          };
        } finally {
          for (const { element, text, zero } of originals) {
            element.textContent = text;
            if (zero === null) element.removeAttribute('data-zero');
            else element.setAttribute('data-zero', zero);
          }
          if (panelZeroWin === null) panel.removeAttribute('data-zero-win');
          else panel.setAttribute('data-zero-win', panelZeroWin);
          if (panelMoneyDensity === null) panel.removeAttribute('data-money-density');
          else panel.setAttribute('data-money-density', panelMoneyDensity);
        }
        return result;
      })()
    `,
  });
  const detail = () => JSON.stringify({ viewport, evidence });
  if (!evidence?.panelRect || evidence.maximum !== MAXIMUM_STATUS_VALUE
    || evidence.values?.length !== 3) {
    throw new Error(`最大 int64 金额状态栏探针缺少完整证据：${detail()}`);
  }
  for (const value of evidence.values) {
    if (value.text !== MAXIMUM_STATUS_VALUE || !value.rect || !value.metricRect
      || value.clientWidth <= 0 || value.clientHeight <= 0
      || value.scrollWidth > value.clientWidth + 1
      || value.scrollHeight > value.clientHeight + 1
      || value.rect.left < evidence.panelRect.left - 0.75
      || value.rect.right > evidence.panelRect.right + 0.75
      || value.rect.top < evidence.panelRect.top - 0.75
      || value.rect.bottom > evidence.panelRect.bottom + 0.75) {
      throw new Error(`最大 int64 金额在移动状态栏中被裁切：${detail()}`);
    }
  }
  for (let leftIndex = 0; leftIndex < evidence.values.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < evidence.values.length; rightIndex += 1) {
      if (rectangleIntersectionArea(
        evidence.values[leftIndex].metricRect,
        evidence.values[rightIndex].metricRect,
      ) > 0.75) {
        throw new Error(`最大 int64 Balance/Bet/Win 在移动状态栏中互相覆盖：${detail()}`);
      }
    }
  }
  return Object.freeze({
    maximum: evidence.maximum,
    noClipping: true,
    noOverlap: true,
  });
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
    throw new Error(`生产布局 ${label} 不符合根投影契约：${detail()}`);
  }
}

function rounded(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function validateContinuousViewportEvidence(viewportEvidence) {
  const desktop = viewportEvidence?.desktop;
  const help = viewportEvidence?.help;
  const mobile = viewportEvidence?.mobile;
  const openingOverlay = viewportEvidence?.openingOverlay;
  if (!desktop || !help || !mobile || !openingOverlay
    || desktop.channel !== "desktop" || mobile.channel !== "mobile"
    || desktop.steps?.length !== DESKTOP_TRANSITION_VIEWPORTS.length
    || mobile.steps?.length !== CONTINUOUS_VIEWPORTS.length
    || help.steps?.length !== OFFICIAL_HELP_VIEWPORTS.length
    || openingOverlay.steps?.length !== OFFICIAL_HELP_VIEWPORTS.length
    || openingOverlay.desktopTouchLocked?.verified !== true
    || openingOverlay.desktopTouchLocked?.coarsePointer !== true
    || openingOverlay.desktopTouchLocked?.maxTouchPoints <= 0
    || openingOverlay.desktopTouchLocked?.featurePreviewContained !== true
    || Math.abs(openingOverlay.desktopTouchLocked?.x - (-80)) > 0.75
    || Math.abs(openingOverlay.desktopTouchLocked?.y) > 0.75
    || Math.abs(openingOverlay.desktopTouchLocked?.frameWidth - 1_600) > 0.75
    || Math.abs(openingOverlay.desktopTouchLocked?.frameHeight - 900) > 0.75
    || Math.abs(openingOverlay.desktopTouchLocked?.visibleInsetX - 64) > 0.000_001
    || openingOverlay.freeSpinsHud?.reachable !== false
    || openingOverlay.freeSpinsHud?.verified !== false
    || openingOverlay.freeSpinsHud?.reason
      !== "controlled-transaction-fixture-feature-mode-none"
    || desktop.blackBorderClickCount !== 0
    || mobile.blackBorderClickCount !== 2) {
    throw new Error(`生产浏览器连续视口证据不完整：${JSON.stringify(viewportEvidence)}`);
  }
  for (let index = 0; index < CONTINUOUS_VIEWPORTS.length; index += 1) {
    const expected = CONTINUOUS_VIEWPORTS[index];
    const step = mobile.steps[index];
    const shouldHaveBlackBorder = index >= CONTINUOUS_VIEWPORTS.length - 2;
    if (step.width !== expected.width || step.height !== expected.height
      || step.channel !== "mobile" || step.maxTouchPoints <= 0 || !step.coarsePointer
      || !step.nodeIdentityPreserved || !step.documentIdentityPreserved || !step.statePreserved
      || !step.transactionStatePreserved
      || step.maximumStatusLayout?.maximum !== MAXIMUM_STATUS_VALUE
      || !step.maximumStatusLayout?.noClipping || !step.maximumStatusLayout?.noOverlap
      || step.blackBorderClicked !== shouldHaveBlackBorder
      || (step.regularAspect && (!step.controlLayout?.roundBetweenControls
        || !step.controlLayout?.statusContained))) {
      throw new Error(`生产浏览器移动连续视口顺序或状态证据失真：${JSON.stringify({
        expected,
        step,
      })}`);
    }
  }
  for (let index = 0; index < DESKTOP_TRANSITION_VIEWPORTS.length; index += 1) {
    const expected = DESKTOP_TRANSITION_VIEWPORTS[index];
    const step = desktop.steps[index];
    if (step.width !== expected.width || step.height !== expected.height
      || step.channel !== "desktop" || step.maxTouchPoints !== 0
      || !step.nodeIdentityPreserved || !step.documentIdentityPreserved || !step.statePreserved
      || !step.transactionStatePreserved || step.blackBorderClicked
      || !Number.isFinite(step.visibleInsetX) || !step.statusLayout?.contained
      || Math.abs(step.statusLayout.physicalBottom - expected.height) > 0.75) {
      throw new Error(`生产浏览器桌面连续视口顺序或状态证据失真：${JSON.stringify({
        expected,
        step,
      })}`);
    }
    if (expected.width === 1_440 && expected.height === 900
      && (Math.abs(step.x - (-80)) > 0.75 || Math.abs(step.y) > 0.75
        || Math.abs(step.frameWidth - 1_600) > 0.75
        || Math.abs(step.frameHeight - 900) > 0.75
        || Math.abs(step.scale - 1.25) > 0.000_001
        || Math.abs(step.visibleInsetX - 64) > 0.000_001)) {
      throw new Error(`生产浏览器 1440x900 PC authored 投影证据失真：${JSON.stringify(step)}`);
    }
  }
  for (let index = 0; index < OFFICIAL_HELP_VIEWPORTS.length; index += 1) {
    const expected = OFFICIAL_HELP_VIEWPORTS[index];
    const step = help.steps[index];
    if (step.width !== expected.width || step.height !== expected.height
      || !step.bound || step.horizontalOverflow || step.scaleX !== step.scaleY
      || step.paytableBottomVisible !== true || step.gameRulesBound !== true
      || step.gameRulesBottomVisible !== true) {
      throw new Error(`正式浏览器帮助页视口证据失真：${JSON.stringify({
        expected,
        step,
      })}`);
    }
    const overlayStep = openingOverlay.steps[index];
    if (overlayStep.width !== expected.width || overlayStep.height !== expected.height
      || !overlayStep.noControlOverlap || !overlayStep.nodeIdentityPreserved
      || Math.abs(overlayStep.scaleX - overlayStep.scaleY) > 0.000_01) {
      throw new Error(`开场 Feature Preview 视口证据失真：${JSON.stringify({
        expected,
        overlayStep,
      })}`);
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
    runtimeDiagnostics: browserState.runtimeDiagnostics,
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
        const runtimeDiagnostics = probe?.runtimeDiagnostics ?? {
          schema: 1,
          fatalCount: 1,
          warningCount: 0,
          droppedCount: 0,
          events: [{
            kind: "window-error",
            code: "UNKNOWN_RUNTIME_ERROR",
            phase: "document-start",
            severity: "fatal",
            count: 1,
          }],
        };
        const transaction = probe?.transaction;
        const cspViolations = Array.isArray(cspSnapshot)
          ? cspSnapshot.slice(0, 16).map((violation) => ({
              effectiveDirective: String(violation?.effectiveDirective ?? '').slice(0, 64),
              violatedDirective: String(violation?.violatedDirective ?? '').slice(0, 64),
              disposition: String(violation?.disposition ?? '').slice(0, 32),
              blockedTarget: String(violation?.blockedTarget ?? '').slice(0, 256),
              sourceFile: typeof violation?.sourceFile === 'string'
                ? violation.sourceFile.slice(0, 128)
                : undefined,
              lineNumber: Number.isSafeInteger(violation?.lineNumber)
                ? violation.lineNumber
                : undefined,
              columnNumber: Number.isSafeInteger(violation?.columnNumber)
                ? violation.columnNumber
                : undefined,
              trustedTypesSink: typeof violation?.trustedTypesSink === 'string'
                ? violation.trustedTypesSink.slice(0, 64)
                : undefined,
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
            || runtimeDiagnostics.fatalCount > 0
            || cspViolations.length > 0,
          status: document.querySelector('.launch-loading__status')?.textContent ?? null,
          cspViolations,
          operatorSessionRequests,
          playerErrors,
          runtimeDiagnostics,
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
    runtimeDiagnostics: state?.runtimeDiagnostics ?? null,
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
