import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "@playwright/test";
import { build as buildVite } from "vite";

import {
  BASE_CONTENT_SECURITY_POLICY,
  CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE,
  verifyBaseContentSecurityPolicy,
} from "../../deploy/web/content-security-policy.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionFixturePath = resolve(webRoot, "dist", "visual-fixtures.html");
const startupTimeoutMs = 45_000;
const scenarioDeadlineMs = 90_000;
const browserDeadlineMs = 15 * 60_000;
const maximumBrowserBudgetMs = 20 * 60_000;
const geometryToleranceCssPixels = 0.75;
const supportedBrowsers = Object.freeze(["chromium", "firefox", "webkit", "msedge"]);
const evidenceScope = "presentation-only-no-rgs-settlement";
const minimumRenderedPngBytes = 5_000;
const browserTargets = Object.freeze([
  "chrome111",
  "edge111",
  "firefox114",
  "safari16.4",
  "ios16.4",
]);
verifyBaseContentSecurityPolicy(BASE_CONTENT_SECURITY_POLICY);
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

// 这些仅是确定性的表现层夹具：不会调用 RGS 或权威 RNG、扣减钱包，也不能证明数据库结算。
// 输出证据必须始终保留这一边界。
const featureScenarios = Object.freeze([
  Object.freeze({
    capability: "big-win",
    scenario: "big-win",
    motion: "normal",
    expectedRounds: 1,
    requiredStages: Object.freeze([
      "big-win.show",
      "big-win.count-start",
      "big-win.count-end",
      "big-win.hide-start",
      "big-win.complete",
    ]),
    requiredEvents: Object.freeze([]),
    requiredMilestones: Object.freeze([]),
    requiredFeatureModes: Object.freeze([]),
    expectedCapCloseCount: 0,
    expectedSummaryCloseCount: 0,
    renderCheckpoints: Object.freeze([
      Object.freeze({
        source: "stage",
        value: "big-win.count-start",
        requiredVisualId: "win.big",
        roi: "big-win-authored-panel",
        region: Object.freeze({ x: 0.25, y: 0.12, width: 0.5, height: 0.66 }),
        visibleElement: Object.freeze({ role: "spin", action: "fast-stop", mode: "continue" }),
        requireTemporalChange: true,
      }),
    ]),
  }),
  Object.freeze({
    capability: "wheel",
    scenario: "wheel-mini-flow",
    motion: "normal",
    expectedRounds: 1,
    requiredStages: Object.freeze([]),
    requiredEvents: Object.freeze(["wheel.awarded"]),
    requiredMilestones: Object.freeze([
      "wheel.popup-input-ready",
      "wheel.input-ready",
      "wheel.spin-start",
      "wheel.spin-finish",
      "wheel.summary-input-ready",
      "wheel.bonus-label-ready",
    ]),
    requiredFeatureModes: Object.freeze([]),
    expectedCapCloseCount: 0,
    expectedSummaryCloseCount: 0,
    renderCheckpoints: Object.freeze([
      Object.freeze({
        source: "milestone",
        value: "wheel.input-ready",
        requiredVisualId: "wheel.ready",
        roi: "wheel-ready-panel",
        region: Object.freeze({ x: 0.24, y: 0.1, width: 0.52, height: 0.7 }),
        visibleElement: Object.freeze({ role: "spin", action: "wheel-spin", mode: "ready" }),
      }),
      Object.freeze({
        source: "milestone",
        value: "wheel.spin-start",
        requiredVisualId: "wheel.spin",
        roi: "wheel-spinning-panel",
        region: Object.freeze({ x: 0.24, y: 0.1, width: 0.52, height: 0.7 }),
        visibleElement: Object.freeze({
          role: "spin",
          action: "wheel-quick-stop",
          mode: "continue",
        }),
        requireTemporalChange: true,
      }),
      Object.freeze({
        source: "milestone",
        value: "wheel.summary-input-ready",
        requiredVisualId: "wheel.summary",
        roi: "wheel-summary-panel",
        region: Object.freeze({ x: 0.28, y: 0.16, width: 0.44, height: 0.58 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "continue" }),
      }),
    ]),
  }),
  Object.freeze({
    capability: "king",
    scenario: "king-flow",
    motion: "normal",
    expectedRounds: 9,
    requiredStages: Object.freeze([]),
    requiredEvents: Object.freeze([
      "wheel.awarded",
      "free_spins.started",
      "vault.unlocked",
      "vault.upgraded",
      "free_spins.completed",
    ]),
    requiredMilestones: Object.freeze([
      "wheel.spin-start",
      "free-spins.input-ready",
      "vault.mutation-barrier-complete",
      "free-spins.summary-input-ready",
      "free-spins.exit-started",
    ]),
    requiredFeatureModes: Object.freeze(["overdrive"]),
    expectedCapCloseCount: 0,
    expectedSummaryCloseCount: 1,
    renderCheckpoints: Object.freeze([
      Object.freeze({
        source: "milestone",
        value: "free-spins.input-ready",
        requiredVisualId: "free-spin.intro.king",
        roi: "king-free-spin-intro",
        region: Object.freeze({ x: 0.15, y: 0.08, width: 0.7, height: 0.76 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "ready" }),
        requireTemporalChange: true,
      }),
      Object.freeze({
        source: "milestone",
        value: "free-spins.summary-input-ready",
        requiredVisualId: "free-spin.summary",
        roi: "king-free-spin-summary",
        region: Object.freeze({ x: 0.25, y: 0.14, width: 0.5, height: 0.64 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "continue" }),
      }),
    ]),
  }),
  Object.freeze({
    capability: "kong",
    scenario: "kong-flow",
    motion: "normal",
    expectedRounds: 10,
    requiredStages: Object.freeze([]),
    requiredEvents: Object.freeze([
      "free_spins.started",
      "grid.expanded",
      "free_spin.awarded",
      "free_spins.completed",
    ]),
    requiredMilestones: Object.freeze([
      "wheel.spin-start",
      "free-spins.input-ready",
      "kong.rows-8-settled",
      "vault.mutation-barrier-complete",
      "free-spins.summary-input-ready",
      "free-spins.exit-started",
    ]),
    requiredFeatureModes: Object.freeze(["expansion"]),
    expectedCapCloseCount: 0,
    expectedSummaryCloseCount: 1,
    renderCheckpoints: Object.freeze([
      Object.freeze({
        source: "milestone",
        value: "free-spins.input-ready",
        requiredVisualId: "free-spin.intro.kong",
        roi: "kong-free-spin-intro",
        region: Object.freeze({ x: 0.15, y: 0.08, width: 0.7, height: 0.76 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "ready" }),
        requireTemporalChange: true,
      }),
      Object.freeze({
        source: "milestone",
        value: "free-spins.summary-input-ready",
        requiredVisualId: "free-spin.summary",
        roi: "kong-free-spin-summary",
        region: Object.freeze({ x: 0.25, y: 0.14, width: 0.5, height: 0.64 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "continue" }),
      }),
    ]),
  }),
  Object.freeze({
    capability: "free-spins",
    scenario: "cap-summary",
    motion: "normal",
    expectedRounds: 9,
    requiredStages: Object.freeze([]),
    requiredEvents: Object.freeze([
      "free_spin.cap_reached",
      "free_spins.completed",
    ]),
    requiredMilestones: Object.freeze([
      "free-spin-cap.input-ready",
      "free-spins.summary-input-ready",
      "free-spins.exit-started",
    ]),
    requiredFeatureModes: Object.freeze(["expansion"]),
    expectedCapCloseCount: 1,
    expectedSummaryCloseCount: 1,
    renderCheckpoints: Object.freeze([
      Object.freeze({
        source: "milestone",
        value: "free-spin-cap.input-ready",
        requiredVisualId: null,
        roi: "free-spin-cap-notice",
        region: Object.freeze({ x: 0.24, y: 0.14, width: 0.52, height: 0.64 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "continue" }),
      }),
      Object.freeze({
        source: "milestone",
        value: "free-spins.summary-input-ready",
        requiredVisualId: "free-spin.summary",
        roi: "free-spin-cap-summary",
        region: Object.freeze({ x: 0.25, y: 0.14, width: 0.5, height: 0.64 }),
        visibleElement: Object.freeze({ role: "spin", action: "continue", mode: "continue" }),
        requireTemporalChange: true,
      }),
    ]),
  }),
]);

