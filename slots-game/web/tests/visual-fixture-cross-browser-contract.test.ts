import { describe, expect, it } from "vitest";

import workflow from "../../../.github/workflows/frontend-conformance.yml?raw";
import packageJson from "../package.json?raw";
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
    expect(workflow).toContain(
      'run: npm run test:visual-fixtures-browser-matrix -- --browser "${{ matrix.browser }}"\n',
    );
    expect(workflow).toContain(
      "run: npm run test:visual-fixtures-browser-matrix -- --browser msedge\n",
    );
    const frontendJob = workflow.slice(
      workflow.indexOf("  verify-frontend:"),
      workflow.indexOf("  verify-special-features:"),
    );
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
    expect(epochContract).toContain("snapshot.milestone === checkpoint.value");
    expect(epochContract).toContain("milestoneCount: snapshot.milestoneCount");
    expect(epochContract).toContain("snapshot.activeVisualOperations.filter");
    expect(epochContract).toContain("requiredVisualOperations: requiredVisualOperations.join");
    expect(epochContract).toContain("sequence: snapshot.sequence");
    expect(epochContract).not.toContain("milestones.includes");
    expect(captureContract).toContain("afterCurrentCapture");
    expect(captureContract).toContain("afterLaterCapture");
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
    expect(fixtureBrowserGate).toContain("const scenarioDeadlineMs = 90_000");
    expect(fixtureBrowserGate).toContain("const browserDeadlineMs = 15 * 60_000");
    expect(fixtureBrowserGate).toContain("const maximumBrowserBudgetMs = 20 * 60_000");
    expect(fixtureBrowserGate).toContain(
      "const maximumBrowserScenarioBudgetMs = scenarioRuns.length * scenarioDeadlineMs",
    );
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

  it("actively destroys the same document and requires zero retained resources", () => {
    expect(fixtureBrowserGate).toContain("const terminalQuiescence = await waitForTerminalVisualQuiescence");
    expect(fixtureBrowserGate).toContain("function waitForTerminalVisualQuiescence");
    expect(fixtureBrowserGate).toContain('fixtureVisualActiveCount === "0"');
    expect(fixtureBrowserGate).toContain("snapshot.activeVisualOperations.length !== 0");
    expect(fixtureBrowserGate).not.toContain("await page.waitForTimeout(100)");
    expect(fixtureBrowserGate).toContain("const lifecycle = await destroyFixtureDocument");
    expect(fixtureBrowserGate).toContain('window.dispatchEvent(new Event("pagehide"))');
    expect(fixtureBrowserGate).toContain('fixtureStatus === "destroyed"');
    expect(fixtureBrowserGate).toContain("evidence.retainedPayloadBytes !== 0");
    expect(fixtureBrowserGate).toContain("evidence.visualActiveCount !== 0");
    expect(fixtureBrowserGate).toContain("evidence.liveCanvasCount !== 0");
    expect(fixtureBrowserGate).toContain("evidence.liveSpinCount !== 0");
    expect(fixtureMain).toContain("fixtureDestroyRetainedPayloadBytes");
    expect(fixtureMain).toContain("fixtureDestroyVisualActiveCount");
  });

  it("advances presentation gates through Playwright user input", () => {
    const clickStart = fixtureBrowserGate.indexOf("async function clickCurrentPrimaryAction");
    const clickEnd = fixtureBrowserGate.indexOf("function validateScenarioEvidence", clickStart);
    const clickContract = fixtureBrowserGate.slice(clickStart, clickEnd);
    expect(clickContract).toContain("page.locator('[data-role=\"spin\"]')");
    expect(clickContract).toContain("await spin.click({ timeout: 1_500 })");
    expect(clickContract).not.toContain("element.click()");
    expect(fixtureBrowserGate).not.toContain("真实主控件");
  });
});
