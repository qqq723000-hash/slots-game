import { createReadStream } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "@playwright/test";

import {
  CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE,
  createReleaseContentSecurityPolicy,
} from "../../deploy/web/content-security-policy.mjs";
import {
  resolveBrowserRenderingContract,
  validateProductionBrowserTimingBudget,
} from "./browser-rendering-contract.mjs";
import { createControlledRgsTransactionFixture } from "./production-browser-transaction-fixture.mjs";
import { validateReleaseRgsBuildEnvironment } from "../src/validateReleaseRgsBuildConfig.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = resolve(webRoot, "dist");
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
const approvedBinding = Object.freeze({
  gameId: "iron-colossus",
  definitionVersion: "local-production-2026-08-26.3",
  definitionHash: "9e9b9b5f23f0f2cfed0a4a5ff5961dbc76a91ba9e614f3cfadb47824a46d2205",
});
const startupTimeoutMs = 45_000;
const featurePreviewStartupTimeoutMs = 90_000;
const maximumFeaturePreviewStartupTimeoutMs = 2 * 60_000;
const supportedBrowsers = Object.freeze(["chromium", "firefox", "webkit", "msedge"]);
// ResponsiveLayout 在 390x844 移动设计面使用 390x844、scale=1 的唯一根投影；
// DomOverlay 将捕获的 Spin 中心 638.36328125 与 85.91 外圈发布到同一设计坐标域。
const mobilePortraitGeometryContract = Object.freeze({
  designHeight: 844,
  designWidth: 390,
  frameBottomMinimum: 843,
  frameBottomExpected: 844,
  frameScaleExpected: 1,
  spinBottomMinimum: 680.5,
  spinBottomExpected: 638.36328125 + 85.91 / 2,
  spinSizeExpected: 85.91,
  spinTopExpected: 638.36328125 - 85.91 / 2,
  tolerance: 0.75,
  viewportHeight: 844,
  viewportWidth: 390,
});

validateReleaseRgsBuildEnvironment(process.env);
validateProductionBrowserTimingBudget({
  featurePreviewStartupTimeoutMs,
  maximumFeaturePreviewStartupTimeoutMs,
});
const selectedBrowsers = parseSelectedBrowsers(process.argv.slice(2));
const browserRgsBaseUrl = process.env.VITE_RGS_BASE_URL;
const browserHostOrigin = process.env.VITE_RGS_HOST_ORIGIN;
const browserBetMinor = process.env.VITE_RGS_DEFAULT_BET_MINOR;
const browserContentSecurityPolicy = createReleaseContentSecurityPolicy({
  rgsBaseUrl: browserRgsBaseUrl,
  hostOrigin: browserHostOrigin,
});

await access(resolve(distributionRoot, "index.html"));
const distributionRealRoot = await realpath(distributionRoot);
const server = createDistributionServer();
const address = await listenOnLoopback(server);
const evidence = [];

try {
  for (const browserName of selectedBrowsers) {
    evidence.push(await verifyBrowser(browserName, address.port));
  }
} finally {
  await closeServer(server);
}

process.stdout.write(
  `生产跨浏览器门禁通过：${selectedBrowsers.join(", ")} 完成真实资源解码、WebGL、会话交换、旋转、结算 ACK、移动布局与说明页底边检查。\n证据：${JSON.stringify(evidence)}\n`,
);

function parseSelectedBrowsers(argumentsValue) {
  if (argumentsValue.length === 0) return ["chromium", "firefox", "webkit"];
  if (argumentsValue.length !== 2 || argumentsValue[0] !== "--browser") {
    throw new Error("用法：verify-production-cross-browser.mjs [--browser chromium,firefox,webkit,msedge]");
  }
  const values = [...new Set(argumentsValue[1].split(",").filter(Boolean))];
  if (values.length === 0 || values.some((value) => !supportedBrowsers.includes(value))) {
    throw new Error("跨浏览器门禁包含不受支持的浏览器名称");
  }
  return values;
}