// 核心玩法均跑真实 normal-motion；额外保留一条明确标识的 reduced-motion 可访问性证据。
const reducedMotionEvidenceContract = Object.freeze({
  ...requireFeatureScenario("big-win"),
  capability: "big-win-reduced-motion",
  motion: "reduced",
  renderCheckpoints: Object.freeze(requireFeatureScenario("big-win").renderCheckpoints.map(
    (checkpoint) => Object.freeze({ ...checkpoint, requireTemporalChange: false }),
  )),
});

const desktopSurface = Object.freeze({
  channel: null,
  expectedProfile: "desktop",
  expectedFrame: responsiveLayoutExpectedFrame({ width: 1_440, height: 900 }, "desktop"),
  id: "desktop-1440x900",
  viewport: Object.freeze({ width: 1_440, height: 900 }),
});
const phonePortraitSurface = Object.freeze({
  channel: "mobile",
  expectedProfile: "phone-pt",
  expectedFrame: responsiveLayoutExpectedFrame({ width: 390, height: 844 }, "mobile"),
  id: "mobile-390x844",
  viewport: Object.freeze({ width: 390, height: 844 }),
});
const tabletLandscapeSurface = Object.freeze({
  channel: "mobile",
  expectedProfile: "tablet-ls",
  expectedFrame: responsiveLayoutExpectedFrame({ width: 1_024, height: 768 }, "mobile"),
  id: "tablet-1024x768",
  viewport: Object.freeze({ width: 1_024, height: 768 }),
});
const scenarioRuns = Object.freeze([
  ...featureScenarios.map((contract) => Object.freeze({ contract, surface: desktopSurface })),
  Object.freeze({ contract: reducedMotionEvidenceContract, surface: desktopSurface }),
  Object.freeze({ contract: requireFeatureScenario("king"), surface: phonePortraitSurface }),
  Object.freeze({ contract: requireFeatureScenario("kong"), surface: tabletLandscapeSurface }),
]);
const maximumBrowserScenarioBudgetMs = scenarioRuns.length * scenarioDeadlineMs;
if (maximumBrowserScenarioBudgetMs >= maximumBrowserBudgetMs) {
  throw new Error("特殊玩法单浏览器最坏场景预算必须小于 20 分钟");
}
if (browserDeadlineMs >= maximumBrowserBudgetMs) {
  throw new Error("特殊玩法浏览器级墙钟截止必须小于 20 分钟总预算");
}
if (maximumBrowserScenarioBudgetMs >= browserDeadlineMs) {
  throw new Error("特殊玩法场景预算必须为浏览器级墙钟截止保留启动与清理时间");
}

const selectedBrowsers = parseSelectedBrowsers(process.argv.slice(2));
const gateStartedAt = Date.now();
await requireFixtureAbsentFromProductionDist();
const temporaryRoot = await mkdtemp(join(tmpdir(), "slots-visual-fixture-browser-"));
const fixtureDistributionRoot = resolve(temporaryRoot, "dist");
let fixtureServer = null;
const evidence = [];
try {
  await buildFixtureDistribution(fixtureDistributionRoot);
  fixtureServer = createFixtureServer(fixtureDistributionRoot);
  const port = await listenOnLoopback(fixtureServer);
  const origin = `http://127.0.0.1:${port}`;
  for (const browserName of selectedBrowsers) {
    evidence.push(await verifyBrowser(browserName, origin));
  }
} finally {
  if (fixtureServer) await closeServer(fixtureServer);
  await rm(temporaryRoot, { force: true, recursive: true });
}
await requireFixtureAbsentFromProductionDist();

process.stdout.write(
  `非生产特殊玩法表现夹具跨浏览器门禁通过：${selectedBrowsers.join(", ")}。`
  + "该证据只覆盖确定性前端表现，不覆盖 RGS、RNG、钱包或数据库结算。\n"
  + `总耗时：${Date.now() - gateStartedAt}ms。\n`
  + `证据：${JSON.stringify(evidence)}\n`,
);

function parseSelectedBrowsers(argumentsValue) {
  if (argumentsValue.length === 0) return ["chromium", "firefox", "webkit"];
  if (argumentsValue.length !== 2 || argumentsValue[0] !== "--browser") {
    throw new Error(
      "用法：verify-visual-fixture-cross-browser.mjs [--browser chromium,firefox,webkit,msedge]",
    );
  }
  const values = [...new Set(argumentsValue[1].split(",").filter(Boolean))];
  if (values.length === 0 || values.some((value) => !supportedBrowsers.includes(value))) {
    throw new Error("特殊玩法跨浏览器门禁包含不受支持的浏览器名称");
  }
  return values;
}

function requireFeatureScenario(capability) {
  const contract = featureScenarios.find((candidate) => candidate.capability === capability);
  if (!contract) throw new Error(`缺少 ${capability} 特殊玩法场景合同`);
  return contract;
}

/**
 * 独立复算 ResponsiveLayout.ts 的根投影。这里故意不读取页面自报的 style，避免
 * 错误布局同时篡改“预期值”和“实际值”而形成假阳性。
 */
