// @ts-nocheck -- 浏览器门禁合同会直接执行 Node .mjs 运维辅助模块。
import { describe, expect, it, vi } from "vitest";

import workflow from "../../../.github/workflows/frontend-conformance.yml?raw";
import packageJson from "../package.json?raw";
import {
  resolveBrowserRenderingContract,
  validateVisualFixtureTimingBudget,
} from "../scripts/browser-rendering-contract.mjs";
import {
  captureClockPauseAttempt,
  captureClockPauseWithAttempts,
  captureClockPastTargetMessage,
  captureClockPauseAttempts,
  captureClockPauseLeadMs,
  captureClockPauseVerificationDelayMs,
  clearCaptureClockPageGuardAfterPause,
  isRecoverableCaptureClockPastTarget,
  isStableCaptureClockPauseObservation,
} from "../scripts/visual-fixture-clock.mjs";
import {
  checkpointInputLeaseMatchesCurrentControl,
  renderCheckpointSignalMatches,
  validateRenderCheckpointInputLeases,
} from "../scripts/visual-fixture-checkpoint.mjs";
import {
  clickWithPrimaryActionLease,
  primaryActionLeaseFromSnapshot,
  primaryActionLeaseKey,
  primaryActionLeaseMatchesSnapshot,
  primaryActionLeaseSelector,
  primaryActionTrustedPointerGuardDecision,
  primaryActionTrustedPointerTarget,
} from "../scripts/visual-fixture-primary-action.mjs";
import {
  visualFixtureEventHistorySnapshotViolation,
  visualFixtureEventHistoryLimit,
} from "../scripts/visual-fixture-event-history.mjs";
import { VISUAL_FIXTURE_EVENT_HISTORY_LIMIT } from "../src/testing/visualFixtureObservation";
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
    expect(workflow).toContain("timeout-minutes: 35");
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
    expect(edgeJob).toContain("timeout-minutes: 40");
    expect(edgeJob).toContain("脚本 32 分钟硬截止");
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
    expect(captureClockPauseVerificationDelayMs).toBe(16);
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
    expect(pauseContract).toContain("await captureClockPauseWithAttempts(");
    expect(pauseContract).toContain("captureClockPauseAttempt({");
    expect(pauseContract).toContain('fixtureCaptureClockGuard = "active"');
    expect(pauseContract).toContain("clearCaptureClockPageGuardAfterPause({");
    expect(pauseContract).toContain("delete document.body.dataset.fixtureCaptureClockGuard");
    expect(pauseContract).toContain("resume: () => page.clock.resume()");
    expect(pauseContract).toContain("readPageTime: () => page.evaluate(() => Date.now())");
    expect(pauseContract).toContain("pauseAt: (pauseTargetMs) => page.clock.pauseAt(pauseTargetMs)");
    expect(pauseContract).toContain("resume: () => page.clock.resume()");
    expect(pauseContract).toContain("settleConsoleGuard:");
    expect(pauseContract).toContain("setTimeout(resolvePromise, delayMs)");
    expect(pauseContract).not.toContain("page.clock.setSystemTime");
    expect(pauseContract).not.toContain("page.clock.setFixedTime");
    expect(pauseContract).not.toContain("page.clock.fastForward");
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
    expect(isStableCaptureClockPauseObservation(target + 100, target + 100)).toBe(true);
    expect(isStableCaptureClockPauseObservation(target + 100, target + 101)).toBe(false);
    expect(isStableCaptureClockPauseObservation(Number.NaN, Number.NaN)).toBe(false);
  });

  it("deterministically closes every capture-clock pause attempt branch", async () => {
    const pastTargetError = new Error(
      `clock.pauseAt: Error: ${captureClockPastTargetMessage}`,
    );
    const stableSteps: string[] = [];
    const stableTimes = [1_000, 1_300, 1_300];
    const stableResult = await captureClockPauseAttempt({
      beginConsoleGuard: () => stableSteps.push("guard-begin"),
      pauseAt: async (target) => {
        stableSteps.push(`pause:${target}`);
        throw pastTargetError;
      },
      readPageTime: async () => {
        stableSteps.push("read");
        return stableTimes.shift();
      },
      resume: async () => stableSteps.push("resume"),
      settleConsoleGuard: (consume) => stableSteps.push(`guard-settle:${consume}`),
      waitForVerification: async (delay) => stableSteps.push(`wait:${delay}`),
    });
    expect(stableResult).toEqual({ paused: true, pastTargetError: null });
    expect(stableSteps).toEqual([
      "read",
      "guard-begin",
      "pause:1250",
      "read",
      "wait:16",
      "read",
      "guard-settle:true",
    ]);

    const normalResume = vi.fn(async () => undefined);
    const normalTimes = [1_000, 1_250];
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async (target) => expect(target).toBe(1_250),
      readPageTime: async () => normalTimes.shift(),
      resume: normalResume,
      settleConsoleGuard: (consume) => expect(consume).toBe(false),
      waitForVerification: async () => {
        throw new Error("正常暂停不得进入二次验证");
      },
    })).resolves.toEqual({ paused: true, pastTargetError: null });
    expect(normalResume).not.toHaveBeenCalled();

    const driftingSteps: string[] = [];
    const driftingTimes = [1_000, 1_300, 1_301];
    const driftingResult = await captureClockPauseAttempt({
      beginConsoleGuard: () => driftingSteps.push("guard-begin"),
      pauseAt: async () => {
        driftingSteps.push("pause");
        throw pastTargetError;
      },
      readPageTime: async () => {
        driftingSteps.push("read");
        return driftingTimes.shift();
      },
      resume: async () => driftingSteps.push("resume"),
      settleConsoleGuard: (consume) => driftingSteps.push(`guard-settle:${consume}`),
      waitForVerification: async () => driftingSteps.push("wait"),
    });
    expect(driftingResult).toEqual({ paused: false, pastTargetError });
    expect(driftingSteps.at(-2)).toBe("guard-settle:true");
    expect(driftingSteps.at(-1)).toBe("resume");

    const unknownPauseError = new Error("unrelated pause failure");
    const unknownResume = vi.fn(async () => undefined);
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async () => { throw unknownPauseError; },
      readPageTime: async () => 1_000,
      resume: unknownResume,
      settleConsoleGuard: (consume) => expect(consume).toBe(false),
      waitForVerification: async () => {
        throw new Error("非 past-target 不得进入二次验证");
      },
    })).rejects.toBe(unknownPauseError);
    expect(unknownResume).toHaveBeenCalledOnce();

    const stateReadError = new Error("paused state read failed");
    const stateReadResume = vi.fn(async () => undefined);
    let stateReadCount = 0;
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async () => undefined,
      readPageTime: async () => {
        stateReadCount += 1;
        if (stateReadCount === 1) return 1_000;
        throw stateReadError;
      },
      resume: stateReadResume,
      settleConsoleGuard: (consume) => expect(consume).toBe(false),
      waitForVerification: async () => undefined,
    })).rejects.toBe(stateReadError);
    expect(stateReadResume).toHaveBeenCalledOnce();

    const initialReadError = new Error("initial time read failed");
    const initialBegin = vi.fn();
    const initialPause = vi.fn();
    const initialResume = vi.fn();
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: initialBegin,
      pauseAt: initialPause,
      readPageTime: async () => { throw initialReadError; },
      resume: initialResume,
      settleConsoleGuard: () => undefined,
      waitForVerification: async () => undefined,
    })).rejects.toBe(initialReadError);
    expect(initialBegin).not.toHaveBeenCalled();
    expect(initialPause).not.toHaveBeenCalled();
    expect(initialResume).not.toHaveBeenCalled();

    const verificationReadError = new Error("verification read failed");
    const verificationResume = vi.fn(async () => undefined);
    const verificationTimes = [1_000, 1_300];
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async () => { throw pastTargetError; },
      readPageTime: async () => {
        const value = verificationTimes.shift();
        if (value === undefined) throw verificationReadError;
        return value;
      },
      resume: verificationResume,
      settleConsoleGuard: (consume) => expect(consume).toBe(true),
      waitForVerification: async () => undefined,
    })).rejects.toBe(verificationReadError);
    expect(verificationResume).toHaveBeenCalledOnce();

    const verificationWaitError = new Error("verification wait failed");
    const verificationWaitResume = vi.fn(async () => undefined);
    const verificationWaitTimes = [1_000, 1_300];
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async () => { throw pastTargetError; },
      readPageTime: async () => verificationWaitTimes.shift(),
      resume: verificationWaitResume,
      settleConsoleGuard: (consume) => expect(consume).toBe(true),
      waitForVerification: async () => { throw verificationWaitError; },
    })).rejects.toBe(verificationWaitError);
    expect(verificationWaitResume).toHaveBeenCalledOnce();

    const settlementError = new Error("guard settlement failed");
    const settlementResume = vi.fn(async () => undefined);
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async () => undefined,
      readPageTime: async () => 1_000,
      resume: settlementResume,
      settleConsoleGuard: () => { throw settlementError; },
      waitForVerification: async () => undefined,
    })).rejects.toBe(settlementError);
    expect(settlementResume).toHaveBeenCalledOnce();

    const resumeError = new Error("resume failed");
    await expect(captureClockPauseAttempt({
      beginConsoleGuard: () => undefined,
      pauseAt: async () => { throw unknownPauseError; },
      readPageTime: async () => 1_000,
      resume: async () => { throw resumeError; },
      settleConsoleGuard: () => undefined,
      waitForVerification: async () => undefined,
    })).rejects.toMatchObject({
      name: "AggregateError",
      errors: [unknownPauseError, resumeError],
      cause: unknownPauseError,
    });

    const guardCleanupError = new Error("guard cleanup failed");
    const successfulGuardCleanupResume = vi.fn(async () => undefined);
    await expect(clearCaptureClockPageGuardAfterPause({
      clearPageGuard: async () => undefined,
      pauseError: null,
      resume: successfulGuardCleanupResume,
    })).resolves.toBeUndefined();
    expect(successfulGuardCleanupResume).not.toHaveBeenCalled();

    const guardCleanupResume = vi.fn(async () => undefined);
    await expect(clearCaptureClockPageGuardAfterPause({
      clearPageGuard: async () => { throw guardCleanupError; },
      pauseError: null,
      resume: guardCleanupResume,
    })).rejects.toBe(guardCleanupError);
    expect(guardCleanupResume).toHaveBeenCalledOnce();

    const originalPauseError = new Error("original pause failed");
    const originalPauseResume = vi.fn(async () => undefined);
    await expect(clearCaptureClockPageGuardAfterPause({
      clearPageGuard: async () => { throw guardCleanupError; },
      pauseError: originalPauseError,
      resume: originalPauseResume,
    })).rejects.toMatchObject({
      name: "AggregateError",
      errors: [originalPauseError, guardCleanupError],
      cause: originalPauseError,
    });
    expect(originalPauseResume).not.toHaveBeenCalled();

    const guardCleanupResumeError = new Error("guard cleanup resume failed");
    await expect(clearCaptureClockPageGuardAfterPause({
      clearPageGuard: async () => { throw guardCleanupError; },
      pauseError: null,
      resume: async () => { throw guardCleanupResumeError; },
    })).rejects.toMatchObject({
      name: "AggregateError",
      errors: [guardCleanupError, guardCleanupResumeError],
      cause: guardCleanupError,
    });

    const retryErrors = Array.from(
      { length: captureClockPauseAttempts },
      (_, index) => new Error(`past target retry ${index + 1}`),
    );
    const retryAttempt = vi.fn(async () => {
      const pastTargetError = retryErrors[retryAttempt.mock.calls.length - 1];
      return { paused: false, pastTargetError };
    });
    await expect(captureClockPauseWithAttempts(retryAttempt)).rejects.toMatchObject({
      message: `特殊玩法截图时钟连续 ${captureClockPauseAttempts} 次无法在当前页面时刻暂停`,
      cause: retryErrors.at(-1),
    });
    expect(retryAttempt).toHaveBeenCalledTimes(captureClockPauseAttempts);

    const successfulAttempt = vi.fn()
      .mockResolvedValueOnce({ paused: false, pastTargetError })
      .mockResolvedValueOnce({ paused: true, pastTargetError: null });
    await expect(captureClockPauseWithAttempts(successfulAttempt)).resolves.toBeUndefined();
    expect(successfulAttempt).toHaveBeenCalledTimes(2);
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

  it("holds and releases only final free-spins summary pixel evidence", () => {
    const checkpoint = {
      source: "milestone",
      value: "free-spins.summary-input-ready",
      captureBeforeInput: { action: "continue", mode: "continue" },
      visibleElement: { role: "spin", action: "continue", mode: "continue" },
    };
    const snapshot = {
      milestone: "free-spins.exit-started",
      milestones: ["free-spins.summary-input-ready", "free-spins.exit-started"],
      spinAction: "continue",
      spinMode: "continue",
    };
    expect(checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint)).toBe(true);
    expect(renderCheckpointSignalMatches(snapshot, checkpoint)).toBe(true);
    expect(renderCheckpointSignalMatches({ ...snapshot, spinAction: "spin" }, checkpoint))
      .toBe(false);
    expect(() => validateRenderCheckpointInputLeases([{
      scenario: "king-flow",
      renderCheckpoints: [checkpoint],
    }])).not.toThrow();

    expect(fixtureBrowserGate.match(
      /captureBeforeInput: Object\.freeze\(\{ action: "continue", mode: "continue" \}\)/g,
    )).toHaveLength(3);
    expect(fixtureBrowserGate.match(
      /fixtureCheckpointHold: freeSpinsSummaryFixtureCheckpoint/g,
    )).toHaveLength(3);
    expect(fixtureBrowserGate).toContain('pageParameters.set("freeSpinsSummaryHold", "1")');
    expect(fixtureBrowserGate).toContain("async function releaseFixtureCheckpointHold(");
    const releaseHelperStart = fixtureBrowserGate.indexOf(
      "async function releaseFixtureCheckpointHold(",
    );
    const releaseHelperEnd = fixtureBrowserGate.indexOf(
      "async function pauseCaptureClock(",
      releaseHelperStart,
    );
    const releaseHelper = fixtureBrowserGate.slice(releaseHelperStart, releaseHelperEnd);
    expect(releaseHelper).toContain("state.activeCheckpoint !== expectedCheckpoint");
    expect(releaseHelper).toContain("state.releaseButtonCount !== 1");
    expect(releaseHelper).toContain('await page.keyboard.press("F8")');
    expect(releaseHelper).not.toContain("locator(");
    expect(releaseHelper).not.toContain(".click(");
    expect(releaseHelper).not.toContain("force:");
    expect(releaseHelper).not.toContain("dispatchEvent");
    expect(fixtureBrowserGate).toContain("let captureError = null");
    expect(fixtureBrowserGate).toContain("if (captureError === null && cleanupError !== null)");
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
    expect(fixtureBrowserGate).toContain("const chromiumKingScenarioDeadlineMs = 210_000");
    expect(fixtureBrowserGate).toContain("const edgeKingScenarioDeadlineMs = 240_000");
    expect(fixtureBrowserGate).toContain("const edgeDesktopKongScenarioDeadlineMs = 360_000");
    expect(fixtureBrowserGate).toContain("const slowExtendedScenarioDeadlineMs = 240_000");
    expect(fixtureBrowserGate).toContain("const slowKongScenarioDeadlineMs = 270_000");
    expect(fixtureBrowserGate).toContain("const standardBrowserDeadlineMs = 20 * 60_000");
    expect(fixtureBrowserGate).toContain("const slowBrowserDeadlineMs = 30 * 60_000");
    expect(fixtureBrowserGate).toContain("const edgeBrowserDeadlineMs = 32 * 60_000");
    expect(fixtureBrowserGate).toContain("const standardMaximumBrowserBudgetMs = 21 * 60_000");
    expect(fixtureBrowserGate).toContain("const slowMaximumBrowserBudgetMs = 31 * 60_000");
    expect(fixtureBrowserGate).toContain("const edgeMaximumBrowserBudgetMs = 33 * 60_000");
    expect(fixtureBrowserGate).toContain(
      "const browserTimingBudgets = Object.freeze(Object.fromEntries(supportedBrowsers.map(",
    );
    expect(fixtureBrowserGate).toContain(
      "resolveScenarioDeadlineMs(browserName, contract, surface)",
    );
    expect(fixtureBrowserGate).toContain("const maximumBrowserScenarioBudgetMs = scenarioDeadlineMsByRun.reduce(");
    expect(fixtureBrowserGate).toContain('browserName === "chromium" || browserName === "msedge"');
    expect(fixtureBrowserGate).toContain('const edgeBrowser = browserName === "msedge"');
    expect(fixtureBrowserGate).toContain("? edgeBrowserDeadlineMs");
    expect(fixtureBrowserGate).toContain("? edgeMaximumBrowserBudgetMs");
    expect(fixtureBrowserGate).toContain('browserName === "chromium"');
    expect(fixtureBrowserGate).toContain('browserName === "msedge"');
    expect(fixtureBrowserGate).toContain('surface.id === "desktop-1440x900"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "big-win"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "wheel-mini-flow"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "king-flow"');
    expect(fixtureBrowserGate).toContain('contract.scenario === "kong-flow"');
    const deadlineResolverStart = fixtureBrowserGate.indexOf(
      "function resolveScenarioDeadlineMs",
    );
    const deadlineResolverEnd = fixtureBrowserGate.indexOf(
      "function responsiveLayoutExpectedFrame",
      deadlineResolverStart,
    );
    const deadlineResolver = fixtureBrowserGate.slice(
      deadlineResolverStart,
      deadlineResolverEnd,
    );
    const edgeDesktopKongIndex = deadlineResolver.indexOf(
      "return edgeDesktopKongScenarioDeadlineMs",
    );
    const sharedSlowKongIndex = deadlineResolver.indexOf("return slowKongScenarioDeadlineMs");
    expect(edgeDesktopKongIndex).toBeGreaterThan(-1);
    expect(edgeDesktopKongIndex).toBeLessThan(sharedSlowKongIndex);
    expect(deadlineResolver).toContain('surface.id === "tablet-1024x768"');
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
    expect(fixtureBrowserGate).toContain(
      "timingBudget.scenarioDeadlineMsByRun[runIndex]",
    );
  });

  it("keeps slow-runner deadlines bounded and rejects budgets without cleanup headroom", () => {
    const standardScenarioDeadlineMsByRun = [150_000, 150_000, 180_000, 150_000,
      120_000, 150_000, 120_000, 120_000];
    const validBudget = {
      browserDeadlineMs: 20 * 60_000,
      maximumBrowserBudgetMs: 21 * 60_000,
      maximumBrowserScenarioBudgetMs: 1_140_000,
      primaryActionTimeoutMs: 5_000,
      screenshotTimeoutMs: 90_000,
      scenarioCount: 8,
      scenarioDeadlineMsByRun: standardScenarioDeadlineMsByRun,
    };
    expect(validateVisualFixtureTimingBudget(validBudget))
      .toEqual({ maximumBrowserScenarioBudgetMs: 1_140_000 });
    const chromiumScenarioDeadlineMsByRun = [150_000, 150_000, 210_000, 270_000,
      240_000, 150_000, 240_000, 270_000];
    expect(validateVisualFixtureTimingBudget({
      ...validBudget,
      browserDeadlineMs: 30 * 60_000,
      maximumBrowserBudgetMs: 31 * 60_000,
      maximumBrowserScenarioBudgetMs: 1_680_000,
      scenarioDeadlineMsByRun: chromiumScenarioDeadlineMsByRun,
    })).toEqual({ maximumBrowserScenarioBudgetMs: 1_680_000 });
    const edgeScenarioDeadlineMsByRun = [150_000, 150_000, 240_000, 360_000,
      240_000, 150_000, 240_000, 270_000];
    expect(edgeScenarioDeadlineMsByRun[3]).toBe(360_000);
    expect(edgeScenarioDeadlineMsByRun[7]).toBe(270_000);
    expect(validateVisualFixtureTimingBudget({
      ...validBudget,
      browserDeadlineMs: 32 * 60_000,
      maximumBrowserBudgetMs: 33 * 60_000,
      maximumBrowserScenarioBudgetMs: 1_800_000,
      scenarioDeadlineMsByRun: edgeScenarioDeadlineMsByRun,
    })).toEqual({ maximumBrowserScenarioBudgetMs: 1_800_000 });
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
    expect(fixtureBrowserGate).toContain("eventProjectionCleared:");
    expect(fixtureBrowserGate).toContain("evidence.eventProjectionCleared !== true");
    expect(fixtureBrowserGate).toContain("failureProjectionCleared:");
    expect(fixtureBrowserGate).toContain("evidence.failureProjectionCleared !== true");
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
    expect(scenarioStart).toBeGreaterThan(-1);
    expect(scenarioEnd).toBeGreaterThan(scenarioStart);
    const scenarioContract = fixtureBrowserGate.slice(scenarioStart, scenarioEnd);
    expect(fixtureBrowserGate).toContain("const primaryActionTimeoutMs = 15_000");
    expect(clickContract).toContain("clickWithPrimaryActionLease({");
    expect(clickContract).toContain("primaryActionLeaseSelector(expectedLease)");
    expect(clickContract).toContain("getBoundingClientRect()");
    expect(clickContract).toContain("document.elementFromPoint(centerX, centerY)");
    expect(clickContract).toContain("matches.length === 1");
    expect(clickContract).toContain("event.isTrusted");
    expect(clickContract).toContain("event.stopImmediatePropagation()");
    expect(clickContract).toContain("await page.mouse.click(pointerTarget.x, pointerTarget.y)");
    expect(clickContract).toContain("primaryActionTrustedPointerGuardDecision(guardResult)");
    expect(clickContract).toContain("lastUnsafeTargetError");
    expect(clickContract).toContain("page.waitForTimeout(Math.min(16, remainingMs))");
    expect(clickContract).toContain("totalTimeoutMs: primaryActionTimeoutMs");
    expect(clickContract).toContain("waitForNextObservation:");
    expect(clickContract).not.toContain("force: true");
    expect(clickContract).not.toContain("element.click()");
    expect(clickContract).not.toContain("scrollIntoView");
    expect(clickContract).not.toContain("dispatchEvent");
    expect(clickContract).not.toContain("runPrimaryActionProtocolWithinDeadline");
    expect(clickContract).not.toContain("Promise.race");
    expect(fixtureBrowserGate).not.toContain("真实主控件");
    expect(scenarioContract).toContain("const pendingRenderCheckpoint = contract.renderCheckpoints.find");
    expect(scenarioContract).toContain("const initialActionSnapshot = await readScenarioSnapshot(page)");
    expect(scenarioContract).toContain("clickCurrentPrimaryAction(page, initialActionLease)");
    expect(scenarioContract).not.toContain("spin.click(");
    expect(scenarioContract).toContain("renderCheckpointSignalMatches(snapshot, checkpoint)");
    expect(scenarioContract).toContain("const pendingInputLeaseCheckpoint = contract.renderCheckpoints.find");
    expect(scenarioContract).toContain("checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint)");
    expect(scenarioContract).toContain("if (pendingRenderCheckpoint || pendingInputLeaseCheckpoint) {");
    expect(scenarioContract).toContain("await page.waitForTimeout(16)");
    expect(scenarioContract).toContain("const actionLease = primaryActionLeaseFromSnapshot(snapshot)");
    expect(scenarioContract).toContain("const actionToken = primaryActionLeaseKey(actionLease)");
    expect(scenarioContract).toContain("clickCurrentPrimaryAction(page, actionLease)");
    expect(scenarioContract.indexOf("const pendingRenderCheckpoint"))
      .toBeLessThan(scenarioContract.indexOf("const shouldContinue"));
  });

  it("validates and observes only the fixture's bounded event history", () => {
    expect(visualFixtureEventHistoryLimit).toBe(VISUAL_FIXTURE_EVENT_HISTORY_LIMIT);
    expect(visualFixtureEventHistorySnapshotViolation({
      event: null,
      eventCount: 0,
      events: [],
    })).toBeNull();
    expect(visualFixtureEventHistorySnapshotViolation({ event: null, eventCount: 0 }))
      .toBe("event-history-structure");
    const healthy = {
      event: "vault.upgraded",
      eventCount: 2,
      events: ["vault.unlocked", "vault.upgraded"],
    };
    expect(visualFixtureEventHistorySnapshotViolation(healthy)).toBeNull();
    expect(visualFixtureEventHistorySnapshotViolation({ ...healthy, eventCount: 1 }))
      .toBe("event-history-count");
    expect(visualFixtureEventHistorySnapshotViolation({ ...healthy, event: "vault.unlocked" }))
      .toBe("event-history-current-last");
    expect(visualFixtureEventHistorySnapshotViolation({
      ...healthy,
      events: ["bad,event", "vault.upgraded"],
    }))
      .toBe("event-history-entry");
    expect(visualFixtureEventHistorySnapshotViolation({
      event: "wheel.started",
      eventCount: visualFixtureEventHistoryLimit + 1,
      events: Array.from(
        { length: visualFixtureEventHistoryLimit + 1 },
        () => "wheel.started",
      ),
    })).toBe("event-history-count");

    expect(fixtureBrowserGate).toContain(
      '/^(?:0|[1-9][0-9]*)$/.test(eventCountText)',
    );
    expect(fixtureBrowserGate).toContain("eventCount,");
    expect(fixtureBrowserGate).toContain(
      'events: document.body.dataset.fixtureEvents === undefined',
    );
    expect(fixtureBrowserGate).toContain('document.body.dataset.fixtureEvents.split(",")');
    const observeStart = fixtureBrowserGate.indexOf("function observeSnapshot");
    const observeEnd = fixtureBrowserGate.indexOf("function requireHealthySnapshot", observeStart);
    const observeContract = fixtureBrowserGate.slice(observeStart, observeEnd);
    expect(observeContract).toContain(
      "for (const event of snapshot.events) observed.events.add(event)",
    );
    expect(observeContract).not.toContain("snapshot.event) observed.events.add");
    expect(observeContract).not.toContain("requiredEvents");
    expect(fixtureBrowserGate).toContain(
      "visualFixtureEventHistorySnapshotViolation(snapshot)",
    );

    const scenarioStart = fixtureBrowserGate.indexOf("async function runScenario");
    const scenarioEnd = fixtureBrowserGate.indexOf("async function runBrowser", scenarioStart);
    const scenarioContract = fixtureBrowserGate.slice(scenarioStart, scenarioEnd);
    const initialSnapshotIndex = scenarioContract.indexOf(
      "const initialActionSnapshot = await readScenarioSnapshot(page)",
    );
    const initialHealthIndex = scenarioContract.indexOf(
      "requireHealthySnapshot(\n      initialActionSnapshot,",
      initialSnapshotIndex,
    );
    const initialClickIndex = scenarioContract.indexOf(
      "clickCurrentPrimaryAction(page, initialActionLease)",
      initialSnapshotIndex,
    );
    expect(initialSnapshotIndex).toBeGreaterThanOrEqual(0);
    expect(initialHealthIndex).toBeGreaterThanOrEqual(0);
    expect(initialClickIndex).toBeGreaterThanOrEqual(0);
    expect(initialHealthIndex).toBeGreaterThan(initialSnapshotIndex);
    expect(initialHealthIndex).toBeLessThan(initialClickIndex);

    const loopStart = scenarioContract.indexOf("while (true)");
    const loopEnd = scenarioContract.indexOf("if (!finalSnapshot)", loopStart);
    const loopContract = scenarioContract.slice(loopStart, loopEnd);
    const loopHealthIndex = loopContract.indexOf("requireHealthySnapshot(snapshot");
    const loopObserveIndex = loopContract.indexOf("observeSnapshot(observed, snapshot)");
    expect(loopHealthIndex).toBeGreaterThanOrEqual(0);
    expect(loopObserveIndex).toBeGreaterThanOrEqual(0);
    expect(loopHealthIndex).toBeLessThan(loopObserveIndex);

    const terminalStart = scenarioContract.indexOf(
      "finalSnapshot = terminalQuiescence.snapshot",
    );
    const terminalEnd = scenarioContract.indexOf(
      "await captureNewRenderCheckpoints",
      terminalStart,
    );
    const terminalContract = scenarioContract.slice(terminalStart, terminalEnd);
    const terminalHealthIndex = terminalContract.indexOf(
      "requireHealthySnapshot(finalSnapshot",
    );
    const terminalObserveIndex = terminalContract.indexOf(
      "observeSnapshot(observed, finalSnapshot)",
    );
    expect(terminalHealthIndex).toBeGreaterThanOrEqual(0);
    expect(terminalObserveIndex).toBeGreaterThanOrEqual(0);
    expect(terminalHealthIndex).toBeLessThan(terminalObserveIndex);
  });

  it("reports bounded first-failure provenance and drains late runtime errors on Node wall time", () => {
    for (const field of [
      "fixtureFailureSource",
      "fixturePlayerErrorCode",
      "fixtureFailureEvent",
      "fixtureFailureSequence",
    ]) {
      expect(fixtureBrowserGate.match(new RegExp(`dataset\\.${field}`, "g"))?.length ?? 0)
        .toBeGreaterThanOrEqual(2);
    }
    expect(fixtureBrowserGate).toContain("failureSource:");
    expect(fixtureBrowserGate).toContain("playerErrorCode:");
    expect(fixtureBrowserGate).toContain("failureEvent:");
    expect(fixtureBrowserGate).toContain("failureSequence:");

    const healthStart = fixtureBrowserGate.indexOf("async function requireHealthySnapshot");
    const healthEnd = fixtureBrowserGate.indexOf(
      "function requireNoRuntimeFailures",
      healthStart,
    );
    expect(healthStart).toBeGreaterThan(-1);
    expect(healthEnd).toBeGreaterThan(healthStart);
    const healthContract = fixtureBrowserGate.slice(healthStart, healthEnd);
    expect(fixtureBrowserGate).toContain("const fixtureFailureRuntimeDrainMs = 100");
    expect(healthContract).toContain('snapshot.fixtureStatus === "failed"');
    expect(healthContract).toContain("setTimeout(resolvePromise, fixtureFailureRuntimeDrainMs)");
    expect(healthContract).not.toContain("page.waitForTimeout");
    expect(healthContract).not.toContain("page.clock");
    expect(healthContract.indexOf("setTimeout(resolvePromise"))
      .toBeLessThan(healthContract.indexOf("requireNoRuntimeFailures("));
    expect(healthContract).toContain(
      'snapshot.fixtureStatus === "failed" ? snapshot : null',
    );

    const runtimeFailureStart = fixtureBrowserGate.indexOf(
      "function requireNoRuntimeFailures",
    );
    const runtimeFailureEnd = fixtureBrowserGate.indexOf(
      "async function clickCurrentPrimaryAction",
      runtimeFailureStart,
    );
    expect(runtimeFailureStart).toBeGreaterThan(-1);
    expect(runtimeFailureEnd).toBeGreaterThan(runtimeFailureStart);
    expect(runtimeFailureStart).toBeGreaterThanOrEqual(0);
    expect(runtimeFailureEnd).toBeGreaterThan(runtimeFailureStart);
    const runtimeFailureContract = fixtureBrowserGate.slice(
      runtimeFailureStart,
      runtimeFailureEnd,
    );
    expect(runtimeFailureContract).toContain("fixtureFailureSnapshot = null");
    expect(runtimeFailureContract).toContain("首次夹具失败快照");
    expect(runtimeFailureContract).toContain("JSON.stringify(fixtureFailureSnapshot)");

    const scenarioStart = fixtureBrowserGate.indexOf("async function runScenario");
    const scenarioEnd = fixtureBrowserGate.indexOf("function renderCheckpointKey", scenarioStart);
    const scenarioContract = fixtureBrowserGate.slice(scenarioStart, scenarioEnd);
    expect(scenarioContract.match(/await requireHealthySnapshot\(/g)).toHaveLength(3);
  });

  it("emits one guarded trusted pointer and observes exact lease consumption", async () => {
    const stableSnapshot = {
      sequence: "3",
      stage: "reels.settled",
      milestone: "wheel.summary-input-ready",
      milestoneCount: 8,
      event: "wheel.awarded",
      featureMode: "wheel-summary",
      spinAction: "continue",
      spinMode: "continue",
      spinDisabled: false,
    };
    const expectedLease = primaryActionLeaseFromSnapshot(stableSnapshot);
    expect(primaryActionLeaseKey(expectedLease)).toBe(
      '["3","reels.settled","wheel.summary-input-ready",8,"wheel.awarded",'
      + '"wheel-summary","continue","continue"]',
    );
    expect(primaryActionLeaseSelector(expectedLease)).toBe(
      'body[data-fixture-sequence="3"][data-fixture-stage="reels.settled"]'
      + '[data-fixture-milestone="wheel.summary-input-ready"]'
      + '[data-fixture-milestone-count="8"][data-fixture-event="wheel.awarded"] '
      + '[data-role="spin"][data-action="continue"][data-mode="continue"]',
    );
    expect(primaryActionLeaseMatchesSnapshot(expectedLease, stableSnapshot)).toBe(true);
    expect(primaryActionLeaseMatchesSnapshot(expectedLease, {
      ...stableSnapshot,
      milestoneCount: 9,
    })).toBe(false);
    expect(primaryActionLeaseMatchesSnapshot(expectedLease, {
      ...stableSnapshot,
      sequence: "4",
    })).toBe(false);
    expect(primaryActionLeaseMatchesSnapshot(expectedLease, {
      ...stableSnapshot,
      spinMode: "ready",
    })).toBe(false);
    expect(primaryActionLeaseMatchesSnapshot(expectedLease, {
      ...stableSnapshot,
      spinDisabled: true,
    })).toBe(false);

    const safePointerEvidence = {
      centerHitTarget: true,
      connected: true,
      disabled: false,
      display: "block",
      hidden: false,
      leaseMatched: true,
      matchCount: 1,
      opacity: 1,
      pointerEvents: "auto",
      rectangle: { height: 80, left: 120, top: 220, width: 100 },
      spinCount: 1,
      visibility: "visible",
      visibleAreaRatio: 1,
      viewport: { height: 720, width: 1280 },
    };
    expect(primaryActionTrustedPointerTarget(safePointerEvidence)).toEqual({ x: 170, y: 260 });
    expect(() => primaryActionTrustedPointerTarget({
      ...safePointerEvidence,
      matchCount: 2,
    })).toThrow("trusted pointer 目标不可安全点击");
    expect(() => primaryActionTrustedPointerTarget({
      ...safePointerEvidence,
      spinCount: 2,
    })).toThrow("trusted pointer 目标不可安全点击");
    expect(() => primaryActionTrustedPointerTarget({
      ...safePointerEvidence,
      centerHitTarget: false,
    })).toThrow("trusted pointer 目标不可安全点击");
    expect(() => primaryActionTrustedPointerTarget({
      ...safePointerEvidence,
      visibleAreaRatio: 0.994,
    })).toThrow("trusted pointer 目标不可安全点击");

    expect(primaryActionTrustedPointerGuardDecision({
      observed: true,
      isTrusted: true,
      leaseMatched: true,
      targetMatched: true,
    })).toBe("accepted");
    expect(primaryActionTrustedPointerGuardDecision({
      observed: true,
      isTrusted: true,
      leaseMatched: false,
      targetMatched: true,
    })).toBe("stale");
    expect(() => primaryActionTrustedPointerGuardDecision(null))
      .toThrow("事件未被租约守卫观察");
    expect(() => primaryActionTrustedPointerGuardDecision({
      observed: true,
      isTrusted: false,
      leaseMatched: true,
      targetMatched: true,
    })).toThrow("事件证据无效");
    expect(() => primaryActionTrustedPointerGuardDecision({
      observed: true,
      isTrusted: true,
      leaseMatched: false,
      targetMatched: false,
    })).toThrow("事件证据无效");

    let elapsedMs = 0;
    let attempts = 0;
    let observations = 0;
    const changedSnapshot = { ...stableSnapshot, milestoneCount: 9 };
    const observedSnapshots = [stableSnapshot, stableSnapshot, changedSnapshot];
    const consumed = await clickWithPrimaryActionLease({
      attemptClick: async () => {
        attempts += 1;
        return true;
      },
      expectedLease,
      now: () => elapsedMs,
      readSnapshot: async () => {
        observations += 1;
        return observedSnapshots.shift() ?? changedSnapshot;
      },
      totalTimeoutMs: 15_000,
      waitForNextObservation: async (delayMs) => { elapsedMs += delayMs; },
    });
    expect(consumed).toBe(true);
    expect(attempts).toBe(1);
    expect(observations).toBe(3);

    elapsedMs = 0;
    attempts = 0;
    const stale = await clickWithPrimaryActionLease({
      attemptClick: async () => {
        attempts += 1;
        return true;
      },
      expectedLease,
      now: () => elapsedMs,
      readSnapshot: async () => changedSnapshot,
      totalTimeoutMs: 15_000,
      waitForNextObservation: async (delayMs) => { elapsedMs += delayMs; },
    });
    expect(stale).toBe(false);
    expect(attempts).toBe(0);

    const blockedStaleEvent = await clickWithPrimaryActionLease({
      attemptClick: async () => false,
      expectedLease,
      readSnapshot: async () => stableSnapshot,
      totalTimeoutMs: 15_000,
      waitForNextObservation: async () => undefined,
    });
    expect(blockedStaleEvent).toBe(false);

    const unknownError = new Error("primary action was occluded");
    await expect(clickWithPrimaryActionLease({
      attemptClick: async () => { throw unknownError; },
      expectedLease,
      readSnapshot: async () => stableSnapshot,
      totalTimeoutMs: 15_000,
      waitForNextObservation: async () => undefined,
    })).rejects.toBe(unknownError);
    const readError = new Error("snapshot read failed");
    await expect(clickWithPrimaryActionLease({
      attemptClick: async () => true,
      expectedLease,
      readSnapshot: async () => { throw readError; },
      totalTimeoutMs: 15_000,
      waitForNextObservation: async () => undefined,
    })).rejects.toBe(readError);

    elapsedMs = 0;
    await expect(clickWithPrimaryActionLease({
      attemptClick: async () => true,
      expectedLease,
      now: () => elapsedMs,
      readSnapshot: async () => stableSnapshot,
      totalTimeoutMs: 32,
      waitForNextObservation: async (delayMs) => { elapsedMs += delayMs; },
    })).rejects.toThrow("trusted pointer 在 32ms 内未消费精确输入租约");
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
