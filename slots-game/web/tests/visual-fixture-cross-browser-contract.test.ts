// @ts-nocheck -- 浏览器门禁合同会直接执行 Node .mjs 运维辅助模块。
import { describe, expect, it } from "vitest";

import workflow from "../../../.github/workflows/frontend-conformance.yml?raw";
import packageJson from "../package.json?raw";
import {
  resolveBrowserRenderingContract,
  validateVisualFixtureTimingBudget,
} from "../scripts/browser-rendering-contract.mjs";
import {
  captureClockPastTargetMessage,
  captureClockPauseAttempts,
  captureClockPauseLeadMs,
  isRecoverableCaptureClockPastTarget,
} from "../scripts/visual-fixture-clock.mjs";
import {
  checkpointInputLeaseMatchesCurrentControl,
  renderCheckpointSignalMatches,
  validateRenderCheckpointInputLeases,
} from "../scripts/visual-fixture-checkpoint.mjs";
import fixtureBrowserGate from "../scripts/verify-visual-fixture-cross-browser.mjs?raw";
import fixtureMain from "../src/testing/visualFixturesMain.ts?raw";

describe("non-production special-feature browser fixture contract", () => {
  it("maps all required presentation capabilities to deterministic fixture scenarios", () => {
    expect(fixtureBrowserGate).toContain('capability: "big-win"');
    expect(fixtureBrowserGate).toContain('scenario: "big-win"');
    expect(fixtureBrowserGate).toContain('capability: "wheel"');
    expect(fixtureBrowserGate).toContain('scenario: "wheel-mini-flow"');
    expect(fixtureBrowserGate).toContain('capability: "king"');
    expect(fixtureBrowserGate).toContain('scenario: "king-flow"');
    expect(fixtureBrowserGate).toContain('capability: "kong"');
    expect(fixtureBrowserGate).toContain('scenario: "kong-flow"');
    expect(fixtureBrowserGate).toContain('capability: "free-spins"');
    expect(fixtureBrowserGate).toContain('scenario: "cap-summary"');
  });

  it("labels the evidence as presentation-only and refuses a production-dist fixture", () => {
    expect(fixtureMain).toContain(
      'body.dataset.fixtureEvidenceScope = "presentation-only-no-rgs-settlement"',
    );
    expect(fixtureMain).toContain('body.dataset.fixtureAudioCovered = "false"');
    expect(fixtureMain).toContain("audioManager: createPresentationOnlyFixtureAudioManager()");
    expect(fixtureBrowserGate).toContain('const evidenceScope = "presentation-only-no-rgs-settlement"');
    expect(fixtureBrowserGate).toContain("audioCovered: false");
    expect(fixtureBrowserGate).toContain("rgsSettlementCovered: false");
    expect(fixtureBrowserGate).toContain("requireFixtureAbsentFromProductionDist");
    expect(fixtureBrowserGate).toContain('resolve(webRoot, "dist", "visual-fixtures.html")');
    expect(fixtureBrowserGate).toContain('mkdtemp(join(tmpdir(), "slots-visual-fixture-browser-")');
    expect(fixtureBrowserGate).toContain("buildFixtureDistribution(fixtureDistributionRoot)");
    expect(fixtureBrowserGate).toContain('input: resolve(webRoot, "visual-fixtures.html")');
    expect(fixtureBrowserGate).not.toContain("createControlledRgsTransactionFixture");
    expect(fixtureBrowserGate).not.toContain("createViteServer");
    expect(fixtureBrowserGate).not.toContain("VITE_RGS_BASE_URL");
  });

  it("runs current Chrome, Firefox, WebKit and Edge engines from explicit CI commands", () => {
    const scripts = JSON.parse(packageJson) as { scripts: Record<string, string> };
    expect(scripts.scripts["test:visual-fixtures-browser-matrix"])
      .toBe("node scripts/verify-visual-fixture-cross-browser.mjs");
    expect(fixtureBrowserGate).toContain(
      'const supportedBrowsers = Object.freeze(["chromium", "firefox", "webkit", "msedge"]);',
    );
    expect(workflow).toContain("verify-special-features:");
    expect(workflow).toContain("name: verify-special-features (${{ matrix.browser }})");
    expect(workflow).toContain("browser: [chromium, firefox, webkit]");
    expect(workflow).toContain("timeout-minutes: 25");
    const frontendJob = workflow.slice(
      workflow.indexOf("  verify-frontend:"),
      workflow.indexOf("  verify-special-features:"),
    );
    const productionMatrixStep = frontendJob.slice(
      frontendJob.indexOf("Verify production transaction across browser engines"),
      frontendJob.indexOf("Rebuild and verify deterministic release bytes"),
    );
    expect(productionMatrixStep).toContain("SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1");
    expect(productionMatrixStep).toContain("LIBGL_ALWAYS_SOFTWARE=true");
    expect(productionMatrixStep).toContain("GALLIUM_DRIVER=llvmpipe");
    expect(productionMatrixStep).toContain("xvfb-run --auto-servernum");
    expect(productionMatrixStep).toContain("npm run build:browser-matrix");

    const specialFeatureJob = workflow.slice(
      workflow.indexOf("  verify-special-features:"),
      workflow.indexOf("  verify-edge:"),
    );
    expect(specialFeatureJob).toContain('if [[ "${{ matrix.browser }}" == "firefox" ]]');
    expect(specialFeatureJob).toContain("SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1");
    expect(specialFeatureJob).toContain("LIBGL_ALWAYS_SOFTWARE=true");
    expect(specialFeatureJob).toContain("GALLIUM_DRIVER=llvmpipe");
    expect(specialFeatureJob).toContain("xvfb-run --auto-servernum");
    expect(specialFeatureJob).toContain(
      'npm run test:visual-fixtures-browser-matrix -- --browser "${{ matrix.browser }}"',
    );
    expect(workflow).toContain(
      "run: npm run test:visual-fixtures-browser-matrix -- --browser msedge\n",
    );
    const edgeJob = workflow.slice(
      workflow.indexOf("  verify-edge:"),
      workflow.indexOf("  verify-web-static-image:"),
    );
    expect(edgeJob).toContain("timeout-minutes: 30");
    expect(frontendJob).not.toContain("test:visual-fixtures-browser-matrix");
  });

  it("uses the production-equivalent strict CSP and observes violations", () => {
    expect(fixtureBrowserGate).toContain("BASE_CONTENT_SECURITY_POLICY");
    expect(fixtureBrowserGate).toContain("CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE");
    expect(fixtureBrowserGate).toContain(
      '"Content-Security-Policy": BASE_CONTENT_SECURITY_POLICY',
    );
    expect(fixtureBrowserGate).toContain("cspViolations.length !== 0");
    expect(fixtureMain).toContain("configurePixiContentSecurityPolicy()");
    expect(fixtureMain).toContain('body.dataset.pixiCspMode = "static-uniform-sync"');
  });

  it("runs every core feature in normal motion and keeps one reduced-motion path", () => {
    expect(fixtureBrowserGate.match(/motion: "normal"/g)).toHaveLength(5);
    expect(fixtureBrowserGate).toContain("const reducedMotionEvidenceContract");
    expect(fixtureBrowserGate).toContain('capability: "big-win-reduced-motion"');
    expect(fixtureBrowserGate).toContain('motion: "reduced"');
    expect(fixtureBrowserGate).toContain('reducedMotion: contract.motion === "normal"');
    expect(fixtureBrowserGate).toContain("captureNewRenderCheckpoints(");
    expect(fixtureBrowserGate).toContain("await page.screenshot({");
    expect(fixtureBrowserGate).toContain("context.getImageData(");
    expect(fixtureBrowserGate).toContain("changedPixelRatio < 0.003");
    expect(fixtureBrowserGate).toContain("temporalChangedPixelRatio < 0.001");
    expect(fixtureBrowserGate).not.toContain("readPixels(");
    expect(fixtureBrowserGate).not.toContain("toDataURL(");
  });

  it("freezes only the real screenshot window and advances two Pixi frames on a controlled clock", () => {
    const scenarioStart = fixtureBrowserGate.indexOf("async function runScenario");
    const scenarioEnd = fixtureBrowserGate.indexOf(
      "async function captureNewRenderCheckpoints",
      scenarioStart,
    );
    const scenarioContract = fixtureBrowserGate.slice(scenarioStart, scenarioEnd);
    expect(fixtureBrowserGate).toContain("const temporalFrameAdvanceMs = 180");
    expect(scenarioContract).toContain("await page.clock.install()");
    expect(scenarioContract.indexOf("await page.clock.install()"))
      .toBeLessThan(scenarioContract.indexOf("await page.goto(pageUrl"));

    const captureStart = fixtureBrowserGate.indexOf(
      "async function captureNewRenderCheckpoints",
    );
    const captureEnd = fixtureBrowserGate.indexOf(
      "async function captureVisibleFrameRegion",
      captureStart,
    );
    const captureContract = fixtureBrowserGate.slice(captureStart, captureEnd);
    expect(fixtureBrowserGate).toContain("const capturesByRegion = new Map()");
    expect(fixtureBrowserGate).toContain("const regionKey = JSON.stringify(checkpoint.region)");
    expect(fixtureBrowserGate).toContain("capturesByRegion.set(regionKey, capture)");
    const baselineStart = fixtureBrowserGate.indexOf("async function captureRenderBaselines");
    const baselineEnd = fixtureBrowserGate.indexOf(
      "async function captureNewRenderCheckpoints",
      baselineStart,
    );
    const baselineContract = fixtureBrowserGate.slice(baselineStart, baselineEnd);
    expect(baselineContract).toContain("await pauseCaptureClock(page, runtimeErrors, captureClockConsoleGuard)");
    expect(baselineContract).toContain('controlledClockCapture ? "clock-paused" : "live"');
    expect(baselineContract).toContain("if (captureClockPaused) await page.clock.resume()");
    expect(captureClockPauseLeadMs).toBe(250);
    expect(captureClockPauseAttempts).toBe(4);
    expect(captureClockPastTargetMessage).toBe("Cannot fast-forward to the past");
    expect(scenarioContract).toContain("const controlledClockCapture = contract.renderCheckpoints.some(");
    expect(captureContract).toContain("if (controlledClockCapture) {");
    expect(captureContract).toContain(
      "await pauseCaptureClock(page, runtimeErrors, captureClockConsoleGuard)",
    );
    expect(captureContract).not.toContain("page.clock.pauseAt(Date.now()");
    expect(captureContract).toContain('controlledClockCapture ? "clock-paused" : "live"');
    expect(captureContract).toContain("await page.clock.runFor(temporalFrameAdvanceMs)");
    expect(captureContract).toContain('"clock-paused"');
    expect(captureContract).toContain("finally {");
    expect(captureContract).toContain("if (captureClockPaused) await page.clock.resume()");
    expect(captureContract).not.toContain("page.waitForTimeout(180)");
    expect(fixtureBrowserGate).toContain('frameSettleMode = "live"');
    expect(fixtureBrowserGate).toContain('frameSettleMode !== "clock-paused"');

    const pauseStart = fixtureBrowserGate.indexOf("async function pauseCaptureClock");
    const pauseEnd = fixtureBrowserGate.indexOf(
      "async function captureVisibleFrameRegion",
      pauseStart,
    );
    const pauseContract = fixtureBrowserGate.slice(pauseStart, pauseEnd);
    expect(pauseContract).toContain("attempt < captureClockPauseAttempts");
    expect(pauseContract).toContain("const pageTimeMs = await page.evaluate(() => Date.now())");
    expect(pauseContract).toContain("const pauseTargetMs = pageTimeMs + captureClockPauseLeadMs");
    expect(pauseContract).toContain("pausedPageTimeMs = await page.evaluate(() => Date.now())");
    expect(pauseContract).toContain("isRecoverableCaptureClockPastTarget(");
    expect(pauseContract).toContain("if (clockStateReadError !== null) {");
    expect(pauseContract).toContain("throw clockStateReadError");
    expect(pauseContract).not.toContain("page.evaluate(() => undefined).catch");
    expect(pauseContract).toContain("settleCaptureClockConsoleGuard(");
    expect(pauseContract.indexOf("settleCaptureClockConsoleGuard("))
      .toBeLessThan(pauseContract.indexOf("await page.clock.resume()"));
    expect(pauseContract).toContain("lastPastTargetError = pauseError");
  });

  it("distinguishes a real past target from an application timer with the same error text", () => {
    const target = 1_000;
    const directClockError = new Error(captureClockPastTargetMessage);
    const chromiumClockError = new Error(
      `clock.pauseAt: Error: ${captureClockPastTargetMessage}\n`
      + "    at ClockController._innerFastForwardTo (<anonymous>:201:13)",
    );
    const firefoxClockError = new Error(
      `clock.pauseAt: ${captureClockPastTargetMessage}\n`
      + "_innerFastForwardTo@debugger eval code:201:13\n",
    );
    const webkitClockError = new Error(`clock.pauseAt: Error: ${captureClockPastTargetMessage}`);
    expect(isRecoverableCaptureClockPastTarget(chromiumClockError, target + 100, target)).toBe(true);
    expect(isRecoverableCaptureClockPastTarget(firefoxClockError, target + 100, target)).toBe(true);
    expect(isRecoverableCaptureClockPastTarget(webkitClockError, target + 100, target)).toBe(true);

    // 应用 timer 在 pauseAt 推进到目标时刻后才抛错；同文错误也不得被恢复逻辑吞掉。
    expect(isRecoverableCaptureClockPastTarget(directClockError, target + 1, target)).toBe(false);
    expect(isRecoverableCaptureClockPastTarget(directClockError, target, target)).toBe(false);
    expect(isRecoverableCaptureClockPastTarget(chromiumClockError, target, target)).toBe(false);
    expect(isRecoverableCaptureClockPastTarget(firefoxClockError, target, target)).toBe(false);
    expect(isRecoverableCaptureClockPastTarget(directClockError, target - 1, target)).toBe(false);
    expect(isRecoverableCaptureClockPastTarget(
      new Error(`${captureClockPastTargetMessage} from application`),
      target + 1,
      target,
    )).toBe(false);
    expect(isRecoverableCaptureClockPastTarget(directClockError, Number.NaN, target)).toBe(false);
  });

  it("consumes only the one console diagnostic paired with a recovered clock error", () => {
    const scenarioStart = fixtureBrowserGate.indexOf("async function runScenario");
    const scenarioEnd = fixtureBrowserGate.indexOf(
      "async function captureNewRenderCheckpoints",
      scenarioStart,
    );
    const scenarioContract = fixtureBrowserGate.slice(scenarioStart, scenarioEnd);
    expect(scenarioContract).toContain(
      "const captureClockConsoleGuard = { active: false, bufferedMessages: [] }",
    );
    expect(scenarioContract.match(/recordFixtureRuntimeError\(/g)).toHaveLength(2);

    const guardStart = fixtureBrowserGate.indexOf("function recordFixtureRuntimeError");
    const guardEnd = fixtureBrowserGate.indexOf(
      "async function captureVisibleFrameRegion",
      guardStart,
    );
    const guardContract = fixtureBrowserGate.slice(guardStart, guardEnd);
    expect(guardContract).toContain("truncatedMessage === captureClockPastTargetMessage");
    expect(guardContract).toContain("captureClockConsoleGuard.bufferedMessages.push");
    expect(guardContract).toContain("runtimeErrors.push(truncatedMessage)");
    expect(guardContract).toContain("captureClockConsoleGuard.active = true");
    expect(guardContract).toContain("captureClockConsoleGuard.active = false");
    expect(guardContract).toContain("bufferedMessages.slice(1)");
    expect(guardContract).toContain("runtimeErrors.push(...unconsumedMessages)");
  });

  it("leases wheel input until its durable pixel checkpoint has been captured", () => {
    const checkpoint = {
      source: "milestone",
      value: "wheel.input-ready",
      captureBeforeInput: { action: "wheel-spin", mode: "ready" },
      visibleElement: { role: "spin", action: "wheel-spin", mode: "ready" },
    };
    const snapshot = {
      milestone: "wheel.bonus-label-ready",
      milestones: ["wheel.popup-input-ready", "wheel.input-ready", "wheel.bonus-label-ready"],
      spinAction: "wheel-spin",
      spinMode: "ready",
    };
    expect(checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint)).toBe(true);
    expect(renderCheckpointSignalMatches(snapshot, checkpoint)).toBe(true);
    expect(renderCheckpointSignalMatches({ ...snapshot, milestones: [] }, checkpoint)).toBe(false);
    expect(renderCheckpointSignalMatches({ ...snapshot, spinAction: "continue" }, checkpoint))
      .toBe(false);
    expect(renderCheckpointSignalMatches({ ...snapshot, spinMode: "continue" }, checkpoint))
      .toBe(false);
    expect(renderCheckpointSignalMatches(snapshot, {
      ...checkpoint,
      captureBeforeInput: undefined,
    })).toBe(false);
    expect(() => validateRenderCheckpointInputLeases([{
      scenario: "wheel-mini-flow",
      renderCheckpoints: [checkpoint],
    }])).not.toThrow();
    expect(() => validateRenderCheckpointInputLeases([{
      scenario: "wheel-mini-flow",
      renderCheckpoints: [checkpoint, { ...checkpoint, value: "wheel.other" }],
    }])).toThrow("重复的截图输入租约");
    expect(() => validateRenderCheckpointInputLeases([{
      scenario: "wheel-mini-flow",
      renderCheckpoints: [{
        ...checkpoint,
        visibleElement: { ...checkpoint.visibleElement, mode: "continue" },
      }],
    }])).toThrow("与可见控件合同不一致");
    expect(fixtureBrowserGate).toContain(
      'captureBeforeInput: Object.freeze({ action: "wheel-spin", mode: "ready" })',
    );
    expect(fixtureBrowserGate).toContain("validateRenderCheckpointInputLeases(featureScenarios)");
  });

  it("binds every rendered milestone to one stable current epoch", () => {
    const epochStart = fixtureBrowserGate.indexOf("function renderCheckpointEpoch");
    const captureStart = fixtureBrowserGate.indexOf(
      "async function captureNewRenderCheckpoints",
      epochStart,
    );
    const captureEnd = fixtureBrowserGate.indexOf(
      "async function captureVisibleFrameRegion",
      captureStart,
    );
    const epochContract = fixtureBrowserGate.slice(epochStart, captureStart);
    const captureContract = fixtureBrowserGate.slice(captureStart, captureEnd);
    expect(epochContract).toContain("renderCheckpointSignalMatches(snapshot, checkpoint)");
    expect(epochContract).toContain("milestoneCount: snapshot.milestoneCount");
    expect(epochContract).toContain("snapshot.activeVisualOperations.filter");
    expect(epochContract).toContain("requiredVisualOperations: requiredVisualOperations.join");
    expect(epochContract).toContain("sequence: snapshot.sequence");
    expect(epochContract).not.toContain("snapshot.milestones.includes");
    expect(captureContract).toContain("afterCurrentCapture");
    expect(captureContract).toContain("pausedSnapshot");
    expect(captureContract).toContain("advancedSnapshot");
    expect(captureContract).toContain("afterLaterCapture");
    expect(captureContract).toContain("sameRenderCheckpointEpoch(epoch, pausedEpoch)");
    expect(captureContract).toContain("sameRenderCheckpointEpoch(epoch, advancedEpoch)");
    expect(captureContract).toContain("sameRenderCheckpointEpoch(epoch, afterCurrentEpoch)");
    expect(captureContract).toContain("sameRenderCheckpointEpoch(epoch, afterLaterEpoch)");
    expect(captureContract).toContain("checkpoint epoch 漂移");
    expect(fixtureBrowserGate.match(/vault\.mutation-barrier-complete/g)).toHaveLength(2);
    expect(fixtureBrowserGate.match(/kong\.rows-8-settled/g)).toHaveLength(1);
  });

  it("binds each checkpoint to a feature ROI, live visual identity, and unoccluded control", () => {
    for (const visualId of [
      "win.big",
      "wheel.ready",
      "wheel.spin",
      "wheel.summary",
      "free-spin.intro.king",
      "free-spin.intro.kong",
      "free-spin.summary",
    ]) {
      expect(fixtureBrowserGate).toContain(`requiredVisualId: "${visualId}"`);
    }
    for (const roi of [
      "big-win-authored-panel",
      "wheel-ready-panel",
      "wheel-spinning-panel",
      "wheel-summary-panel",
      "king-free-spin-intro",
      "king-free-spin-summary",
      "kong-free-spin-intro",
      "kong-free-spin-summary",
      "free-spin-cap-notice",
      "free-spin-cap-summary",
    ]) {
      expect(fixtureBrowserGate).toContain(`roi: "${roi}"`);
    }
    expect(fixtureBrowserGate).toContain('requiredVisualId: null');
    expect(fixtureBrowserGate).toContain("function requireVisibleCheckpointElement");
    expect(fixtureBrowserGate).toContain("document.elementFromPoint(centerX, centerY)");
    expect(fixtureBrowserGate).toContain("actual.visibleAreaRatio < 0.995");
    expect(fixtureBrowserGate).toContain("actual.centerUnoccluded !== true");
    expect(fixtureBrowserGate).toContain("actual.action !== expected.action");
    expect(fixtureBrowserGate).toContain("actual.mode !== expected.mode");
  });

  it("adds phone/tablet runs and validates exact ResponsiveLayout geometry including the bottom", () => {
    expect(fixtureBrowserGate).toContain('id: "mobile-390x844"');
    expect(fixtureBrowserGate).toContain('viewport: Object.freeze({ width: 390, height: 844 })');
    expect(fixtureBrowserGate).toContain('expectedProfile: "phone-pt"');
    expect(fixtureBrowserGate).toContain(
      'Object.freeze({ contract: requireFeatureScenario("king"), surface: phonePortraitSurface })',
    );
    expect(fixtureBrowserGate).toContain('id: "tablet-1024x768"');
    expect(fixtureBrowserGate).toContain('viewport: Object.freeze({ width: 1_024, height: 768 })');
    expect(fixtureBrowserGate).toContain('expectedProfile: "tablet-ls"');
    expect(fixtureBrowserGate).toContain(
      'Object.freeze({ contract: requireFeatureScenario("kong"), surface: tabletLandscapeSurface })',
    );
    expect(fixtureBrowserGate).toContain("function responsiveLayoutExpectedFrame");
    expect(fixtureBrowserGate).toContain("function requireExpectedSurfaceGeometry");
    expect(fixtureBrowserGate).toContain("geometryToleranceCssPixels = 0.75");
    expect(fixtureBrowserGate).toContain("bottomEdgeMatchesResponsiveLayout:");
    expect(fixtureBrowserGate).toContain("actual.frameBottom - expected.bottom");
    expect(fixtureBrowserGate).toContain("overlayBottom: actual.overlayBottom - expected.bottom");
    expect(fixtureBrowserGate).not.toContain("initialSurface.frameBottom > surface.viewport.height + 1");
    expect(fixtureBrowserGate).toContain("surface: current.surfaceProfile");
    expect(fixtureBrowserGate).toContain(
      "viewport: Object.freeze({ height: current.viewportHeight, width: current.viewportWidth })",
    );
  });

  it("enforces scenario and browser wall-clock deadlines below the CI budget", () => {
    expect(fixtureBrowserGate).toContain("const screenshotTimeoutMs = 90_000");
    expect(fixtureBrowserGate).toContain("const defaultScenarioDeadlineMs = 120_000");
    expect(fixtureBrowserGate).toContain("const extendedScenarioDeadlineMs = 150_000");
    expect(fixtureBrowserGate).toContain("const largeScenarioDeadlineMs = 180_000");
    expect(fixtureBrowserGate).toContain("const browserDeadlineMs = 20 * 60_000");
    expect(fixtureBrowserGate).toContain("const maximumBrowserBudgetMs = 21 * 60_000");
    expect(fixtureBrowserGate).toContain(
      "const scenarioDeadlineMsByRun = Object.freeze(scenarioRuns.map(",
    );
    expect(fixtureBrowserGate).toContain("resolveScenarioDeadlineMs(contract, surface)");
    expect(fixtureBrowserGate).toContain("const maximumBrowserScenarioBudgetMs = scenarioDeadlineMsByRun.reduce(");
    expect(fixtureBrowserGate).toContain('surface.id === "desktop-1440x900"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "big-win"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "wheel-mini-flow"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "king-flow"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "kong-flow"');
    expect(fixtureBrowserGate).toContain("Promise.race([scenarioWork, hardDeadline])");
    expect(fixtureBrowserGate).toContain("deadlineExpired = true");
    expect(fixtureBrowserGate).toContain("void requestContextClose()");
    expect(fixtureBrowserGate).toContain("void scenarioWork.catch(() => undefined)");
    expect(fixtureBrowserGate).toContain("await requestContextClose()");
    expect(fixtureBrowserGate).toContain("包含启动与截图");
    expect(fixtureBrowserGate).toContain("Promise.race([browserWork, hardDeadline])");
    expect(fixtureBrowserGate).toContain("void requestBrowserClose()");
    expect(fixtureBrowserGate).toContain("await requestBrowserClose()");
    expect(fixtureBrowserGate).toContain("浏览器启动、全部场景与清理");
  });

  it("keeps slow-runner deadlines bounded and rejects budgets without cleanup headroom", () => {
    const scenarioDeadlineMsByRun = [150_000, 150_000, 180_000, 150_000,
      120_000, 150_000, 120_000, 120_000];
    const validBudget = {
      browserDeadlineMs: 20 * 60_000,
      maximumBrowserBudgetMs: 21 * 60_000,
      maximumBrowserScenarioBudgetMs: 1_140_000,
      primaryActionTimeoutMs: 5_000,
      screenshotTimeoutMs: 90_000,
      scenarioCount: 8,
      scenarioDeadlineMsByRun,
    };
    expect(validateVisualFixtureTimingBudget(validBudget))
      .toEqual({ maximumBrowserScenarioBudgetMs: 1_140_000 });
    expect(() => validateVisualFixtureTimingBudget({
      ...validBudget,
      browserDeadlineMs: 1_140_000,
    })).toThrow("必须为浏览器启动与清理保留时间");
    expect(() => validateVisualFixtureTimingBudget({
      ...validBudget,
      maximumBrowserScenarioBudgetMs: 1_140_001,
    })).toThrow("必须等于逐场景硬截止之和");
    expect(() => validateVisualFixtureTimingBudget({
      ...validBudget,
      browserDeadlineMs: 21 * 60_000,
    })).toThrow("浏览器级墙钟截止必须小于总预算");
    expect(() => validateVisualFixtureTimingBudget({
      ...validBudget,
      primaryActionTimeoutMs: 120_000,
    })).toThrow("主控件动作预算必须小于每个场景硬截止");
    expect(() => validateVisualFixtureTimingBudget({
      ...validBudget,
      screenshotTimeoutMs: 120_000,
    })).toThrow("单次截图预算必须小于每个场景硬截止");
    expect(() => validateVisualFixtureTimingBudget({
      ...validBudget,
      scenarioDeadlineMsByRun: [150_000],
    })).toThrow("逐场景硬截止必须与场景数一致");
  });

  it("requires a real Xvfb and Mesa boundary for Linux CI Firefox", () => {
    const softwareEnvironment = {
      CI: "true",
      DISPLAY: ":99",
      GALLIUM_DRIVER: "llvmpipe",
      LIBGL_ALWAYS_SOFTWARE: "true",
      SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL: "1",
    };
    expect(resolveBrowserRenderingContract({
      browserName: "firefox",
      environment: softwareEnvironment,
      platform: "linux",
    })).toEqual({
      launchOptions: {
        firefoxUserPrefs: {
          "gfx.webrender.software": true,
          "webgl.disabled": false,
          "webgl.force-enabled": true,
        },
        headless: false,
      },
      renderingMode: "linux-xvfb-mesa-llvmpipe",
    });
    expect(() => resolveBrowserRenderingContract({
      browserName: "firefox",
      environment: { CI: "true" },
      platform: "linux",
    })).toThrow("必须通过 SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL=1");
    expect(() => resolveBrowserRenderingContract({
      browserName: "firefox",
      environment: { ...softwareEnvironment, DISPLAY: "" },
      platform: "linux",
    })).toThrow("缺少 DISPLAY");
    expect(() => resolveBrowserRenderingContract({
      browserName: "firefox",
      environment: { ...softwareEnvironment, LIBGL_ALWAYS_SOFTWARE: "false" },
      platform: "linux",
    })).toThrow("LIBGL_ALWAYS_SOFTWARE=true");
    expect(() => resolveBrowserRenderingContract({
      browserName: "firefox",
      environment: { ...softwareEnvironment, GALLIUM_DRIVER: "softpipe" },
      platform: "linux",
    })).toThrow("GALLIUM_DRIVER=llvmpipe");
    expect(() => resolveBrowserRenderingContract({
      browserName: "firefox",
      environment: softwareEnvironment,
      platform: "darwin",
    })).toThrow("只允许在 Linux 启用");

    const chromium = resolveBrowserRenderingContract({
      browserName: "chromium",
      environment: softwareEnvironment,
      platform: "linux",
    });
    expect(chromium.launchOptions).toEqual({ channel: "chrome", headless: true });
    expect(chromium.renderingMode).toBe("browser-default");
    expect(fixtureBrowserGate).toContain('canvas.getContext("webgl2")');
    expect(fixtureBrowserGate).toContain("initialSurface.maximumTextureSize < 4_096");
    expect(fixtureBrowserGate).not.toContain("maximumTextureSize: 4_096");
  });

  it("actively destroys the same document and requires zero retained resources", () => {
    expect(fixtureBrowserGate).toContain("const terminalQuiescence = await waitForTerminalVisualQuiescence");
    expect(fixtureBrowserGate).toContain("function captureScenarioSnapshotInPage({ terminalOnly })");
    expect(fixtureBrowserGate).toContain("function waitForTerminalVisualQuiescence");
    expect(fixtureBrowserGate).toContain('fixtureVisualActiveCount !== "0"');
    expect(fixtureBrowserGate).toContain("snapshot.activeVisualOperations.length !== 0");
    const terminalStart = fixtureBrowserGate.indexOf(
      "async function waitForTerminalVisualQuiescence",
    );
    const terminalEnd = fixtureBrowserGate.indexOf(
      "async function destroyFixtureDocument",
      terminalStart,
    );
    const terminalContract = fixtureBrowserGate.slice(terminalStart, terminalEnd);
    expect(terminalContract).toContain("terminalSnapshotHandle = await page.waitForFunction(");
    expect(terminalContract).toContain("captureScenarioSnapshotInPage,");
    expect(terminalContract).toContain("{ terminalOnly: true },");
    expect(terminalContract).toContain("{ polling: 16, timeout: startupTimeoutMs },");
    expect(terminalContract).toContain("snapshot = await terminalSnapshotHandle.jsonValue()");
    expect(terminalContract).toContain("await terminalSnapshotHandle.dispose()");
    expect(terminalContract.match(/await readScenarioSnapshot\(page\)/g)).toHaveLength(1);
    expect(fixtureBrowserGate).not.toContain("await page.waitForTimeout(100)");
    expect(fixtureBrowserGate).toContain("const lifecycle = await destroyFixtureDocument");
    expect(fixtureBrowserGate).toContain('window.dispatchEvent(new Event("pagehide"))');
    expect(fixtureBrowserGate).toContain('fixtureStatus === "destroyed"');
    expect(fixtureBrowserGate).toContain("evidence.retainedPayloadBytes !== 0");
    expect(fixtureBrowserGate).toContain("evidence.visualActiveCount !== 0");
    expect(fixtureBrowserGate).toContain("evidence.visualProjectionActiveCount !== 0");
    expect(fixtureBrowserGate).toContain("evidence.liveCanvasCount !== 0");
    expect(fixtureBrowserGate).toContain("evidence.liveSpinCount !== 0");
    expect(fixtureMain).toContain("fixtureDestroyRetainedPayloadBytes");
    expect(fixtureMain).toContain("fixtureDestroyVisualActiveCount");
    expect(fixtureMain).toContain("fixtureDestroyVisualProjectionActiveCount");
  });

  it("advances presentation gates through Playwright user input", () => {
    const clickStart = fixtureBrowserGate.indexOf("async function clickCurrentPrimaryAction");
    const clickEnd = fixtureBrowserGate.indexOf("function validateScenarioEvidence", clickStart);
    const clickContract = fixtureBrowserGate.slice(clickStart, clickEnd);
    const scenarioStart = fixtureBrowserGate.indexOf("async function runScenario");
    const scenarioEnd = fixtureBrowserGate.indexOf("function renderCheckpointKey", scenarioStart);
    const scenarioContract = fixtureBrowserGate.slice(scenarioStart, scenarioEnd);
    expect(clickContract).toContain("page.locator('[data-role=\"spin\"]')");
    expect(fixtureBrowserGate).toContain("const primaryActionTimeoutMs = 15_000");
    expect(clickContract).toContain("await spin.click({ timeout: primaryActionTimeoutMs })");
    expect(clickContract).toContain("if (!stillClickable) return false");
    expect(clickContract).toContain("throw error");
    expect(clickContract).not.toContain("timeout: 1_500");
    expect(clickContract).not.toContain("force: true");
    expect(clickContract).not.toContain("element.click()");
    expect(clickContract).not.toContain("dispatchEvent");
    expect(fixtureBrowserGate).not.toContain("真实主控件");
    expect(scenarioContract).toContain("const pendingRenderCheckpoint = contract.renderCheckpoints.find");
    expect(scenarioContract).toContain("renderCheckpointSignalMatches(snapshot, checkpoint)");
    expect(scenarioContract).toContain("const pendingInputLeaseCheckpoint = contract.renderCheckpoints.find");
    expect(scenarioContract).toContain("checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint)");
    expect(scenarioContract).toContain("if (pendingRenderCheckpoint || pendingInputLeaseCheckpoint) {");
    expect(scenarioContract).toContain("await page.waitForTimeout(16)");
    expect(scenarioContract.indexOf("const pendingRenderCheckpoint"))
      .toBeLessThan(scenarioContract.indexOf("const shouldContinue"));
  });

  it("binds checkpoint epochs to screenshot bytes before slow pixel analysis", () => {
    const captureStart = fixtureBrowserGate.indexOf("async function captureVisibleFrameRegion");
    const captureEnd = fixtureBrowserGate.indexOf("async function analyzeRenderedPng", captureStart);
    const captureContract = fixtureBrowserGate.slice(captureStart, captureEnd);
    const screenshot = captureContract.indexOf("await page.screenshot");
    const snapshot = captureContract.indexOf("await readScenarioSnapshot(page)");
    const analysis = captureContract.indexOf("await analyzeRenderedPng(page, png, baselinePng)");
    expect(screenshot).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThan(screenshot);
    expect(analysis).toBeGreaterThan(snapshot);
    expect(captureContract).toContain("scenarioSnapshotAfterScreenshot");
    expect(captureContract).toContain("timeout: screenshotTimeoutMs");
    expect(fixtureBrowserGate).toContain("current.scenarioSnapshotAfterScreenshot");
    expect(fixtureBrowserGate).toContain("later.scenarioSnapshotAfterScreenshot");
  });
});