function responsiveLayoutExpectedFrame(viewport, channel) {
  const width = viewport.width;
  const height = viewport.height;
  let frameWidth;
  let frameHeight;
  if (channel === "desktop") {
    const desktopAuthoredWidth = 1_200;
    const desktopAuthoredHeight = 900;
    const logicalWidth = 1_280;
    const logicalHeight = 720;
    const gameHeight = Math.min(
      height,
      width * (desktopAuthoredHeight / desktopAuthoredWidth),
    );
    const scale = gameHeight / logicalHeight;
    frameWidth = logicalWidth * scale;
    frameHeight = gameHeight;
  } else {
    const mobileDesignLongEdge = 844;
    const rawAspect = width / height;
    const aspect = Math.max(9 / 22, Math.min(22 / 9, rawAspect));
    const designWidth = aspect <= 1 ? mobileDesignLongEdge * aspect : mobileDesignLongEdge;
    const designHeight = aspect <= 1 ? mobileDesignLongEdge : mobileDesignLongEdge / aspect;
    const scale = Math.min(width / designWidth, height / designHeight);
    frameWidth = designWidth * scale;
    frameHeight = designHeight * scale;
  }
  const left = (width - frameWidth) / 2;
  const top = (height - frameHeight) / 2;
  return Object.freeze({
    bottom: top + frameHeight,
    height: frameHeight,
    left,
    right: left + frameWidth,
    top,
    width: frameWidth,
  });
}

function requireExpectedSurfaceGeometry(actual, surface, browserName, scenario) {
  const expected = surface.expectedFrame;
  const deltas = Object.freeze({
    bottom: actual.frameBottom - expected.bottom,
    height: actual.frameHeight - expected.height,
    left: actual.frameLeft - expected.left,
    overlayBottom: actual.overlayBottom - expected.bottom,
    overlayTop: actual.overlayTop - expected.top,
    right: actual.frameRight - expected.right,
    top: actual.frameTop - expected.top,
    width: actual.frameWidth - expected.width,
  });
  if (Object.values(deltas).some((delta) => (
    !Number.isFinite(delta) || Math.abs(delta) > geometryToleranceCssPixels
  ))) {
    throw new Error(
      `${browserName}/${scenario}@${surface.id} 未匹配 ResponsiveLayout 预期几何：`
      + `${JSON.stringify({ actual, deltas, expected, tolerance: geometryToleranceCssPixels })}`,
    );
  }
}

async function requireFixtureAbsentFromProductionDist() {
  try {
    await access(productionFixturePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("非生产 visual-fixtures.html 禁止进入生产 dist");
}

async function buildFixtureDistribution(outDir) {
  await buildVite({
    root: webRoot,
    configFile: false,
    logLevel: "error",
    build: {
      target: [...browserTargets],
      cssTarget: [...browserTargets],
      copyPublicDir: true,
      emptyOutDir: true,
      outDir,
      sourcemap: false,
      rolldownOptions: {
        input: resolve(webRoot, "visual-fixtures.html"),
      },
    },
  });
  await access(resolve(outDir, "visual-fixtures.html"));
}

function createFixtureServer(distributionRoot) {
  return createHttpServer(async (request, response) => {
    try {
      const pathName = decodeURIComponent(new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      ).pathname);
      const relativePath = pathName === "/"
        ? "visual-fixtures.html"
        : pathName.replace(/^\/+/, "");
      const filePath = resolve(distributionRoot, relativePath);
      const escaped = relative(distributionRoot, filePath);
      if (escaped === ".." || escaped.startsWith(`..${sep}`)) {
        response.writeHead(404, fixtureResponseHeaders("text/plain; charset=utf-8")).end();
        return;
      }
      await access(filePath);
      response.writeHead(200, fixtureResponseHeaders(
        contentTypes[extname(filePath)] ?? "application/octet-stream",
      ));
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(404, fixtureResponseHeaders("text/plain; charset=utf-8"));
        }
        response.end();
      });
      stream.pipe(response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(404, fixtureResponseHeaders("text/plain; charset=utf-8"));
      }
      response.end();
    }
  });
}

function fixtureResponseHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": BASE_CONTENT_SECURITY_POLICY,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
}