async function verifyBrowser(browserName, port) {
  const browserType = browserName === "firefox"
    ? firefox
    : browserName === "webkit"
      ? webkit
      : chromium;
  let browser = null;
  let context = null;
  try {
    const renderingContract = resolveBrowserRenderingContract({ browserName });
    browser = await browserType.launch({
      ...renderingContract.launchOptions,
    });
    context = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 1_440, height: 900 },
    });
    await context.addInitScript({ content: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE });
    const page = await context.newPage();
    const runtimeErrors = [];
    const transportErrors = [];
    page.on("pageerror", (error) => {
      const message = String(error?.message ?? "unknown page error");
      if (!message.startsWith("ResizeObserver loop")) runtimeErrors.push(message.slice(0, 256));
    });

    const pageOrigin = `http://127.0.0.1:${port}`;
    const launchCode = `lc_${browserName.padEnd(43, "x").slice(0, 43)}`;
    const sessionId = `browser-matrix-${browserName}`;
    const transaction = createControlledRgsTransactionFixture({
      baseUrl: browserRgsBaseUrl,
      pageOrigin,
      launchCode,
      operatorId: "browser-matrix",
      sessionId,
      initialBalanceMinor: "1000",
      betMinor: browserBetMinor,
      finalBalanceMinor: "850",
      ...approvedBinding,
    });

    await page.route(`${new URL(browserRgsBaseUrl).origin}/**`, async (route) => {
      try {
        const request = route.request();
        const fulfillment = transaction.responseForPausedRequest({
          request: {
            url: request.url(),
            method: request.method(),
            headers: await request.allHeaders(),
            postData: request.postData(),
          },
        });
        await route.fulfill({
          status: fulfillment.responseCode,
          headers: Object.fromEntries(
            fulfillment.responseHeaders.map(({ name, value }) => [name, value]),
          ),
          ...(fulfillment.body === undefined ? {} : { body: fulfillment.body }),
        });
      } catch (error) {
        transportErrors.push(error instanceof Error ? error.message : "unknown transport error");
        await route.abort("failed").catch(() => undefined);
      }
    });

    const pageUrl = `${pageOrigin}/?channel=desktop&featurePreview=force#${new URLSearchParams({
      rgsLaunchCode: launchCode,
      rgsOperatorId: "browser-matrix",
      rgsSessionId: sessionId,
    })}`;
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: startupTimeoutMs });
    await waitForFeaturePreviewReady(page, browserName, runtimeErrors, transportErrors);
    const cspViolations = await page.evaluate(() => (
      globalThis.__slotsContentSecurityPolicyProbe?.violations ?? null
    ));
    if (!Array.isArray(cspViolations) || cspViolations.length !== 0) {
      throw new Error(`${browserName} 触发生产 CSP 违规：${JSON.stringify(cspViolations)}`);
    }
    requireNoFailures(runtimeErrors, transportErrors, browserName);
    await page.locator('[data-role="preview-continue"]').click();
    await waitForReady(page);

    const initialCanvas = await page.evaluate(() => {
      const canvas = document.querySelector('[data-role="canvas"] canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return {
        height: canvas.height,
        maximumTextureSize: context?.getParameter(context.MAX_TEXTURE_SIZE) ?? 0,
        width: canvas.width,
      };
    });
    if (!initialCanvas || initialCanvas.width <= 0 || initialCanvas.height <= 0
      || initialCanvas.maximumTextureSize < 4_096) {
      throw new Error(`${browserName} 没有可用的生产 WebGL 画布`);
    }

    await page.locator('[data-role="spin"]').click();
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-role="frame"]');
      const spin = document.querySelector('[data-role="spin"]');
      return frame instanceof HTMLElement
        && spin instanceof HTMLButtonElement
        && frame.dataset.reelState === "Idle"
        && spin.dataset.mode === "ready"
        && spin.dataset.action === "spin"
        && !spin.disabled
        && document.querySelector('[data-role="last-win"]')?.textContent === "0.50";
    }, undefined, { timeout: startupTimeoutMs });
    const transactionEvidence = await waitForAcknowledgedTransaction(
      transaction,
      runtimeErrors,
      transportErrors,
      browserName,
    );
    if (transactionEvidence.exchangeCount !== 1
      || transactionEvidence.spinCount !== 1
      || transactionEvidence.acknowledgementCount !== 1
      || JSON.stringify(transactionEvidence.order)
        !== JSON.stringify(["session-exchange", "spin", "result-acknowledgement"])) {
      throw new Error(`${browserName} 的生产事务不完整：${JSON.stringify(transactionEvidence)}`);
    }

    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set("layout", "mobile");
      history.replaceState(history.state, "", url);
    });
    await page.setViewportSize({
      width: mobilePortraitGeometryContract.viewportWidth,
      height: mobilePortraitGeometryContract.viewportHeight,
    });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction((contract) => {
      const frame = document.querySelector('[data-role="frame"]');
      const spin = document.querySelector('[data-role="spin-dock"]');
      if (!(frame instanceof HTMLElement) || !(spin instanceof HTMLElement)
        || frame.dataset.channel !== "mobile") return false;
      const frameRect = frame.getBoundingClientRect();
      const spinRect = spin.getBoundingClientRect();
      const near = (actual, expected) => Number.isFinite(actual)
        && Math.abs(actual - expected) <= contract.tolerance;
      return near(Number(frame.dataset.designWidth), contract.designWidth)
        && near(Number(frame.dataset.designHeight), contract.designHeight)
        && near(Number(frame.dataset.frameScale), contract.frameScaleExpected)
        && near(frameRect.left, 0)
        && near(frameRect.top, 0)
        && near(frameRect.right, contract.viewportWidth)
        && near(frameRect.bottom, contract.frameBottomExpected)
        && near(spinRect.top, contract.spinTopExpected)
        && near(spinRect.bottom, contract.spinBottomExpected)
        && near(spinRect.width, contract.spinSizeExpected)
        && near(spinRect.height, contract.spinSizeExpected);
    }, mobilePortraitGeometryContract, { timeout: startupTimeoutMs });
    const mobileGeometry = await page.evaluate(() => {
      const frame = document.querySelector('[data-role="frame"]');
      const spin = document.querySelector('[data-role="spin-dock"]');
      if (!(frame instanceof HTMLElement) || !(spin instanceof HTMLElement)) return null;
      const frameRect = frame.getBoundingClientRect();
      const spinRect = spin.getBoundingClientRect();
      return {
        designHeight: Number(frame.dataset.designHeight),
        designWidth: Number(frame.dataset.designWidth),
        frameBottom: frameRect.bottom,
        frameHeight: frameRect.height,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        frameScale: Number(frame.dataset.frameScale),
        frameTop: frameRect.top,
        frameWidth: frameRect.width,
        spinBottom: spinRect.bottom,
        spinHeight: spinRect.height,
        spinLeft: spinRect.left,
        spinRight: spinRect.right,
        spinTop: spinRect.top,
        spinWidth: spinRect.width,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
      };
    });
    const mobileTolerance = mobilePortraitGeometryContract.tolerance;
    if (!mobileGeometry
      || mobileGeometry.viewportWidth !== mobilePortraitGeometryContract.viewportWidth
      || mobileGeometry.viewportHeight !== mobilePortraitGeometryContract.viewportHeight
      || !nearExpected(
        mobileGeometry.designWidth,
        mobilePortraitGeometryContract.designWidth,
        0.001,
      )
      || !nearExpected(
        mobileGeometry.designHeight,
        mobilePortraitGeometryContract.designHeight,
        0.001,
      )
      || !nearExpected(
        mobileGeometry.frameScale,
        mobilePortraitGeometryContract.frameScaleExpected,
        0.001,
      )
      || mobileGeometry.frameBottom < mobilePortraitGeometryContract.frameBottomMinimum
      || !nearExpected(
        mobileGeometry.frameBottom,
        mobilePortraitGeometryContract.frameBottomExpected,
        mobileTolerance,
      )
      || !nearExpected(mobileGeometry.frameLeft, 0, mobileTolerance)
      || !nearExpected(mobileGeometry.frameTop, 0, mobileTolerance)
      || !nearExpected(
        mobileGeometry.frameRight,
        mobilePortraitGeometryContract.viewportWidth,
        mobileTolerance,
      )
      || !nearExpected(
        mobileGeometry.frameWidth,
        mobilePortraitGeometryContract.viewportWidth,
        mobileTolerance,
      )
      || !nearExpected(
        mobileGeometry.frameHeight,
        mobilePortraitGeometryContract.viewportHeight,
        mobileTolerance,
      )
      || mobileGeometry.spinBottom < mobilePortraitGeometryContract.spinBottomMinimum
      || !nearExpected(
        mobileGeometry.spinBottom,
        mobilePortraitGeometryContract.spinBottomExpected,
        mobileTolerance,
      )
      || !nearExpected(
        mobileGeometry.spinTop,
        mobilePortraitGeometryContract.spinTopExpected,
        mobileTolerance,
      )
      || !nearExpected(
        mobileGeometry.spinWidth,
        mobilePortraitGeometryContract.spinSizeExpected,
        mobileTolerance,
      )
      || !nearExpected(
        mobileGeometry.spinHeight,
        mobilePortraitGeometryContract.spinSizeExpected,
        mobileTolerance,
      )) {
      throw new Error(`${browserName} 的 390x844 移动根投影或 Spin 底边偏离审核几何：${JSON.stringify(mobileGeometry)}`);
    }

    await page.locator('[data-role="paytable"]').click();
    await page.waitForFunction(() => (
      document.querySelector('[data-role="game-menu"]')?.getAttribute("data-open") === "true"
    ), undefined, { timeout: startupTimeoutMs });
    const paytableBottom = await measureStablePaytableBottom(page, browserName);
    if (!paytableBottom
      || !paytableBottom.geometryStable
      || !paytableBottom.scrollable
      || paytableBottom.maximumScrollTop <= 0
      || !["auto", "scroll"].includes(paytableBottom.scrollContainerOverflowY)
      || !paytableBottom.lastVisible
      || Math.abs(paytableBottom.scrollTop - paytableBottom.maximumScrollTop) > 2) {
      throw new Error(`${browserName} 的说明页最下方边缘不可达：${JSON.stringify(paytableBottom)}`);
    }
    requireNoFailures(runtimeErrors, transportErrors, browserName);
    const startupFailureShells = await verifyStartupFailureShells(
      browser,
      browserName,
      pageOrigin,
    );
    return Object.freeze({
      browser: browserName,
      canvas: initialCanvas,
      cspViolationCount: cspViolations.length,
      renderingMode: renderingContract.renderingMode,
      mobileBottomContained: true,
      mobileBottomGeometry: Object.freeze({
        frameBottom: mobileGeometry.frameBottom,
        frameScale: mobileGeometry.frameScale,
        spinBottom: mobileGeometry.spinBottom,
        spinHeight: mobileGeometry.spinHeight,
      }),
      paytableBottomReachable: true,
      startupFailureShells,
      transaction: Object.freeze({
        acknowledgementCount: transactionEvidence.acknowledgementCount,
        exchangeCount: transactionEvidence.exchangeCount,
        order: transactionEvidence.order,
        spinCount: transactionEvidence.spinCount,
      }),
    });
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function verifyStartupFailureShells(browser, browserName, pageOrigin) {
  const unsupported = await verifyFixedStartupFailure({
    browser,
    browserName,
    expectedMessage:
      "This browser cannot run the game. Update Chrome, Edge, Firefox, or Safari and enable WebGL.",
    expectedStage: "unsupported-browser",
    pageOrigin,
    setup: async (context) => {
      await context.addInitScript(() => {
        const originalSupports = CSS.supports.bind(CSS);
        Object.defineProperty(CSS, "supports", {
          configurable: true,
          value: (property, value) => property === "container-type"
            ? false
            : originalSupports(property, value),
        });
      });
    },
    blockMainModule: false,
    blockPreflight: false,
    removeInlineScrub: false,
  });
  const moduleFailure = await verifyFixedStartupFailure({
    browser,
    browserName,
    expectedMessage: "The game could not start. Please try again.",
    expectedStage: "bootstrap-failed",
    pageOrigin,
    setup: async () => undefined,
    blockMainModule: true,
    blockPreflight: false,
    removeInlineScrub: false,
  });
  const preflightFailure = await verifyFixedStartupFailure({
    browser,
    browserName,
    expectedMessage: "The game could not start. Please try again.",
    expectedStage: "bootstrap-failed",
    pageOrigin,
    setup: async () => undefined,
    blockMainModule: false,
    blockPreflight: true,
    removeInlineScrub: false,
  });
  const inlineScrubFailure = await verifyFixedStartupFailure({
    browser,
    browserName,
    expectedMessage: "The game could not start. Please try again.",
    expectedStage: "bootstrap-failed",
    pageOrigin,
    setup: async () => undefined,
    blockMainModule: false,
    blockPreflight: false,
    removeInlineScrub: true,
  });
  return Object.freeze({
    inlineScrubFailure,
    moduleFailure,
    preflightFailure,
    unsupported,
  });
}

