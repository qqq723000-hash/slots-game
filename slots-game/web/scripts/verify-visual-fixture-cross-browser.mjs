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
import {
  resolveBrowserRenderingContract,
  validateVisualFixtureTimingBudget,
} from "./browser-rendering-contract.mjs";
import {
  captureClockPastTargetMessage,
  captureClockPauseAttempts,
  captureClockPauseLeadMs,
  isRecoverableCaptureClockPastTarget,
} from "./visual-fixture-clock.mjs";
import {
  checkpointInputLeaseMatchesCurrentControl,
  renderCheckpointSignalMatches,
  validateRenderCheckpointInputLeases,
} from "./visual-fixture-checkpoint.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionFixturePath = resolve(webRoot, "dist", "visual-fixtures.html");
const startupTimeoutMs = 45_000;
const primaryActionTimeoutMs = 15_000;
const screenshotTimeoutMs = 90_000;
const defaultScenarioDeadlineMs = 120_000;
const extendedScenarioDeadlineMs = 150_000;
const largeScenarioDeadlineMs = 180_000;
const browserDeadlineMs = 20 * 60_000;
const maximumBrowserBudgetMs = 21 * 60_000;
const temporalFrameAdvanceMs = 180;
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
        captureBeforeInput: Object.freeze({ action: "wheel-spin", mode: "ready" }),
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
validateRenderCheckpointInputLeases(featureScenarios);

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
const scenarioDeadlineMsByRun = Object.freeze(scenarioRuns.map(
  ({ contract, surface }) => resolveScenarioDeadlineMs(contract, surface),
));
const maximumBrowserScenarioBudgetMs = scenarioDeadlineMsByRun.reduce(
  (total, value) => total + value,
  0,
);
validateVisualFixtureTimingBudget({
  browserDeadlineMs,
  maximumBrowserBudgetMs,
  maximumBrowserScenarioBudgetMs,
  primaryActionTimeoutMs,
  screenshotTimeoutMs,
  scenarioCount: scenarioRuns.length,
  scenarioDeadlineMsByRun,
});

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