function listenOnLoopback(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => rejectPromise(error);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("视觉夹具静态服务没有可用的环回端口"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function verifyBrowser(browserName, originValue) {
  const browserStartedAt = Date.now();
  const browserType = browserName === "firefox"
    ? firefox
    : browserName === "webkit"
      ? webkit
      : chromium;
  let browser = null;
  let browserClosePromise = null;
  let deadlineExpired = false;
  let deadlineTimer = null;
  const requestBrowserClose = () => {
    if (!browser) return Promise.resolve();
    if (!browserClosePromise) {
      browserClosePromise = browser.close().catch(() => undefined);
    }
    return browserClosePromise;
  };
  const scenarioEvidence = [];
  const browserWork = (async () => {
    try {
      browser = await browserType.launch({
        headless: true,
        timeout: startupTimeoutMs,
        ...(browserName === "chromium"
          ? { channel: "chrome" }
          : browserName === "msedge"
            ? { channel: "msedge" }
            : {}),
      });
      if (deadlineExpired) {
        throw new Error(`${browserName} 在浏览器启动期间超过墙钟截止时间`);
      }
      for (const run of scenarioRuns) {
        scenarioEvidence.push(await verifyScenario(
          browser,
          browserName,
          originValue,
          run.contract,
          run.surface,
        ));
      }
      return Object.freeze({
        browser: browserName,
        evidenceScope,
        presentationFixtureOnly: true,
        audioCovered: false,
        rgsSettlementCovered: false,
        durationMs: Date.now() - browserStartedAt,
        browserDeadlineMs,
        maximumBrowserScenarioBudgetMs,
        scenarios: Object.freeze(scenarioEvidence),
      });
    } finally {
      await requestBrowserClose();
    }
  })();
  const hardDeadline = new Promise((_, rejectPromise) => {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      void requestBrowserClose();
      void browserWork.catch(() => undefined);
      rejectPromise(new Error(
        `${browserName} 超过包含浏览器启动、全部场景与清理的 ${browserDeadlineMs}ms 墙钟截止时间`,
      ));
    }, browserDeadlineMs);
  });
  try {
    return await Promise.race([browserWork, hardDeadline]);
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function verifyScenario(browser, browserName, originValue, contract, surface) {
  let context = null;
  let contextClosePromise = null;
  let deadlineExpired = false;
  let deadlineTimer = null;
  const requestContextClose = () => {
    if (!context) return Promise.resolve();
    if (!contextClosePromise) {
      contextClosePromise = context.close().catch(() => undefined);
    }
    return contextClosePromise;
  };
  const registerContext = (createdContext) => {
    context = createdContext;
    if (deadlineExpired) void requestContextClose();
  };
  const scenarioWork = (async () => {
    try {
      return await runScenario(
        browser,
        browserName,
        originValue,
        contract,
        surface,
        registerContext,
      );
    } finally {
      await requestContextClose();
    }
  })();
  const hardDeadline = new Promise((_, rejectPromise) => {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      void requestContextClose();
      void scenarioWork.catch(() => undefined);
      rejectPromise(new Error(
        `${browserName}/${contract.scenario}@${surface.id} 超过包含启动与截图的 `
        + `${scenarioDeadlineMs}ms 硬截止时间`,
      ));
    }, scenarioDeadlineMs);
  });
  try {
    return await Promise.race([scenarioWork, hardDeadline]);
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function runScenario(
  browser,
  browserName,
  originValue,
  contract,
  surface,
  registerContext,
) {
  const scenarioStartedAt = Date.now();
  process.stdout.write(`[表现夹具] ${browserName}/${contract.scenario}@${surface.id} 开始\n`);
  const context = await browser.newContext({
    hasTouch: surface.channel === "mobile",
    viewport: surface.viewport,
    reducedMotion: contract.motion === "normal" ? "no-preference" : "reduce",
  });
  registerContext(context);
  await context.addInitScript({ content: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", (error) => {
    const message = String(error?.message ?? "unknown page error");
    if (!message.startsWith("ResizeObserver loop")) runtimeErrors.push(message.slice(0, 256));
  });
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text().slice(0, 256));
  });

  const pageParameters = new URLSearchParams({ scenario: contract.scenario });
  if (surface.channel) {
    pageParameters.set("channel", surface.channel);
    pageParameters.set("layout", surface.channel);
  }
  const pageUrl = `${originValue}/visual-fixtures.html?${pageParameters}`;
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: startupTimeoutMs });
    try {
      await page.waitForFunction((expectedScope) => (
        document.body.dataset.fixtureStatus === "ready"
        && document.body.dataset.fixtureEvidenceScope === expectedScope
        && document.body.dataset.fixtureAudioCovered === "false"
      ), evidenceScope, { timeout: startupTimeoutMs });
    } catch (error) {
      const startup = await readStartupDiagnostics(page);
      throw new Error(
        `${browserName}/${contract.scenario} 启动未就绪：${JSON.stringify({
          startup,
          runtimeErrors: runtimeErrors.slice(0, 8),
        })}`,
        { cause: error },
      );
    }
    requireNoRuntimeFailures(runtimeErrors, browserName, contract.scenario);

    const initialSurface = await readInitialSurface(page);
    if (!initialSurface) {
      throw new Error(`${browserName}/${contract.scenario} 的表现夹具缺少初始画布`);
    }
    requireExpectedSurfaceGeometry(initialSurface, surface, browserName, contract.scenario);
    if (initialSurface.canvasWidth <= 0
      || initialSurface.canvasHeight <= 0
      || initialSurface.maximumTextureSize < 4_096
      || initialSurface.viewportHeight !== surface.viewport.height
      || initialSurface.viewportWidth !== surface.viewport.width
      || initialSurface.surfaceProfile !== surface.expectedProfile
      || initialSurface.launch !== "ready"
      || !Array.isArray(initialSurface.cspViolations)
      || initialSurface.cspViolations.length !== 0
      || initialSurface.prefersReducedMotion !== (contract.motion === "reduced")
      || initialSurface.visualFailureCount !== 0
      || initialSurface.visualMissingRequired !== "") {
      throw new Error(
        `${browserName}/${contract.scenario} 的表现夹具初始画布不合格：${JSON.stringify(initialSurface)}`,
      );
    }

    const renderBaselines = await captureRenderBaselines(page, contract);

    const spin = page.locator('[data-role="spin"]');
    await spin.click({ timeout: startupTimeoutMs });
    const observed = {
      stages: new Set(),
      events: new Set(),
      milestones: new Set(),
      featureModes: new Set(),
      actions: new Set(),
      renderCheckpoints: new Map(),
    };
    let finalSnapshot = null;
    let lastClickedToken = null;

    while (true) {
      const snapshot = await readScenarioSnapshot(page);
      observeSnapshot(observed, snapshot);
      requireHealthySnapshot(snapshot, runtimeErrors, browserName, contract.scenario);
      await captureNewRenderCheckpoints(
        page,
        contract,
        snapshot,
        renderBaselines,
        observed.renderCheckpoints,
        browserName,
      );

      if (snapshot.completeCount === contract.expectedRounds
        && snapshot.roundState === "complete") {
        finalSnapshot = snapshot;
        break;
      }
      if (snapshot.completeCount > contract.expectedRounds) {
        throw new Error(
          `${browserName}/${contract.scenario} 产生了夹具合同外回合：${snapshot.completeCount}`,
        );
      }

      const shouldContinue = !snapshot.spinDisabled
        && (snapshot.spinAction === "continue" || snapshot.spinAction === "wheel-spin");
      const shouldFastStopBigWin = !snapshot.spinDisabled
        && snapshot.spinAction === "fast-stop"
        && snapshot.stage === "big-win.count-start";
      if (shouldContinue || shouldFastStopBigWin) {
        const actionToken = [
          snapshot.sequence,
          snapshot.stage,
          snapshot.spinAction,
          snapshot.milestoneCount,
          snapshot.event,
        ].join(":");
        if (lastClickedToken !== actionToken) {
          const clicked = await clickCurrentPrimaryAction(page, snapshot.spinAction);
          if (clicked) {
            observed.actions.add(snapshot.spinAction);
            lastClickedToken = actionToken;
          }
        }
      }
      await page.waitForTimeout(50);
    }

    if (!finalSnapshot) {
      throw new Error(
        `${browserName}/${contract.scenario}@${surface.id} 未完成 ${contract.expectedRounds} 个表现回合`,
      );
    }
    const terminalQuiescence = await waitForTerminalVisualQuiescence(
      page,
      browserName,
      contract.scenario,
    );
    finalSnapshot = terminalQuiescence.snapshot;
    observeSnapshot(observed, finalSnapshot);
    requireHealthySnapshot(finalSnapshot, runtimeErrors, browserName, contract.scenario);
    await captureNewRenderCheckpoints(
      page,
      contract,
      finalSnapshot,
      renderBaselines,
      observed.renderCheckpoints,
      browserName,
    );
    validateScenarioEvidence(contract, observed, finalSnapshot, browserName);
    const lifecycle = await destroyFixtureDocument(page, browserName, contract.scenario);
    requireNoRuntimeFailures(runtimeErrors, browserName, contract.scenario);

    process.stdout.write(
      `[表现夹具] ${browserName}/${contract.scenario}@${surface.id} 通过（`
      + `${finalSnapshot.completeCount} 回合，`
      + `${Date.now() - scenarioStartedAt}ms）\n`,
    );

    return Object.freeze({
      capability: contract.capability,
      scenario: contract.scenario,
      surface: Object.freeze({
        actualProfile: initialSurface.surfaceProfile,
        bottomEdgeMatchesResponsiveLayout:
          Math.abs(initialSurface.frameBottom - surface.expectedFrame.bottom)
            <= geometryToleranceCssPixels,
        channel: surface.channel ?? "desktop",
        expectedFrame: surface.expectedFrame,
        expectedProfile: surface.expectedProfile,
        frame: Object.freeze({
          bottom: initialSurface.frameBottom,
          height: initialSurface.frameHeight,
          left: initialSurface.frameLeft,
          right: initialSurface.frameRight,
          top: initialSurface.frameTop,
          width: initialSurface.frameWidth,
        }),
        id: surface.id,
        viewport: Object.freeze({
          height: initialSurface.viewportHeight,
          width: initialSurface.viewportWidth,
        }),
      }),
      motion: contract.motion,
      completedRounds: finalSnapshot.completeCount,
      durationMs: Date.now() - scenarioStartedAt,
      capCloseCount: finalSnapshot.capCloseCount,
      summaryCloseCount: finalSnapshot.summaryCloseCount,
      terminalVisualQuiescenceMs: terminalQuiescence.durationMs,
      renderCheckpoints: Object.freeze([...observed.renderCheckpoints.values()]),
      lifecycle,
      WebGL: Object.freeze({
        canvasHeight: initialSurface.canvasHeight,
        canvasWidth: initialSurface.canvasWidth,
        maximumTextureSize: initialSurface.maximumTextureSize,
      }),
    });
}