async function verifyFixedStartupFailure({
  browser,
  browserName,
  expectedMessage,
  expectedStage,
  pageOrigin,
  setup,
  blockMainModule,
  blockPreflight,
  removeInlineScrub,
}) {
  let context = null;
  try {
    context = await browser.newContext({ viewport: { width: 1_024, height: 640 } });
    const page = await context.newPage();
    const launchCode = `lc_failure_${browserName}_${expectedStage}`;
    const operatorId = `operator_failure_${browserName}_${expectedStage}`;
    const sessionId = `session_failure_${browserName}_${expectedStage}`;
    const credentialNeedles = [
      { label: "launch-value", value: launchCode },
      { label: "operator-value", value: operatorId },
      { label: "session-value", value: sessionId },
      { label: "launch-key", value: "rgsLaunchCode" },
      { label: "operator-key", value: "rgsOperatorId" },
      { label: "session-key", value: "rgsSessionId" },
    ];
    const rgsOrigin = new URL(browserRgsBaseUrl).origin;
    const rgsRequests = [];
    const mainModuleRequests = [];
    const preflightRequests = [];
    let inlineScrubRemovalCount = 0;
    const credentialLeakSourceSet = new Set();
    const diagnosticEventCounts = {
      console: 0,
      crash: 0,
      pageerror: 0,
      requestfailed: 0,
      weberror: 0,
    };
    const scanDiagnosticChannel = (channel, values) => {
      diagnosticEventCounts[channel] += 1;
      recordCredentialLeakLabels(
        credentialLeakSourceSet,
        channel,
        values,
        credentialNeedles,
      );
    };
    page.on("request", (request) => {
      const requestUrl = request.url();
      if (new URL(requestUrl).origin === rgsOrigin) rgsRequests.push(requestUrl);
      if (/\/assets\/main-[^/]+\.js(?:\?.*)?$/u.test(requestUrl)) {
        mainModuleRequests.push(requestUrl);
      }
      if (/\/browser-preflight\.js(?:\?.*)?$/u.test(requestUrl)) {
        preflightRequests.push(requestUrl);
      }
    });
    page.on("console", (message) => {
      scanDiagnosticChannel("console", [message.text(), message.location()?.url]);
    });
    page.on("pageerror", (error) => {
      scanDiagnosticChannel("pageerror", errorDiagnosticValues(error));
    });
    page.on("requestfailed", (request) => {
      scanDiagnosticChannel("requestfailed", [
        request.url(),
        request.failure()?.errorText,
      ]);
    });
    page.on("crash", () => {
      diagnosticEventCounts.crash += 1;
    });
    context.on("weberror", (webError) => {
      scanDiagnosticChannel("weberror", [
        ...errorDiagnosticValues(webError.error()),
        webError.page()?.url(),
      ]);
    });
    await setup(context);
    if (removeInlineScrub) {
      await page.route((url) => (
        url.origin === pageOrigin && url.pathname === "/"
      ), async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        const scrubPattern = /<script id="launch-fragment-scrub">[\s\S]*?<\/script>/gu;
        const matches = [...html.matchAll(scrubPattern)];
        if (matches.length !== 1
          || !html.includes("browser-preflight.js")
          || !html.includes('type="module"')) {
          throw new Error("生产 HTML 内联清理器移除场景没有命中唯一审核入口");
        }
        const strippedHtml = html.replace(scrubPattern, "");
        if (strippedHtml.includes('id="launch-fragment-scrub"')
          || !strippedHtml.includes("browser-preflight.js")
          || !strippedHtml.includes('type="module"')) {
          throw new Error("生产 HTML 内联清理器移除场景改变了外部启动入口");
        }
        inlineScrubRemovalCount += 1;
        await route.fulfill({ response, body: strippedHtml });
      });
    }
    if (blockMainModule) {
      await page.route(/\/assets\/main-[^/]+\.js(?:\?.*)?$/u, (route) => route.abort("failed"));
    }
    if (blockPreflight) {
      await page.route(/\/browser-preflight\.js(?:\?.*)?$/u, (route) => route.abort("failed"));
    }
    const pageUrl = `${pageOrigin}/?channel=desktop#${new URLSearchParams({
      rgsLaunchCode: launchCode,
      rgsOperatorId: operatorId,
      rgsSessionId: sessionId,
    })}`;
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: startupTimeoutMs });
    await page.waitForFunction((stage) => (
      document.querySelector('[data-role="launch-loading"]')?.getAttribute("data-stage") === stage
    ), expectedStage, { timeout: startupTimeoutMs });
    const shell = await page.evaluate(() => {
      const root = document.querySelector("#app");
      const loading = document.querySelector('[data-role="launch-loading"]');
      const status = loading?.querySelector(".launch-loading__status");
      const track = loading?.querySelector(".launch-loading__track");
      if (!(root instanceof HTMLElement)
        || !(loading instanceof HTMLElement)
        || !(status instanceof HTMLElement)
        || !(track instanceof HTMLElement)) return null;
      const statusStyle = getComputedStyle(status);
      const loadingStyle = getComputedStyle(loading);
      const statusRect = status.getBoundingClientRect();
      const inspectHandoff = (globalName, takeName, expectedKeys) => {
        const descriptor = Object.getOwnPropertyDescriptor(window, globalName);
        const value = window[globalName];
        if (value === undefined) return { locked: false, state: "missing" };
        if (value === null || typeof value !== "object"
          || !descriptor || descriptor.configurable || descriptor.enumerable || descriptor.writable
          || !Object.isFrozen(value)
          || Object.keys(value).length !== expectedKeys.length
          || expectedKeys.some((key) => !Object.hasOwn(value, key))
          || typeof value[takeName] !== "function") {
          return { locked: false, state: "invalid" };
        }
        let handoff;
        try {
          handoff = value[takeName]();
          return { locked: true, state: handoff === null ? "exhausted" : "available" };
        } catch {
          return { locked: true, state: "invalid" };
        } finally {
          handoff = null;
        }
      };
      const earlyHandoff = inspectHandoff(
        "__slotsEarlyLaunchHandoff",
        "take",
        ["schema", "hadLaunchHandoff", "take"],
      );
      const browserHandoff = inspectHandoff(
        "__slotsBrowserPreflight",
        "takeLaunchHandoff",
        ["schema", "supported", "hadLaunchHandoff", "takeLaunchHandoff"],
      );
      return {
        bodyText: document.body.textContent ?? "",
        browserHandoff,
        browserCompatibility: root.dataset.browserCompatibility ?? null,
        canvasCount: document.querySelectorAll("canvas").length,
        earlyHandoff,
        hash: location.hash,
        loadingOpacity: loadingStyle.opacity,
        message: status.textContent,
        stage: loading.dataset.stage ?? null,
        statusClipPath: statusStyle.clipPath,
        statusDisplay: statusStyle.display,
        statusHeight: statusRect.height,
        statusVisibility: statusStyle.visibility,
        statusWidth: statusRect.width,
        trackDisplay: getComputedStyle(track).display,
      };
    });
    const expectedCompatibility = expectedStage === "unsupported-browser"
      ? "unsupported"
      : "bootstrap-failed";
    recordCredentialLeakLabels(
      credentialLeakSourceSet,
      "hash",
      [shell?.hash],
      credentialNeedles,
    );
    recordCredentialLeakLabels(
      credentialLeakSourceSet,
      "body",
      [shell?.bodyText],
      credentialNeedles,
    );
    const credentialLeakSources = [...credentialLeakSourceSet].sort();
    const credentialLeak = credentialLeakSources.length > 0;
    const earlyHandoffStateAccepted = removeInlineScrub
      ? shell?.earlyHandoff?.state === "missing"
      : shell?.earlyHandoff?.locked === true
        && shell.earlyHandoff.state === "exhausted";
    const browserHandoffStateAccepted = blockPreflight
      ? shell?.browserHandoff?.state === "missing"
      : shell?.browserHandoff?.locked === true
        && shell.browserHandoff.state === "exhausted";
    const expectedRequestFailedCount = Number(blockMainModule) + Number(blockPreflight);
    if (!shell
      || shell.stage !== expectedStage
      || shell.browserCompatibility !== expectedCompatibility
      || shell.message !== expectedMessage
      || shell.hash !== ""
      || credentialLeak
      || !earlyHandoffStateAccepted
      || !browserHandoffStateAccepted
      || diagnosticEventCounts.crash !== 0
      || diagnosticEventCounts.pageerror !== 0
      || diagnosticEventCounts.requestfailed !== expectedRequestFailedCount
      || diagnosticEventCounts.weberror !== 0
      || shell.loadingOpacity !== "1"
      || shell.statusDisplay === "none"
      || shell.statusVisibility === "hidden"
      || shell.statusClipPath !== "none"
      || shell.statusWidth < 160
      || shell.statusHeight < 20
      || shell.trackDisplay !== "none"
      || shell.canvasCount !== 0
      || rgsRequests.length !== 0
      || preflightRequests.length !== 1
      || inlineScrubRemovalCount !== Number(removeInlineScrub)
      || (blockMainModule ? mainModuleRequests.length !== 1 : mainModuleRequests.length !== 0)) {
      throw new Error(
        `${browserName}/${expectedStage} 固定失败外壳不合格：${JSON.stringify({
          credentialLeak,
          credentialLeakSources,
          diagnosticEventCounts,
          inlineScrubRemovalCount,
          mainModuleRequestCount: mainModuleRequests.length,
          preflightRequestCount: preflightRequests.length,
          rgsRequestCount: rgsRequests.length,
          shell: shell && {
            ...shell,
            bodyText: shell.bodyText === expectedMessage ? expectedMessage : "[unexpected-redacted]",
            hash: shell.hash === "" ? "" : "[present-redacted]",
          },
        })}`,
      );
    }
    return Object.freeze({
      mainModuleRequestCount: mainModuleRequests.length,
      browserHandoffExhausted: true,
      browserPreflightPresent: !blockPreflight,
      diagnosticEventCounts: Object.freeze({ ...diagnosticEventCounts }),
      earlyHandoffState: removeInlineScrub ? "missing" : "exhausted",
      inlineScrubRemovalCount,
      messageVisible: true,
      noRgsRequest: true,
      preflightRequestCount: preflightRequests.length,
      stage: expectedStage,
    });
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function requireNoFailures(runtimeErrors, transportErrors, browserName) {
  if (runtimeErrors.length > 0 || transportErrors.length > 0) {
    throw new Error(`${browserName} 跨浏览器运行失败：${JSON.stringify({
      runtimeErrors: runtimeErrors.slice(0, 8),
      transportErrors: transportErrors.slice(0, 8),
    })}`);
  }
}

