// @ts-nocheck -- 该契约读取源码文件并验证构建期配置，不进入浏览器类型域。 / English: @ts-nocheck -- This contract reads source code files and verifies build-time configuration without entering the browser type domain.
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateProductionBrowserTimingBudget } from "../scripts/browser-rendering-contract.mjs";
import viteConfiguration, { PRODUCTION_BROWSER_TARGETS } from "../vite.config";

const EXPECTED_TARGETS = [
  "chrome111",
  "edge111",
  "firefox114",
  "safari16.4",
  "ios16.4",
];

describe("production browser support contract", () => {
  it("pins the documented JavaScript and CSS compilation targets", () => {
    expect(PRODUCTION_BROWSER_TARGETS).toEqual(EXPECTED_TARGETS);
    expect(viteConfiguration.build?.target).toEqual(EXPECTED_TARGETS);
    expect(viteConfiguration.build?.cssTarget).toEqual(EXPECTED_TARGETS);
  });

  it("does not depend on the later Firefox :has selector implementation", async () => {
    const source = await readFile(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    expect(source).not.toContain(":has(");
    expect(source).toContain('.autoplay-stop-condition.is-disabled');
    expect(source).toContain('classList.toggle("is-disabled", active)');
  });

  it("observes CSP violations and owns browser resources inside cleanup boundaries", async () => {
    const source = await readFile(
      new URL("../scripts/verify-production-cross-browser.mjs", import.meta.url),
      "utf8",
    );
    const verifyStart = source.indexOf("async function verifyBrowser(");
    const cleanupTry = source.indexOf("try {", verifyStart);
    const launch = source.indexOf("browser = await browserType.launch(", verifyStart);
    const context = source.indexOf("context = await browser.newContext(", verifyStart);
    const probe = source.indexOf(
      "await context.addInitScript({ content: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE })",
      verifyStart,
    );
    const page = source.indexOf("const page = await context.newPage()", verifyStart);

    expect(cleanupTry).toBeGreaterThan(verifyStart);
    expect(cleanupTry).toBeLessThan(launch);
    expect(launch).toBeLessThan(context);
    expect(context).toBeLessThan(probe);
    expect(probe).toBeLessThan(page);
    expect(source).toContain('resolveBrowserRenderingContract({ browserName })');
    expect(source).toContain("...renderingContract.launchOptions");
    expect(source).toContain("renderingMode: renderingContract.renderingMode");
    expect(source).toContain("globalThis.__slotsContentSecurityPolicyProbe?.violations");
    expect(source).toContain("!Array.isArray(cspViolations) || cspViolations.length !== 0");
    expect(source).toContain("await context?.close().catch(() => undefined)");
    expect(source).toContain("await browser?.close().catch(() => undefined)");
    expect(source).toContain('canvas.getContext("webgl2")');
    expect(source).toContain("initialCanvas.maximumTextureSize < 4_096");
    expect(source).not.toContain("maximumTextureSize: 4_096");
  });

  it("bounds the slower CI feature-preview startup and preserves safe timeout diagnostics", async () => {
    const source = await readFile(
      new URL("../scripts/verify-production-cross-browser.mjs", import.meta.url),
      "utf8",
    );
    expect(validateProductionBrowserTimingBudget({
      featurePreviewStartupTimeoutMs: 90_000,
      maximumFeaturePreviewStartupTimeoutMs: 2 * 60_000,
    })).toEqual({ featurePreviewStartupTimeoutMs: 90_000 });
    expect(() => validateProductionBrowserTimingBudget({
      featurePreviewStartupTimeoutMs: 2 * 60_000,
      maximumFeaturePreviewStartupTimeoutMs: 2 * 60_000,
    })).toThrow("启动截止必须小于两分钟上限");
    expect(source).toContain("const featurePreviewStartupTimeoutMs = 90_000");
    expect(source).toContain("const maximumFeaturePreviewStartupTimeoutMs = 2 * 60_000");
    expect(source).toContain("{ timeout: featurePreviewStartupTimeoutMs }");
    expect(source).toContain("timeoutCause = error");
    expect(source).toContain("domReadiness:");
    expect(source).toContain("readinessProgress:");
    expect(source).toContain("readinessStage:");
    expect(source).toContain("runtimeErrorCount: runtimeErrors.length");
    expect(source).toContain("transportErrorCount: transportErrors.length");
    expect(source).toContain("...diagnostic");
    expect(source).toContain("Feature Preview 未在 ${featurePreviewStartupTimeoutMs}ms 内就绪");
  });

  it("redacts every startup failure channel and locks the 390x844 bottom geometry", async () => {
    const source = await readFile(
      new URL("../scripts/verify-production-cross-browser.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain('page.on("console"');
    expect(source).toContain('page.on("pageerror"');
    expect(source).toContain('page.on("requestfailed"');
    expect(source).toContain('page.on("crash"');
    expect(source).toContain('context.on("weberror"');
    expect(source).toContain("recordCredentialLeakLabels(");
    expect(source).toContain("diagnosticEventCounts.requestfailed !== expectedRequestFailedCount");
    expect(source).not.toContain("consoleMessages");
    expect(source).toContain('"__slotsEarlyLaunchHandoff"');
    expect(source).toContain('"__slotsBrowserPreflight"');
    expect(source).toContain('shell?.earlyHandoff?.state === "missing"');
    expect(source).toContain('shell.earlyHandoff.state === "exhausted"');
    expect(source).toContain('shell.browserHandoff.state === "exhausted"');
    expect(source).toContain('shell.hash !== ""');
    expect(source).toContain('id="launch-fragment-scrub"');
    expect(source).toContain("inlineScrubRemovalCount !== Number(removeInlineScrub)");
    expect(source).toContain("rgsRequests.length !== 0");
    expect(source).toContain("mainModuleRequests.length !== 0");

    expect(source).toContain("frameBottomMinimum: 843");
    expect(source).toContain("frameBottomExpected: 844");
    expect(source).toContain("spinBottomMinimum: 680.5");
    expect(source).toContain("spinBottomExpected: 638.36328125 + 85.91 / 2");
    expect(source).toContain("mobileGeometry.frameScale");
    expect(source).toContain("mobileGeometry.spinBottom");
    expect(source).toContain("mobileGeometry.spinHeight");

    expect(source).toContain('document.querySelector(".game-menu__content")');
    expect(source).toContain("measureStablePaytableBottom(page, browserName)");
    expect(source).toContain("scrollContainer.scrollHeight > scrollContainer.clientHeight");
    expect(source).toContain("projectionRect.height > scrollContainer.clientHeight");
    expect(source).toContain("stableFrames >= 2");
    expect(source).toContain("scrollContainer.scrollTop = scrollContainer.scrollHeight");
    expect(source).toContain("paytableBottom.maximumScrollTop <= 0");
    expect(source).not.toContain("viewport.scrollTop = viewport.scrollHeight");
  });
});