function renderCheckpointKey(checkpoint) {
  return `${checkpoint.source}:${checkpoint.value}`;
}

function renderCheckpointEpoch(snapshot, checkpoint) {
  const currentCheckpointMatches = checkpoint.source === "stage"
    ? snapshot.stage === checkpoint.value
    : checkpoint.source === "milestone"
      ? snapshot.milestone === checkpoint.value
      : false;
  const requiredVisualOperations = checkpoint.requiredVisualId === null
    ? []
    : snapshot.activeVisualOperations.filter((operation) => (
      operation.startsWith(`${checkpoint.requiredVisualId}@`)
    ));
  if (!currentCheckpointMatches
    || snapshot.sequence === null
    || !Number.isInteger(snapshot.milestoneCount)
    || snapshot.milestoneCount < 0
    || (checkpoint.requiredVisualId !== null && requiredVisualOperations.length === 0)) return null;
  return Object.freeze({
    milestone: snapshot.milestone,
    milestoneCount: snapshot.milestoneCount,
    requiredVisualId: checkpoint.requiredVisualId,
    requiredVisualOperations: requiredVisualOperations.join(","),
    sequence: snapshot.sequence,
    stage: snapshot.stage,
  });
}

function sameRenderCheckpointEpoch(expected, actual) {
  return actual !== null
    && actual.milestone === expected.milestone
    && actual.milestoneCount === expected.milestoneCount
    && actual.requiredVisualId === expected.requiredVisualId
    && actual.requiredVisualOperations === expected.requiredVisualOperations
    && actual.sequence === expected.sequence
    && actual.stage === expected.stage;
}

async function captureRenderBaselines(page, contract) {
  const baselines = new Map();
  for (const checkpoint of contract.renderCheckpoints) {
    const key = renderCheckpointKey(checkpoint);
    const capture = await captureVisibleFrameRegion(page, checkpoint.region);
    requireRenderedFrameRegion(capture, "baseline", contract.scenario);
    baselines.set(key, capture);
  }
  return baselines;
}

async function captureNewRenderCheckpoints(
  page,
  contract,
  snapshot,
  baselines,
  captured,
  browserName,
) {
  for (const checkpoint of contract.renderCheckpoints) {
    const key = renderCheckpointKey(checkpoint);
    const epoch = renderCheckpointEpoch(snapshot, checkpoint);
    if (captured.has(key) || epoch === null) continue;
    const baseline = baselines.get(key);
    if (!baseline) throw new Error(`${contract.scenario}/${key} 缺少初始像素基线`);

    const current = await captureVisibleFrameRegion(
      page,
      checkpoint.region,
      baseline.png,
      checkpoint.visibleElement,
    );
    const afterCurrentCapture = await readScenarioSnapshot(page);
    const afterCurrentEpoch = renderCheckpointEpoch(afterCurrentCapture, checkpoint);
    if (!sameRenderCheckpointEpoch(epoch, afterCurrentEpoch)) {
      throw new Error(
        `${browserName}/${contract.scenario}/${key} 截图期间 checkpoint epoch 漂移：`
        + `${JSON.stringify({ before: epoch, after: afterCurrentEpoch })}`,
      );
    }
    requireRenderedFrameRegion(current, browserName, `${contract.scenario}/${key}`);
    requireVisibleCheckpointElement(current, checkpoint, browserName, `${contract.scenario}/${key}`);
    if (current.changedPixelRatio < 0.003 || current.sha256 === baseline.sha256) {
      throw new Error(
        `${browserName}/${contract.scenario}/${key} 的可见渲染区域未相对初始帧发生有效变化：`
        + `${JSON.stringify(renderCaptureEvidence(current))}`,
      );
    }

    let temporalChangedPixelRatio = null;
    if (checkpoint.requireTemporalChange === true) {
      await page.waitForTimeout(180);
      const later = await captureVisibleFrameRegion(
        page,
        checkpoint.region,
        current.png,
        checkpoint.visibleElement,
      );
      const afterLaterCapture = await readScenarioSnapshot(page);
      const afterLaterEpoch = renderCheckpointEpoch(afterLaterCapture, checkpoint);
      if (!sameRenderCheckpointEpoch(epoch, afterLaterEpoch)) {
        throw new Error(
          `${browserName}/${contract.scenario}/${key} 连续帧期间 checkpoint epoch 漂移：`
          + `${JSON.stringify({ before: epoch, after: afterLaterEpoch })}`,
        );
      }
      requireRenderedFrameRegion(later, browserName, `${contract.scenario}/${key}/later`);
      requireVisibleCheckpointElement(
        later,
        checkpoint,
        browserName,
        `${contract.scenario}/${key}/later`,
      );
      temporalChangedPixelRatio = later.changedPixelRatio;
      if (later.sha256 === current.sha256 || temporalChangedPixelRatio < 0.001) {
        throw new Error(
          `${browserName}/${contract.scenario}/${key} 未观察到 normal-motion 连续帧变化`,
        );
      }
    }

    captured.set(key, Object.freeze({
      checkpoint: key,
      epoch,
      requiredVisualId: checkpoint.requiredVisualId,
      roi: checkpoint.roi,
      changedPixelRatio: current.changedPixelRatio,
      colorBucketCount: current.colorBucketCount,
      luminanceVariance: current.luminanceVariance,
      nonBlackPixelRatio: current.nonBlackPixelRatio,
      pngBytes: current.png.length,
      pngHeight: current.pngHeight,
      pngSha256: current.sha256,
      pngWidth: current.pngWidth,
      temporalChangedPixelRatio,
      surface: current.surfaceProfile,
      visibleElement: current.visibleElement,
      visibleAreaRatio: current.visibleAreaRatio,
      viewport: Object.freeze({ height: current.viewportHeight, width: current.viewportWidth }),
    }));
  }
}