function nearExpected(actual, expected, tolerance) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

async function measureStablePaytableBottom(page, browserName) {
  try {
    await page.waitForFunction(() => {
      const menu = document.querySelector('[data-role="game-menu"]');
      const panel = document.querySelector('[data-menu-panel="paytable"]');
      const scrollContainer = document.querySelector(".game-menu__content");
      const viewport = document.querySelector('[data-role="presentation-rules-content"]');
      const projection = document.querySelector('[data-role="official-help-projection"]');
      const sections = document.querySelector('[data-role="official-help-sections"]');
      const last = sections?.lastElementChild;
      if (!(menu instanceof HTMLElement)
        || !(panel instanceof HTMLElement)
        || !(scrollContainer instanceof HTMLElement)
        || !(viewport instanceof HTMLElement)
        || !(projection instanceof HTMLElement)
        || !(last instanceof HTMLElement)
        || menu.dataset.open !== "true"
        || panel.hidden
        || viewport.hidden) return false;
      const containerRect = scrollContainer.getBoundingClientRect();
      const projectionRect = projection.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const scale = Number(projection.dataset.scaleY);
      return scrollContainer.clientWidth > 0
        && scrollContainer.clientHeight > 0
        && scrollContainer.scrollHeight > scrollContainer.clientHeight
        && containerRect.width > 0
        && containerRect.height > 0
        && projectionRect.width > 0
        && projectionRect.height > scrollContainer.clientHeight
        && Number.isFinite(scale)
        && scale > 0
        && lastRect.bottom > containerRect.bottom;
    }, undefined, { timeout: startupTimeoutMs });
  } catch {
    const diagnostic = await page.evaluate(() => {
      const menu = document.querySelector('[data-role="game-menu"]');
      const panel = document.querySelector('[data-menu-panel="paytable"]');
      const scrollContainer = document.querySelector(".game-menu__content");
      const viewport = document.querySelector('[data-role="presentation-rules-content"]');
      const projection = document.querySelector('[data-role="official-help-projection"]');
      const sections = document.querySelector('[data-role="official-help-sections"]');
      return {
        containerClientHeight: scrollContainer instanceof HTMLElement
          ? scrollContainer.clientHeight
          : null,
        containerScrollHeight: scrollContainer instanceof HTMLElement
          ? scrollContainer.scrollHeight
          : null,
        lastElementPresent: sections?.lastElementChild instanceof HTMLElement,
        menuOpen: menu instanceof HTMLElement && menu.dataset.open === "true",
        panelVisible: panel instanceof HTMLElement && !panel.hidden,
        projectionHeight: projection instanceof HTMLElement
          ? projection.getBoundingClientRect().height
          : null,
        projectionScale: projection instanceof HTMLElement
          ? Number(projection.dataset.scaleY) || null
          : null,
        viewportVisible: viewport instanceof HTMLElement && !viewport.hidden,
      };
    });
    throw new Error(
      `${browserName} 的说明页未形成稳定可滚布局：${JSON.stringify(diagnostic)}`,
    );
  }

  return page.evaluate(async () => {
    const scrollContainer = document.querySelector(".game-menu__content");
    const viewport = document.querySelector('[data-role="presentation-rules-content"]');
    const projection = document.querySelector('[data-role="official-help-projection"]');
    const sections = document.querySelector('[data-role="official-help-sections"]');
    const last = sections?.lastElementChild;
    if (!(scrollContainer instanceof HTMLElement)
      || !(viewport instanceof HTMLElement)
      || !(projection instanceof HTMLElement)
      || !(last instanceof HTMLElement)) return null;

    const nextFrame = () => new Promise((resolvePromise) => {
      requestAnimationFrame(() => resolvePromise(undefined));
    });
    const geometry = () => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const projectionRect = projection.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return {
        clientHeight: scrollContainer.clientHeight,
        clientWidth: scrollContainer.clientWidth,
        containerBottom: containerRect.bottom,
        containerHeight: containerRect.height,
        containerTop: containerRect.top,
        projectionHeight: projectionRect.height,
        projectionWidth: projectionRect.width,
        scrollHeight: scrollContainer.scrollHeight,
        viewportHeight: viewportRect.height,
        viewportWidth: viewportRect.width,
      };
    };
    const sameGeometry = (left, right) => Object.keys(left).every((key) => (
      Number.isFinite(left[key])
        && Number.isFinite(right[key])
        && Math.abs(left[key] - right[key]) <= 0.25
    ));

    let previous = geometry();
    let stableFrames = 0;
    let observedFrames = 0;
    while (observedFrames < 12 && stableFrames < 2) {
      await nextFrame();
      observedFrames += 1;
      const current = geometry();
      stableFrames = sameGeometry(previous, current) ? stableFrames + 1 : 0;
      previous = current;
    }
    const geometryStable = stableFrames >= 2;
    if (geometryStable) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await nextFrame();
      await nextFrame();
    }

    const finalGeometry = geometry();
    const lastRect = last.getBoundingClientRect();
    const maximumScrollTop = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    );
    return {
      containerClientHeight: finalGeometry.clientHeight,
      containerScrollHeight: finalGeometry.scrollHeight,
      geometryStable,
      lastBottom: lastRect.bottom,
      lastVisible: lastRect.bottom <= finalGeometry.containerBottom + 2
        && lastRect.bottom >= finalGeometry.containerTop - 2,
      maximumScrollTop,
      observedFrames,
      projectionHeight: finalGeometry.projectionHeight,
      projectionScale: Number(projection.dataset.scaleY),
      scrollContainerBottom: finalGeometry.containerBottom,
      scrollContainerOverflowY: getComputedStyle(scrollContainer).overflowY,
      scrollTop: scrollContainer.scrollTop,
      scrollable: maximumScrollTop > 0,
    };
  });
}