function resolveScenarioDeadlineMs(contract, surface) {
  if (surface.id === "desktop-1440x900" && contract.scenario === "king-flow") {
    return largeScenarioDeadlineMs;
  }
  const extendedDesktopScenario = surface.id === "desktop-1440x900"
    && (contract.scenario === "big-win"
      || contract.scenario === "wheel-mini-flow"
      || contract.scenario === "kong-flow");
  return extendedDesktopScenario ? extendedScenarioDeadlineMs : defaultScenarioDeadlineMs;
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
      const renderingContract = resolveBrowserRenderingContract({ browserName });
      browser = await browserType.launch({
        timeout: startupTimeoutMs,
        ...renderingContract.launchOptions,
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
        renderingMode: renderingContract.renderingMode,
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
  const scenarioDeadlineMs = resolveScenarioDeadlineMs(contract, surface);
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
  const controlledClockCapture = contract.renderCheckpoints.some(
    (checkpoint) => checkpoint.requireTemporalChange === true,
  );
  if (controlledClockCapture) {
    // 安装时钟后仍让页面自然运行；只在真实截图取证窗口内暂停。这样慢速软件渲染器
    // 无法让短暂表现阶段在 PNG 编码期间逃逸，同时 Node 墙钟截止仍然独立生效。
    await page.clock.install();
  }
  const runtimeErrors = [];
  const captureClockConsoleGuard = { active: false, bufferedMessages: [] };
  page.on("pageerror", (error) => {
    const message = String(error?.message ?? "unknown page error");
    if (!message.startsWith("ResizeObserver loop")) {
      recordFixtureRuntimeError(runtimeErrors, captureClockConsoleGuard, message);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      recordFixtureRuntimeError(runtimeErrors, captureClockConsoleGuard, message.text());
    }
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

    const renderBaselines = await captureRenderBaselines(
      page,
      contract,
      runtimeErrors,
      captureClockConsoleGuard,
      controlledClockCapture,
    );

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
        runtimeErrors,
        captureClockConsoleGuard,
        controlledClockCapture,
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

      // 控件与视觉遥测位于同一表现边界，但 DOM/观察器投影可能跨一个微任务。只要当前
      // milestone/stage 仍有必需截图尚未取得，就不得点击进入下一阶段；证据永远不能
      // 被测试驱动本身跳过。
      const pendingRenderCheckpoint = contract.renderCheckpoints.find((checkpoint) => (
        !observed.renderCheckpoints.has(renderCheckpointKey(checkpoint))
        && renderCheckpointSignalMatches(snapshot, checkpoint)
      ));
      const pendingInputLeaseCheckpoint = contract.renderCheckpoints.find((checkpoint) => (
        !observed.renderCheckpoints.has(renderCheckpointKey(checkpoint))
        && checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint)
      ));
      if (pendingRenderCheckpoint || pendingInputLeaseCheckpoint) {
        await page.waitForTimeout(16);
        continue;
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
      runtimeErrors,
      captureClockConsoleGuard,
      controlledClockCapture,
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
  const requiredVisualOperations = checkpoint.requiredVisualId === null
    ? []
    : snapshot.activeVisualOperations.filter((operation) => (
      operation.startsWith(`${checkpoint.requiredVisualId}@`)
    ));
  if (!renderCheckpointSignalMatches(snapshot, checkpoint)
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

async function captureRenderBaselines(
  page,
  contract,
  runtimeErrors,
  captureClockConsoleGuard,
  controlledClockCapture,
) {
  const baselines = new Map();
  const capturesByRegion = new Map();
  let captureClockPaused = false;
  try {
    if (controlledClockCapture) {
      await pauseCaptureClock(page, runtimeErrors, captureClockConsoleGuard);
      captureClockPaused = true;
    }
    for (const checkpoint of contract.renderCheckpoints) {
      const key = renderCheckpointKey(checkpoint);
      const regionKey = JSON.stringify(checkpoint.region);
      let capture = capturesByRegion.get(regionKey);
      if (!capture) {
        capture = await captureVisibleFrameRegion(
          page,
          checkpoint.region,
          null,
          null,
          false,
          controlledClockCapture ? "clock-paused" : "live",
        );
        requireRenderedFrameRegion(capture, "baseline", contract.scenario);
        capturesByRegion.set(regionKey, capture);
      }
      baselines.set(key, capture);
    }
  } finally {
    if (captureClockPaused) await page.clock.resume();
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
  runtimeErrors,
  captureClockConsoleGuard,
  controlledClockCapture,
) {
  for (const checkpoint of contract.renderCheckpoints) {
    const key = renderCheckpointKey(checkpoint);
    const epoch = renderCheckpointEpoch(snapshot, checkpoint);
    if (captured.has(key) || epoch === null) continue;
    const baseline = baselines.get(key);
    if (!baseline) throw new Error(`${contract.scenario}/${key} 缺少初始像素基线`);
    const temporalCapture = checkpoint.requireTemporalChange === true;
    let captureClockPaused = false;
    try {
      if (controlledClockCapture) {
        // 以页面自己的受控时间为基准，仅预留一次短协议往返。繁忙 runner 仍可能让
        // 目标落入过去；Playwright 此时会留下暂停时钟，因此由有界 helper 恢复后重试。
        await pauseCaptureClock(page, runtimeErrors, captureClockConsoleGuard);
        captureClockPaused = true;
        const pausedSnapshot = await readScenarioSnapshot(page);
        const pausedEpoch = renderCheckpointEpoch(pausedSnapshot, checkpoint);
        if (!sameRenderCheckpointEpoch(epoch, pausedEpoch)) {
          throw new Error(
            `${browserName}/${contract.scenario}/${key} 暂停取证时 checkpoint epoch 漂移：`
            + `${JSON.stringify({ before: epoch, after: pausedEpoch })}`,
          );
        }
      }

      const current = await captureVisibleFrameRegion(
        page,
        checkpoint.region,
        baseline.png,
        checkpoint.visibleElement,
        true,
        controlledClockCapture ? "clock-paused" : "live",
      );
      const afterCurrentCapture = current.scenarioSnapshotAfterScreenshot;
      if (afterCurrentCapture === null) {
        throw new Error(`${contract.scenario}/${key} 缺少截图时刻的 checkpoint 快照`);
      }
      const afterCurrentEpoch = renderCheckpointEpoch(afterCurrentCapture, checkpoint);
      if (!sameRenderCheckpointEpoch(epoch, afterCurrentEpoch)) {
        throw new Error(
          `${browserName}/${contract.scenario}/${key} 截图期间 checkpoint epoch 漂移：`
          + `${JSON.stringify({ before: epoch, after: afterCurrentEpoch })}`,
        );
      }
      requireRenderedFrameRegion(current, browserName, `${contract.scenario}/${key}`);
      requireVisibleCheckpointElement(
        current,
        checkpoint,
        browserName,
        `${contract.scenario}/${key}`,
      );
      if (current.changedPixelRatio < 0.003 || current.sha256 === baseline.sha256) {
        throw new Error(
          `${browserName}/${contract.scenario}/${key} 的可见渲染区域未相对初始帧发生有效变化：`
          + `${JSON.stringify(renderCaptureEvidence(current))}`,
        );
      }

      let temporalChangedPixelRatio = null;
      if (temporalCapture) {
        // 在同一暂停时钟中准确推进真实 RAF/Pixi 时间，随后再次冻结。两张截图均由
        // 浏览器生成，且仍须保持同一视觉操作、同一控件状态和有效像素变化。
        await page.clock.runFor(temporalFrameAdvanceMs);
        const advancedSnapshot = await readScenarioSnapshot(page);
        const advancedEpoch = renderCheckpointEpoch(advancedSnapshot, checkpoint);
        if (!sameRenderCheckpointEpoch(epoch, advancedEpoch)) {
          throw new Error(
            `${browserName}/${contract.scenario}/${key} 连续帧推进后 checkpoint epoch 漂移：`
            + `${JSON.stringify({ before: epoch, after: advancedEpoch })}`,
          );
        }
        const later = await captureVisibleFrameRegion(
          page,
          checkpoint.region,
          current.png,
          checkpoint.visibleElement,
          true,
          "clock-paused",
        );
        const afterLaterCapture = later.scenarioSnapshotAfterScreenshot;
        if (afterLaterCapture === null) {
          throw new Error(`${contract.scenario}/${key} 缺少连续帧时刻的 checkpoint 快照`);
        }
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
    } finally {
      if (captureClockPaused) await page.clock.resume();
    }
  }
}

async function pauseCaptureClock(page, runtimeErrors, captureClockConsoleGuard) {
  let lastPastTargetError = null;
  for (let attempt = 0; attempt < captureClockPauseAttempts; attempt += 1) {
    const pageTimeMs = await page.evaluate(() => Date.now());
    const pauseTargetMs = pageTimeMs + captureClockPauseLeadMs;
    beginCaptureClockConsoleGuard(captureClockConsoleGuard);
    let pauseError = null;
    try {
      await page.clock.pauseAt(pauseTargetMs);
    } catch (error) {
      pauseError = error;
    }
    let pausedPageTimeMs = null;
    let clockStateReadError = null;
    try {
      // 读取暂停态页面时间同时冲刷流水线，确保同步产生的 pageerror/console 已进入 guard。
      pausedPageTimeMs = await page.evaluate(() => Date.now());
    } catch (error) {
      clockStateReadError = error;
    }
    const isPastTarget = clockStateReadError === null
      && isRecoverableCaptureClockPastTarget(pauseError, pausedPageTimeMs, pauseTargetMs);
    settleCaptureClockConsoleGuard(
      captureClockConsoleGuard,
      runtimeErrors,
      isPastTarget,
    );
    if (clockStateReadError !== null) {
      await page.clock.resume();
      throw clockStateReadError;
    }
    if (pauseError === null) return;

    // pauseAt 的 past-target 分支会先暂停再抛错；必须恢复后才能从新的页面时间重试。
    await page.clock.resume();
    if (!isPastTarget) throw pauseError;
    lastPastTargetError = pauseError;
  }
  throw new Error(
    `特殊玩法截图时钟连续 ${captureClockPauseAttempts} 次无法在当前页面时刻暂停`,
    { cause: lastPastTargetError },
  );
}

function recordFixtureRuntimeError(runtimeErrors, captureClockConsoleGuard, message) {
  const truncatedMessage = String(message).slice(0, 256);
  if (captureClockConsoleGuard.active
    && truncatedMessage === captureClockPastTargetMessage) {
    captureClockConsoleGuard.bufferedMessages.push(truncatedMessage);
    return;
  }
  runtimeErrors.push(truncatedMessage);
}

function beginCaptureClockConsoleGuard(captureClockConsoleGuard) {
  if (captureClockConsoleGuard.active
    || captureClockConsoleGuard.bufferedMessages.length !== 0) {
    throw new Error("特殊玩法截图时钟控制台 guard 状态未闭合");
  }
  captureClockConsoleGuard.active = true;
}

function settleCaptureClockConsoleGuard(
  captureClockConsoleGuard,
  runtimeErrors,
  consumeExpectedPastTarget,
) {
  const bufferedMessages = captureClockConsoleGuard.bufferedMessages.splice(0);
  captureClockConsoleGuard.active = false;
  // 只消化与本次已捕获 pauseAt 异常对应的一条精确诊断；重复或无对应异常均继续失败。
  const unconsumedMessages = consumeExpectedPastTarget
    ? bufferedMessages.slice(1)
    : bufferedMessages;
  runtimeErrors.push(...unconsumedMessages);
}

async function captureVisibleFrameRegion(
  page,
  normalizedRegion,
  baselinePng = null,
  visibleElementContract = null,
  captureScenarioSnapshot = false,
  frameSettleMode = "live",
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
  if (frameSettleMode === "live") {
    await page.evaluate(() => new Promise((resolvePromise) => {
      requestAnimationFrame(() => requestAnimationFrame(resolvePromise));
    }));
  } else if (frameSettleMode !== "clock-paused") {
    throw new Error("特殊玩法截图帧栅栏模式无效");
  }
  const png = await page.screenshot({
    animations: "allow",
    caret: "hide",
    clip: geometry.clip,
    scale: "css",
    timeout: screenshotTimeoutMs,
    type: "png",
  });
  // epoch 必须绑定到浏览器真正生成截图字节的时刻。PNG 解码和逐像素分析可能在慢速
  // runner 上耗时数秒，但它只读取不可变字节，不应要求玩法 checkpoint 继续停留。
  const scenarioSnapshotAfterScreenshot = captureScenarioSnapshot
    ? await readScenarioSnapshot(page)
    : null;
  const metrics = await analyzeRenderedPng(page, png, baselinePng);
  return Object.freeze({
    ...geometry,
    ...metrics,
    png,
    scenarioSnapshotAfterScreenshot,
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

function captureScenarioSnapshotInPage({ terminalOnly }) {
  if (
    terminalOnly
    && (
      document.body.dataset.fixtureStatus !== "ready"
      || document.body.dataset.fixtureRoundState !== "complete"
      || document.body.dataset.fixtureVisualActiveCount !== "0"
    )
  ) {
    return null;
  }

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
}

async function readScenarioSnapshot(page) {
  const snapshot = await page.evaluate(
    captureScenarioSnapshotInPage,
    { terminalOnly: false },
  );
  if (snapshot === null) {
    throw new Error("非终态场景快照不得为空");
  }
  return snapshot;
}

async function waitForTerminalVisualQuiescence(page, browserName, scenario) {
  const startedAt = Date.now();
  let terminalSnapshotHandle;
  try {
    terminalSnapshotHandle = await page.waitForFunction(
      captureScenarioSnapshotInPage,
      { terminalOnly: true },
      { polling: 16, timeout: startupTimeoutMs },
    );
  } catch (error) {
    const snapshot = await readScenarioSnapshot(page);
    throw new Error(
      `${browserName}/${scenario} 在场景硬截止内未完成终态视觉尾段：${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  let snapshot;
  try {
    snapshot = await terminalSnapshotHandle.jsonValue();
  } finally {
    await terminalSnapshotHandle.dispose();
  }
  if (snapshot === null) {
    throw new Error(`${browserName}/${scenario} 原子终态视觉快照为空`);
  }
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
    visualProjectionActiveCount: Number.parseInt(
      document.body.dataset.fixtureDestroyVisualProjectionActiveCount ?? "-1",
      10,
    ),
    liveCanvasCount: document.querySelectorAll('[data-role="canvas"] canvas').length,
    liveSpinCount: document.querySelectorAll('[data-role="spin"]').length,
  }));
  if (evidence.status !== "destroyed"
    || evidence.appDisposed !== true
    || evidence.retainedPayloadBytes !== 0
    || evidence.visualActiveCount !== 0
    || evidence.visualProjectionActiveCount !== 0
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
    await spin.click({ timeout: primaryActionTimeoutMs });
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