async function captureVisibleFrameRegion(
  page,
  normalizedRegion,
  baselinePng = null,
  visibleElementContract = null,
) {
  const frame = page.locator('[data-role="frame"]');
  const geometry = await frame.evaluate((element, input) => {
    if (!(element instanceof HTMLElement)) return null;
    const { region, visibleElement } = input;
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = rectangle.left + rectangle.width * region.x;
    const top = rectangle.top + rectangle.height * region.y;
    const width = rectangle.width * region.width;
    const height = rectangle.height * region.height;
    const intersectionWidth = Math.max(
      0,
      Math.min(left + width, innerWidth) - Math.max(left, 0),
    );
    const intersectionHeight = Math.max(
      0,
      Math.min(top + height, innerHeight) - Math.max(top, 0),
    );
    let visibleElementEvidence = null;
    if (visibleElement?.role === "spin") {
      const target = document.querySelector('[data-role="spin"]');
      if (target instanceof HTMLElement) {
        const targetRectangle = target.getBoundingClientRect();
        const targetStyle = getComputedStyle(target);
        const targetIntersectionWidth = Math.max(
          0,
          Math.min(targetRectangle.right, innerWidth) - Math.max(targetRectangle.left, 0),
        );
        const targetIntersectionHeight = Math.max(
          0,
          Math.min(targetRectangle.bottom, innerHeight) - Math.max(targetRectangle.top, 0),
        );
        const centerX = targetRectangle.left + targetRectangle.width / 2;
        const centerY = targetRectangle.top + targetRectangle.height / 2;
        const topmost = centerX >= 0 && centerX <= innerWidth && centerY >= 0 && centerY <= innerHeight
          ? document.elementFromPoint(centerX, centerY)
          : null;
        visibleElementEvidence = {
          action: target.dataset.action ?? null,
          centerUnoccluded: topmost !== null
            && (topmost === target || target.contains(topmost)),
          connected: target.isConnected,
          disabled: target instanceof HTMLButtonElement ? target.disabled : null,
          display: targetStyle.display,
          height: targetRectangle.height,
          hidden: target.hidden,
          left: targetRectangle.left,
          mode: target.dataset.mode ?? null,
          opacity: Number.parseFloat(targetStyle.opacity),
          pointerEvents: targetStyle.pointerEvents,
          role: target.dataset.role ?? null,
          top: targetRectangle.top,
          visibility: targetStyle.visibility,
          visibleAreaRatio: targetRectangle.width > 0 && targetRectangle.height > 0
            ? (targetIntersectionWidth * targetIntersectionHeight)
              / (targetRectangle.width * targetRectangle.height)
            : 0,
          width: targetRectangle.width,
        };
      }
    }
    return {
      clip: {
        x: left + scrollX,
        y: top + scrollY,
        width,
        height,
      },
      display: style.display,
      frameBottom: rectangle.bottom,
      frameLeft: rectangle.left,
      frameRight: rectangle.right,
      frameTop: rectangle.top,
      opacity: Number.parseFloat(style.opacity),
      surfaceProfile: element.dataset.surfaceProfile ?? null,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      visibility: style.visibility,
      visibleElement: visibleElementEvidence,
      visibleAreaRatio: width > 0 && height > 0
        ? (intersectionWidth * intersectionHeight) / (width * height)
        : 0,
    };
  }, { region: normalizedRegion, visibleElement: visibleElementContract });
  if (!geometry) throw new Error("特殊玩法表现帧不存在");
  await page.evaluate(() => new Promise((resolvePromise) => {
    requestAnimationFrame(() => requestAnimationFrame(resolvePromise));
  }));
  const png = await page.screenshot({
    animations: "allow",
    caret: "hide",
    clip: geometry.clip,
    scale: "css",
    type: "png",
  });
  const metrics = await analyzeRenderedPng(page, png, baselinePng);
  return Object.freeze({
    ...geometry,
    ...metrics,
    png,
    sha256: createHash("sha256").update(png).digest("hex"),
  });
}

async function analyzeRenderedPng(page, png, baselinePng) {
  return page.evaluate(async ({ currentBase64, baselineBase64 }) => {
    const decode = async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("PNG pixel analysis canvas is unavailable");
        context.drawImage(image, 0, 0);
        return {
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
          height: canvas.height,
          width: canvas.width,
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    const current = await decode(currentBase64);
    const baseline = baselineBase64 === null ? null : await decode(baselineBase64);
    if (baseline && (baseline.width !== current.width || baseline.height !== current.height)) {
      throw new Error("Rendered checkpoint and baseline dimensions differ");
    }
    let changed = 0;
    let luminanceSum = 0;
    let luminanceSquareSum = 0;
    let nonBlack = 0;
    const colorBuckets = new Set();
    const pixelCount = current.width * current.height;
    for (let offset = 0; offset < current.data.length; offset += 4) {
      const red = current.data[offset] ?? 0;
      const green = current.data[offset + 1] ?? 0;
      const blue = current.data[offset + 2] ?? 0;
      const alpha = current.data[offset + 3] ?? 0;
      const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
      luminanceSum += luminance;
      luminanceSquareSum += luminance * luminance;
      if (alpha >= 16 && Math.max(red, green, blue) >= 8) nonBlack += 1;
      if (colorBuckets.size < 4_096) {
        colorBuckets.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
      }
      if (baseline) {
        const delta = Math.max(
          Math.abs(red - (baseline.data[offset] ?? 0)),
          Math.abs(green - (baseline.data[offset + 1] ?? 0)),
          Math.abs(blue - (baseline.data[offset + 2] ?? 0)),
          Math.abs(alpha - (baseline.data[offset + 3] ?? 0)),
        );
        if (delta >= 16) changed += 1;
      }
    }
    const mean = pixelCount > 0 ? luminanceSum / pixelCount : 0;
    return {
      changedPixelRatio: baseline && pixelCount > 0 ? changed / pixelCount : null,
      colorBucketCount: colorBuckets.size,
      luminanceVariance: pixelCount > 0
        ? Math.max(0, (luminanceSquareSum / pixelCount) - (mean * mean))
        : 0,
      nonBlackPixelRatio: pixelCount > 0 ? nonBlack / pixelCount : 0,
      pngHeight: current.height,
      pngWidth: current.width,
    };
  }, {
    currentBase64: png.toString("base64"),
    baselineBase64: baselinePng?.toString("base64") ?? null,
  });
}

function renderCaptureEvidence(capture) {
  return {
    changedPixelRatio: capture.changedPixelRatio,
    colorBucketCount: capture.colorBucketCount,
    luminanceVariance: capture.luminanceVariance,
    nonBlackPixelRatio: capture.nonBlackPixelRatio,
    pngBytes: capture.png.length,
    pngHeight: capture.pngHeight,
    pngWidth: capture.pngWidth,
    surfaceProfile: capture.surfaceProfile,
    visibleAreaRatio: capture.visibleAreaRatio,
    visibleElement: capture.visibleElement,
    viewportHeight: capture.viewportHeight,
    viewportWidth: capture.viewportWidth,
  };
}

function requireVisibleCheckpointElement(capture, checkpoint, browserName, label) {
  const actual = capture.visibleElement;
  const expected = checkpoint.visibleElement;
  if (!actual
    || actual.role !== expected.role
    || actual.action !== expected.action
    || actual.mode !== expected.mode
    || actual.connected !== true
    || actual.disabled !== false
    || actual.hidden !== false
    || actual.display === "none"
    || actual.visibility === "hidden"
    || !Number.isFinite(actual.opacity)
    || actual.opacity <= 0
    || actual.pointerEvents === "none"
    || actual.width < 43.5
    || actual.height < 43.5
    || actual.visibleAreaRatio < 0.995
    || actual.centerUnoccluded !== true) {
    throw new Error(
      `${browserName}/${label} 的玩法主控件不可见、被遮挡或状态不匹配：`
      + `${JSON.stringify({ actual, expected, roi: checkpoint.roi })}`,
    );
  }
}

function requireRenderedFrameRegion(capture, browserName, label) {
  if (capture.display === "none"
    || capture.visibility === "hidden"
    || !Number.isFinite(capture.opacity)
    || capture.opacity <= 0
    || capture.visibleAreaRatio < 0.995
    || capture.pngWidth < 160
    || capture.pngHeight < 120
    || capture.png.length < minimumRenderedPngBytes
    || capture.nonBlackPixelRatio < 0.1
    || capture.luminanceVariance < 16
    || capture.colorBucketCount < 16) {
    throw new Error(
      `${browserName}/${label} 的实际可见像素不合格：${JSON.stringify(renderCaptureEvidence(capture))}`,
    );
  }
}

async function readInitialSurface(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-role="canvas"] canvas');
    const frame = document.querySelector('[data-role="frame"]');
    const overlay = document.querySelector('[data-role="overlay"]');
    if (!(canvas instanceof HTMLCanvasElement)
      || !(frame instanceof HTMLElement)
      || !(overlay instanceof HTMLElement)) return null;
    const webgl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const frameRectangle = frame.getBoundingClientRect();
    const overlayRectangle = overlay.getBoundingClientRect();
    return {
      audioCovered: document.body.dataset.fixtureAudioCovered ?? null,
      canvasHeight: canvas.height,
      canvasWidth: canvas.width,
      frameBottom: frameRectangle.bottom,
      frameHeight: frameRectangle.height,
      frameLeft: frameRectangle.left,
      frameRight: frameRectangle.right,
      frameTop: frameRectangle.top,
      frameWidth: frameRectangle.width,
      launch: overlay.dataset.launch ?? null,
      cspViolations: globalThis.__slotsContentSecurityPolicyProbe?.violations ?? null,
      maximumTextureSize: webgl?.getParameter(webgl.MAX_TEXTURE_SIZE) ?? 0,
      overlayBottom: overlayRectangle.bottom,
      overlayTop: overlayRectangle.top,
      prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      surfaceProfile: frame.dataset.surfaceProfile ?? null,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      visualFailureCount: Number.parseInt(
        document.body.dataset.fixtureVisualFailureCount ?? "-1",
        10,
      ),
      visualMissingRequired: document.body.dataset.fixtureVisualMissingRequired ?? null,
    };
  });
}