function errorDiagnosticValues(error) {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? [error] : [];
  }
  const values = [error.name, error.message, error.stack];
  if (typeof error.cause === "string") values.push(error.cause);
  else if (error.cause && typeof error.cause === "object") {
    values.push(error.cause.name, error.cause.message, error.cause.stack);
  }
  return values;
}

function recordCredentialLeakLabels(target, channel, values, needles) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const { label, value: needle } of needles) {
      if (value.includes(needle)) target.add(`${channel}:${label}`);
    }
  }
}

async function waitForAcknowledgedTransaction(
  transaction,
  runtimeErrors,
  transportErrors,
  browserName,
) {
  const deadline = Date.now() + startupTimeoutMs;
  let snapshot = transaction.snapshot();
  while (Date.now() < deadline && snapshot.acknowledgementCount !== 1) {
    requireNoFailures(runtimeErrors, transportErrors, browserName);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    snapshot = transaction.snapshot();
  }
  return snapshot;
}

async function waitForFeaturePreviewReady(page, browserName, runtimeErrors, transportErrors) {
  let outcome = null;
  let timeoutCause = null;
  try {
    const handle = await page.waitForFunction(() => {
      const button = document.querySelector('[data-role="preview-continue"]');
      const previewVisible = document.querySelector('[data-role="feature-preview"]')
        ?.getAttribute("data-visible") === "true";
      if (button instanceof HTMLButtonElement && !button.disabled && previewVisible) return "ready";
      if (document.querySelector('[data-role="overlay"]')?.getAttribute("data-launch") === "failed") {
        return "failed";
      }
      return null;
    }, undefined, { timeout: featurePreviewStartupTimeoutMs });
    outcome = await handle.jsonValue();
  } catch (error) {
    timeoutCause = error;
  }
  if (outcome === "ready") return;
  const diagnostic = await page.evaluate(() => {
    const root = document.querySelector("#app");
    const images = Array.from(root?.querySelectorAll("img") ?? []);
    const safeAssetName = (image) => {
      try {
        const parsed = new URL(image.currentSrc || image.src, location.href);
        if (parsed.origin !== location.origin || parsed.search || parsed.hash) return "[noncanonical]";
        const basename = parsed.pathname.split("/").at(-1) ?? "";
        return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(basename)
          ? basename
          : "[noncanonical]";
      } catch {
        return "[noncanonical]";
      }
    };
    return {
      cspViolationCount: globalThis.__slotsContentSecurityPolicyProbe?.violations?.length ?? null,
      domImages: {
        complete: images.filter((image) => image.complete).length,
        naturalSize: images.filter((image) => image.naturalWidth > 0).length,
        total: images.length,
        unavailableAssets: images
          .filter((image) => !image.complete || image.naturalWidth <= 0)
          .map(safeAssetName)
          .slice(0, 16),
      },
      domReadiness: root instanceof HTMLElement ? {
        completed: root.dataset.startupDomImageCompleted ?? null,
        errorClass: root.dataset.startupDomImageErrorClass ?? null,
        state: root.dataset.startupDomImageState ?? null,
        total: root.dataset.startupDomImageTotal ?? null,
      } : null,
      fontStatus: document.fonts?.status ?? null,
      launchPhase: document.querySelector('[data-role="overlay"]')?.getAttribute("data-launch")
        ?? null,
      readinessProgress: root instanceof HTMLElement
        ? root.dataset.startupReadinessProgress ?? null
        : null,
      readinessStage: root instanceof HTMLElement
        ? root.dataset.startupReadinessStage ?? null
        : null,
    };
  });
  throw new Error(
    `${browserName} 的生产 Feature Preview 未在 ${featurePreviewStartupTimeoutMs}ms 内就绪：`
      + JSON.stringify({
        ...diagnostic,
        runtimeErrorCount: runtimeErrors.length,
        transportErrorCount: transportErrors.length,
      }),
    timeoutCause ? { cause: timeoutCause } : undefined,
  );
}