async function readStartupDiagnostics(page) {
  return page.evaluate(() => ({
    audioCovered: document.body.dataset.fixtureAudioCovered ?? null,
    bodyText: document.body.textContent?.trim().slice(0, 256) ?? null,
    evidenceScope: document.body.dataset.fixtureEvidenceScope ?? null,
    cspViolations: globalThis.__slotsContentSecurityPolicyProbe?.violations ?? null,
    fixtureStatus: document.body.dataset.fixtureStatus ?? null,
    fixtureStartupError: document.body.dataset.fixtureStartupError ?? null,
    launch: document.querySelector('[data-role="overlay"]')?.getAttribute("data-launch") ?? null,
    missingRequired: document.body.dataset.fixtureVisualMissingRequired ?? null,
    readyState: document.readyState,
    traceViolation: document.body.dataset.fixtureTraceViolation ?? null,
    visualFailureCode: document.body.dataset.fixtureVisualFailureCode ?? null,
    visualFailureCount: document.body.dataset.fixtureVisualFailureCount ?? null,
    visualFailureId: document.body.dataset.fixtureVisualFailureId ?? null,
  })).catch((error) => ({
    evaluationError: error instanceof Error ? error.message : String(error),
  }));
}

async function readScenarioSnapshot(page) {
  return page.evaluate(() => {
    const spin = document.querySelector('[data-role="spin"]');
    const feature = document.querySelector('[data-role="feature"]');
    return {
      capCloseCount: Number.parseInt(document.body.dataset.fixtureCapCloseCount ?? "0", 10),
      completeCount: Number.parseInt(document.body.dataset.fixtureCompleteCount ?? "0", 10),
      cspViolations: globalThis.__slotsContentSecurityPolicyProbe?.violations ?? null,
      event: document.body.dataset.fixtureEvent ?? null,
      evidenceScope: document.body.dataset.fixtureEvidenceScope ?? null,
      featureMode: feature?.getAttribute("data-mode") ?? null,
      fixtureStatus: document.body.dataset.fixtureStatus ?? null,
      milestoneCount: Number.parseInt(document.body.dataset.fixtureMilestoneCount ?? "0", 10),
      milestone: document.body.dataset.fixtureMilestone ?? null,
      milestones: document.body.dataset.fixtureMilestones?.split(",").filter(Boolean) ?? [],
      roundState: document.body.dataset.fixtureRoundState ?? null,
      sequence: document.body.dataset.fixtureSequence ?? null,
      spinAction: spin?.getAttribute("data-action") ?? null,
      spinDisabled: !(spin instanceof HTMLButtonElement) || spin.disabled,
      spinMode: spin?.getAttribute("data-mode") ?? null,
      stage: document.body.dataset.fixtureStage ?? null,
      summaryCloseCount: Number.parseInt(
        document.body.dataset.fixtureSummaryCloseCount ?? "0",
        10,
      ),
      traceViolation: document.body.dataset.fixtureTraceViolation ?? null,
      activeVisualIds:
        document.body.dataset.fixtureVisualActiveIds?.split(",").filter(Boolean) ?? [],
      activeVisualOperations:
        document.body.dataset.fixtureVisualActiveOperations?.split(",").filter(Boolean) ?? [],
      visualActiveCount: Number.parseInt(
        document.body.dataset.fixtureVisualActiveCount ?? "-1",
        10,
      ),
      visualFailureCount: Number.parseInt(
        document.body.dataset.fixtureVisualFailureCount ?? "-1",
        10,
      ),
      visualMissingRequired: document.body.dataset.fixtureVisualMissingRequired ?? null,
    };
  });
}

async function waitForTerminalVisualQuiescence(page, browserName, scenario) {
  const startedAt = Date.now();
  try {
    await page.waitForFunction(() => (
      document.body.dataset.fixtureStatus === "ready"
      && document.body.dataset.fixtureRoundState === "complete"
      && document.body.dataset.fixtureVisualActiveCount === "0"
    ), null, { polling: 16, timeout: startupTimeoutMs });
  } catch (error) {
    const snapshot = await readScenarioSnapshot(page);
    throw new Error(
      `${browserName}/${scenario} 在场景硬截止内未完成终态视觉尾段：${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  const snapshot = await readScenarioSnapshot(page);
  if (snapshot.visualActiveCount !== 0 || snapshot.activeVisualOperations.length !== 0) {
    throw new Error(
      `${browserName}/${scenario} 终态视觉静默窗口发生漂移：${JSON.stringify(snapshot)}`,
    );
  }
  return Object.freeze({
    durationMs: Date.now() - startedAt,
    snapshot,
  });
}

async function destroyFixtureDocument(page, browserName, scenario) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  await page.waitForFunction(() => document.body.dataset.fixtureStatus === "destroyed", null, {
    timeout: startupTimeoutMs,
  });
  const evidence = await page.evaluate(() => ({
    appDisposed: document.body.dataset.fixtureDestroyAppDisposed === "true",
    canvasCount: Number.parseInt(document.body.dataset.fixtureDestroyCanvasCount ?? "-1", 10),
    retainedPayloadBytes: Number.parseInt(
      document.body.dataset.fixtureDestroyRetainedPayloadBytes ?? "-1",
      10,
    ),
    spinCount: Number.parseInt(document.body.dataset.fixtureDestroySpinCount ?? "-1", 10),
    status: document.body.dataset.fixtureStatus ?? null,
    visualActiveCount: Number.parseInt(
      document.body.dataset.fixtureDestroyVisualActiveCount ?? "-1",
      10,
    ),
    liveCanvasCount: document.querySelectorAll('[data-role="canvas"] canvas').length,
    liveSpinCount: document.querySelectorAll('[data-role="spin"]').length,
  }));
  if (evidence.status !== "destroyed"
    || evidence.appDisposed !== true
    || evidence.retainedPayloadBytes !== 0
    || evidence.visualActiveCount !== 0
    || evidence.canvasCount !== 0
    || evidence.spinCount !== 0
    || evidence.liveCanvasCount !== 0
    || evidence.liveSpinCount !== 0) {
    throw new Error(
      `${browserName}/${scenario} 同文档主动销毁未释放全部夹具资源：${JSON.stringify(evidence)}`,
    );
  }
  return Object.freeze(evidence);
}

function observeSnapshot(observed, snapshot) {
  if (snapshot.stage) observed.stages.add(snapshot.stage);
  if (snapshot.event) observed.events.add(snapshot.event);
  if (snapshot.featureMode) observed.featureModes.add(snapshot.featureMode);
  for (const milestone of snapshot.milestones) observed.milestones.add(milestone);
}

function requireHealthySnapshot(snapshot, runtimeErrors, browserName, scenario) {
  requireNoRuntimeFailures(runtimeErrors, browserName, scenario);
  if (snapshot.evidenceScope !== evidenceScope
    || !Array.isArray(snapshot.cspViolations)
    || snapshot.cspViolations.length !== 0
    || snapshot.fixtureStatus === "failed"
    || snapshot.roundState === "failed"
    || snapshot.traceViolation !== null
    || snapshot.activeVisualOperations.length !== snapshot.visualActiveCount
    || snapshot.visualFailureCount !== 0
    || snapshot.visualMissingRequired !== "") {
    throw new Error(`${browserName}/${scenario} 的表现夹具失败：${JSON.stringify(snapshot)}`);
  }
}

function requireNoRuntimeFailures(runtimeErrors, browserName, scenario) {
  if (runtimeErrors.length > 0) {
    throw new Error(
      `${browserName}/${scenario} 发生浏览器运行错误：${JSON.stringify(runtimeErrors.slice(0, 8))}`,
    );
  }
}

async function clickCurrentPrimaryAction(page, expectedAction) {
  const spin = page.locator('[data-role="spin"]');
  const canClick = await spin.evaluate((element, action) => (
    element instanceof HTMLButtonElement
    && !element.disabled
    && element.dataset.action === action
  ), expectedAction).catch(() => false);
  if (!canClick) return false;
  try {
    await spin.click({ timeout: 1_500 });
    return true;
  } catch (error) {
    const stillClickable = await spin.evaluate((element, action) => (
      element instanceof HTMLButtonElement
      && !element.disabled
      && element.dataset.action === action
    ), expectedAction).catch(() => false);
    if (!stillClickable) return false;
    throw error;
  }
}

function validateScenarioEvidence(contract, observed, finalSnapshot, browserName) {
  requireObserved(contract.requiredStages, observed.stages, browserName, contract.scenario, "阶段");
  requireObserved(contract.requiredEvents, observed.events, browserName, contract.scenario, "事件");
  requireObserved(
    contract.requiredMilestones,
    observed.milestones,
    browserName,
    contract.scenario,
    "里程碑",
  );
  requireObserved(
    contract.requiredFeatureModes,
    observed.featureModes,
    browserName,
    contract.scenario,
    "玩法模式",
  );
  if (observed.renderCheckpoints.size !== contract.renderCheckpoints.length) {
    const missing = contract.renderCheckpoints
      .map(renderCheckpointKey)
      .filter((key) => !observed.renderCheckpoints.has(key));
    throw new Error(
      `${browserName}/${contract.scenario} 缺少实际像素 checkpoint：${missing.join(", ")}`,
    );
  }
  if (contract.motion === "normal" && ![...observed.renderCheckpoints.values()]
    .some((entry) => entry.temporalChangedPixelRatio !== null
      && entry.temporalChangedPixelRatio >= 0.001)) {
    throw new Error(`${browserName}/${contract.scenario} 缺少 normal-motion 连续帧像素证据`);
  }
  if (!observed.actions.has("continue") && contract.scenario !== "big-win") {
    throw new Error(`${browserName}/${contract.scenario} 未通过可操作主控件推进特殊玩法`);
  }
  if (contract.scenario === "big-win" && !observed.actions.has("fast-stop")) {
    throw new Error(`${browserName}/${contract.scenario} 未验证 Big Win 有界快停`);
  }
  if (finalSnapshot.completeCount !== contract.expectedRounds
    || finalSnapshot.capCloseCount !== contract.expectedCapCloseCount
    || finalSnapshot.summaryCloseCount !== contract.expectedSummaryCloseCount
    || finalSnapshot.roundState !== "complete"
    || finalSnapshot.spinAction !== "spin"
    || finalSnapshot.spinMode !== "ready"
    || finalSnapshot.spinDisabled
    || finalSnapshot.featureMode !== null
    || finalSnapshot.visualActiveCount !== 0) {
    throw new Error(
      `${browserName}/${contract.scenario} 的终态不符合表现夹具合同：${JSON.stringify(finalSnapshot)}`,
    );
  }
}

function requireObserved(required, observed, browserName, scenario, label) {
  const missing = required.filter((value) => !observed.has(value));
  if (missing.length > 0) {
    throw new Error(`${browserName}/${scenario} 缺少${label}：${missing.join(", ")}`);
  }
}