async function waitForReady(page) {
  await page.waitForFunction(() => {
    const frame = document.querySelector('[data-role="frame"]');
    const overlay = document.querySelector('[data-role="overlay"]');
    const spin = document.querySelector('[data-role="spin"]');
    return frame instanceof HTMLElement
      && overlay instanceof HTMLElement
      && spin instanceof HTMLButtonElement
      && overlay.dataset.launch === "ready"
      && frame.dataset.reelState === "Idle"
      && spin.dataset.mode === "ready"
      && spin.dataset.action === "spin"
      && !spin.disabled;
  }, undefined, { timeout: startupTimeoutMs });
}

function createDistributionServer() {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
      const candidate = resolve(distributionRoot, `.${requestedPath}`);
      const candidateRelative = relative(distributionRoot, candidate);
      if (candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const filePath = await realpath(candidate);
      const fileRelative = relative(distributionRealRoot, filePath);
      if (fileRelative === ".." || fileRelative.startsWith(`..${sep}`)) {
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

function listenOnLoopback(serverValue) {
  return new Promise((resolvePromise, rejectPromise) => {
    serverValue.once("error", rejectPromise);
    serverValue.listen(0, "127.0.0.1", () => {
      serverValue.off("error", rejectPromise);
      resolvePromise(serverValue.address());
    });
  });
}

function closeServer(serverValue) {
  if (!serverValue.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    serverValue.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    serverValue.closeIdleConnections?.();
  });
}
