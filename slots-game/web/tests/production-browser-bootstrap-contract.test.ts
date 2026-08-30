// @ts-nocheck -- 该契约测试需要在 Node 中读取构建配置与仓库级门禁文件。 / English: @ts-nocheck -- This contract test needs to read the build configuration and warehouse-level access control files in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

interface ChunkGroup {
  readonly name: string | ((moduleID: string) => string | undefined);
  readonly test?: string | RegExp | ((moduleID: string) => boolean);
  readonly priority?: number;
  readonly maxSize?: number;
}

const configObject = typeof config === "function"
  ? config({ command: "build", mode: "production", isSsrBuild: false, isPreview: false })
  : config;
const output = configObject.build?.rolldownOptions?.output;
if (Array.isArray(output)) throw new Error("生产构建不得使用多套输出分块配置");
const splitting = output?.codeSplitting;
if (!splitting || typeof splitting !== "object") throw new Error("生产构建缺少显式分块配置");
const groups = (splitting.groups ?? []) as ChunkGroup[];

function matchingGroup(moduleID: string): ChunkGroup | undefined {
  return groups
    .filter((group) => matches(group.test, moduleID))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0];
}

function matches(test: ChunkGroup["test"], moduleID: string): boolean {
  if (test === undefined) return true;
  if (typeof test === "string") return moduleID.includes(test);
  if (test instanceof RegExp) return test.test(moduleID);
  return test(moduleID);
}

function chunkName(group: ChunkGroup | undefined, moduleID: string): string | undefined {
  if (!group) return undefined;
  return typeof group.name === "function" ? group.name(moduleID) : group.name;
}

describe("production browser bootstrap contract", () => {
  it("keeps initialization-sensitive dependency families in unsliced chunks", () => {
    const pixiSettings = "/repo/node_modules/@pixi/settings/dist/esm/settings.mjs";
    const pixiDisplay = "/repo/node_modules/@pixi/display/dist/esm/display.mjs";
    const spineBase = "/repo/node_modules/@pixi-spine/base/lib/index.js";
    const spineRuntime = "/repo/node_modules/@pixi-spine/runtime-4.1/lib/index.js";
    const renderer = "/repo/src/renderer/GameRenderer.ts";
    const reels = "/repo/src/reels/ReelController.ts";

    for (const [left, right, expectedName] of [
      [pixiSettings, pixiDisplay, "vendor-pixi"],
      [spineBase, spineRuntime, "vendor-pixi-spine"],
      [renderer, reels, "game-rendering"],
    ] as const) {
      const leftGroup = matchingGroup(left);
      const rightGroup = matchingGroup(right);
      expect(leftGroup).toBe(rightGroup);
      expect(chunkName(leftGroup, left)).toBe(expectedName);
      expect(leftGroup?.maxSize).toBeUndefined();
    }
  });

  it("retains the bounded split for modules outside known dependency cycles", () => {
    const protocol = "/repo/src/protocol/RgsGateway.ts";
    const protocolConstants = "/repo/src/protocol/protocolConstants.ts";
    const presentationQueue = "/repo/src/presentation/PresentationQueue.ts";
    const group = matchingGroup(protocol);
    expect(chunkName(group, protocol)).toBe("game-protocol");
    expect(chunkName(matchingGroup(protocolConstants), protocolConstants)).toBe("game-protocol");
    expect(chunkName(matchingGroup(presentationQueue), presentationQueue)).toBe("game-app");
    expect(group?.maxSize).toBe(450_000);
  });

  it("enforces the complete production static chunk graph", () => {
    const checker = readFileSync(
      new URL("../scripts/verify-production-javascript-bundles.mjs", import.meta.url),
      "utf8",
    );
    const contract = readFileSync(
      new URL("../scripts/production-javascript-import-contract.mjs", import.meta.url),
      "utf8",
    );

    expect(checker).toContain("assertAcyclicStaticChunkGraph(artifacts)");
    expect(contract).toContain('from "es-module-lexer"');
    expect(contract).toContain("stronglyConnectedComponents");
    expect(contract).toContain("生产 JavaScript 静态分块图存在循环依赖");
  });

  it("wires the real-browser transaction gate into package, local verification and CI", () => {
    const packageJSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");
    const workflow = readFileSync(
      new URL("../../../.github/workflows/frontend-conformance.yml", import.meta.url),
      "utf8",
    );
    const smoke = readFileSync(
      new URL("../scripts/verify-production-browser-bootstrap.mjs", import.meta.url),
      "utf8",
    );
    const transactionFixture = readFileSync(
      new URL("../scripts/production-browser-transaction-fixture.mjs", import.meta.url),
      "utf8",
    );
    const runtimeProbe = readFileSync(
      new URL("../scripts/production-browser-runtime-probe.mjs", import.meta.url),
      "utf8",
    );
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const sharedPolicy = readFileSync(
      new URL("../../deploy/web/content-security-policy.mjs", import.meta.url),
      "utf8",
    );

    expect(packageJSON.scripts["build:browser-smoke"])
      .toBe("node scripts/verify-production-browser-bootstrap.mjs");
    expect(makefile).toContain("verify-web-browser-bootstrap:");
    expect(makefile).toContain("npm run build:browser-smoke");
    expect(workflow).toContain("Verify production transaction in real Chrome");
    expect(workflow).toContain("npm run build:browser-smoke");
    expect(workflow).toContain("VITE_RGS_BASE_URL: https://rgs.ci.invalid");
    expect(workflow).not.toContain("https://rgs.ci.invalid/client/v1");
    expect(smoke).toContain('"--headless=new"');
    expect(smoke).toContain('"--disable-breakpad"');
    expect(smoke).toContain('send("Runtime.evaluate"');
    expect(smoke).toContain("await import(url)");
    expect(smoke).toContain('if (releasePath.startsWith("assets/"))');
    expect(smoke).toContain("禁止在此用 import() 二次执行");
    expect(smoke).toContain('from "../../deploy/web/content-security-policy.mjs"');
    expect(smoke).toContain('"Content-Security-Policy": browserContentSecurityPolicy');
    expect(smoke).toContain("CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE");
    expect(sharedPolicy).toContain("securitypolicyviolation");
    expect(sharedPolicy).toContain("safeTrustedTypesSink");
    expect(sharedPolicy).toContain("safeSourceFile");
    expect(smoke).toContain("trustedTypesSink");
    expect(smoke).toContain("result.cspViolations.length > 0");
    expect(smoke).toContain("result.trustedTypesEvidence?.enforcementSupported !== true");
    expect(smoke).toContain("source: TRUSTED_TYPES_POLICY_OBSERVATION_PROBE_SOURCE");
    expect(smoke.indexOf("source: TRUSTED_TYPES_POLICY_OBSERVATION_PROBE_SOURCE"))
      .toBeLessThan(smoke.indexOf("source: CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE"));
    expect(smoke).toContain("result.trustedTypesEvidence?.observerInstalled !== true");
    expect(smoke).toContain("result.trustedTypesEvidence?.staticHtmlPolicyNameObserved !== true");
    expect(smoke).toContain("result.trustedTypesEvidence?.staticHtmlPolicyCreateCount !== 1");
    expect(smoke).toContain("result.trustedTypesEvidence?.unexpectedPolicyCreateCount !== 0");
    expect(smoke).toContain("result.trustedTypesEvidence?.policyObservationCapabilityFree !== true");
    expect(smoke).toContain("result.trustedTypesEvidence?.policyObservationGlobalLocked !== true");
    expect(smoke).toContain("!Reflect.has(policyObservation, 'policy')");
    expect(smoke).toContain("!Reflect.has(policyObservation, 'factory')");
    expect(smoke).toContain("!Reflect.has(policyObservation, 'createPolicy')");
    expect(smoke).toContain("!Reflect.has(policyObservation, 'createHTML')");
    expect(smoke).not.toContain("slots-game.static-html-policy.v1");
    expect(smoke).not.toContain("staticHtmlMarker");
    expect(smoke).not.toContain("?.policy?.createHTML");
    expect(smoke).toContain("cspViolationCount: result.cspViolations.length");
    expect(smoke).toContain("policyCreateCount: result.trustedTypesEvidence.staticHtmlPolicyCreateCount");
    expect(smoke).toContain("acknowledgementCount: transactionEvidence.acknowledgementCount");
    expect(smoke).toContain('deliveryStages: ["decode-complete", "controller-dispatch", "callback", "accepted"]');
    expect(smoke).toContain("webgl: result.rendererEvidence?.webgl === true");
    expect(smoke).toContain("result.runtimeDiagnostics.fatalCount > 0");
    expect(smoke).toContain("await setBrowserProbePhase(send, \"mobile-matrix\")");
    expect(smoke).toContain("await setBrowserProbePhase(send, \"transaction-settle\")");
    expect(runtimeProbe).toContain("RESIZE_OBSERVER_LOOP");
    expect(runtimeProbe).toContain("FEATURE_PREVIEW_STORAGE_UNAVAILABLE");
    expect(runtimeProbe).toContain("droppedCount");
    expect(runtimeProbe).not.toContain("event.error.stack");
    expect(runtimeProbe).not.toContain("event.reason.message");
    expect(smoke).toContain('send("Network.enable")');
    expect(smoke).toContain('send("Fetch.enable", {');
    expect(smoke).toContain('send("Fetch.fulfillRequest", {');
    expect(smoke).toContain("const CONTINUOUS_VIEWPORTS = Object.freeze([");
    for (const [width, height] of [
      [360, 640],
      [375, 812],
      [390, 844],
      [393, 852],
      [412, 915],
      [600, 960],
      [633, 844],
      [768, 1_024],
      [800, 1_280],
      [844, 390],
      [1_024, 600],
      [1_024, 768],
      [1_366, 1_024],
      // 病态纵横比必须走等比黑边，不能为了填满而拉伸。 / English: The pathological aspect ratio must be proportional to the black border, and cannot be stretched to fill it up.
      [320, 1_000],
      [1_200, 300],
    ] as const) {
      expect(smoke).toContain(`Object.freeze({ width: ${width.toLocaleString("en-US")
        .replaceAll(",", "_")}, height: ${height.toLocaleString("en-US")
        .replaceAll(",", "_")} })`);
    }
    expect(smoke).not.toContain("MOBILE_VIEWPORT_SURFACES");
    expect(smoke).toContain("responsiveSurfaceForViewport");
    expect(smoke).toContain("MOBILE_DESIGN_LONG_EDGE * designAspect");
    expect(smoke).toContain("MOBILE_DESIGN_LONG_EDGE / designAspect");
    expect(smoke).toContain('send("Emulation.setDeviceMetricsOverride", {');
    expect(smoke).toContain('send("Emulation.setTouchEmulationEnabled", {');
    expect(smoke).toContain("verifyContinuousViewportTransitions");
    expect(smoke).toContain("assertMobileControlLayout");
    expect(smoke).toContain("statusScrollHeight");
    expect(smoke).toContain('const MAXIMUM_STATUS_VALUE = "92233720368547758.07";');
    expect(smoke).toContain("panel.dataset.moneyDensity = 'extreme'");
    expect(smoke).toContain("verifyMaximumStatusValues");
    expect(smoke).toContain("value.scrollWidth > value.clientWidth + 1");
    expect(smoke).toContain("最大 int64 Balance/Bet/Win 在移动状态栏中互相覆盖");
    expect(smoke).toContain("verifyOfficialHelpLayout");
    expect(smoke).toContain("verifyOfficialHelpBottomLayout");
    expect(smoke).toContain("verifyBoundGameRulesLayout");
    expect(smoke).toContain("step.paytableBottomVisible !== true");
    expect(smoke).toContain("step.gameRulesBound !== true");
    expect(smoke).toContain("step.gameRulesBottomVisible !== true");
    expect(smoke).toContain("horizontalOverflowDataset");
    expect(smoke).toContain("createPresentationApprovedFixture");
    expect(smoke).toContain("verifyOpeningOverlayLayout");
    const overlayVerification = smoke.indexOf("const openingOverlayVerification = await verifyOpeningOverlayLayout(");
    const fastPathNavigationGuard = smoke.indexOf(
      "if (executionContextsCleared !== expectedExecutionContextsCleared)",
      overlayVerification,
    );
    const openingReadyFastPath = smoke.indexOf(
      "let browserState = openingOverlayVerification?.browserState",
      overlayVerification,
    );
    expect(fastPathNavigationGuard).toBeGreaterThan(overlayVerification);
    expect(fastPathNavigationGuard).toBeLessThan(openingReadyFastPath);
    expect(smoke).toContain("featurePreview=force");
    expect(smoke).toContain("const overlayDeadline = Date.now() + startupTimeoutMs");
    expect(smoke).toContain("controlled-transaction-fixture-feature-mode-none");
    expect(smoke).toContain("blackBorderClickCount");
    expect(smoke).toContain("frame.dataset.reelRoundId");
    expect(smoke).toContain("channel=desktop");
    expect(smoke).not.toContain("mobilePageUrl");
    expect(smoke.match(/send\("Page\.navigate"/g) ?? []).toHaveLength(1);
    expect(smoke).toContain("viewportEvidence");
    expect(smoke).toContain("layoutTransitionEvidence");
    expect(smoke).toContain("documentIdentityToken");
    expect(smoke).toContain("assertTransactionStatePreserved");

    const touchEnabled = smoke.indexOf("await setTouchLayoutCapability(send, true);");
    const mobileMatrix = smoke.indexOf("const mobileViewportEvidence =", touchEnabled);
    const touchDisabled = smoke.indexOf("await setTouchLayoutCapability(send, false);", mobileMatrix);
    const desktopMatrix = smoke.indexOf("const desktopViewportEvidence =", touchDisabled);
    const transactionArm = smoke.indexOf("await armTransactionObservation(send);", desktopMatrix);
    expect(touchEnabled).toBeGreaterThan(-1);
    expect(mobileMatrix).toBeGreaterThan(touchEnabled);
    expect(touchDisabled).toBeGreaterThan(mobileMatrix);
    expect(desktopMatrix).toBeGreaterThan(touchDisabled);
    expect(transactionArm).toBeGreaterThan(desktopMatrix);
    expect(smoke).toContain("createControlledRgsTransactionFixture");
    expect(transactionFixture).toContain("sessions/exchange");
    expect(transactionFixture).toContain("sessions/status");
    expect(transactionFixture).toContain("slots-game-ways3-features-win-cap-paid-facts-v6");
    expect(transactionFixture).toContain("client/v1/spins");
    expect(transactionFixture).toContain("results/acknowledgements");
    expect(smoke).toContain("decode-complete");
    expect(smoke).toContain("controller-dispatch");
    expect(smoke).toContain("OPERATOR_SESSION_REQUIRED");
    expect(smoke).toContain("operatorSessionRequests.length > 0");
    expect(smoke).toContain('finalState.balance !== "8.50"');
    expect(smoke).toContain('finalState.lastWin !== "0.50"');
    expect(smoke).toContain('finalState.reelState !== "Idle"');
    expect(smoke).toContain('finalState.spinMode !== "ready"');
    expect(smoke).toContain("transactionEvidence.acknowledgementCount !== 1");
    expect(smoke).toContain('send("Page.captureScreenshot", {');
    expect(smoke).toContain('createHash("sha256")');
    expect(smoke).toContain("activeReelState === \"Idle\"");
    expect(smoke).toContain("baselineDigest");
    expect(smoke).toContain("activeDigest");
    expect(smoke).toContain("finalDigest");
    expect(smoke).toContain("verifyEmbeddedBuildConfiguration");
    expect(smoke).toContain("result.rendererReady");
    expect(smoke).toContain("canvas.getContext('webgl2')");
    expect(smoke).toContain("static-uniform-sync");
    expect(smoke).toContain("const startupTimeoutMs = 30_000;");
    expect(smoke).toContain(
      "const commandTimeoutMs = Math.max(startupTimeoutMs, transactionTimeoutMs) + 5_000;",
    );
    expect(smoke).toContain("diagnostics: state?.diagnostics ?? null");
    expect(smoke).not.toContain('"--disable-gpu"');
    expect(smoke).toContain('process.platform === "linux"');
    expect(smoke).toContain('"--enable-unsafe-swiftshader"');
    expect(main).toContain('applicationRoot.dataset.pixiCspMode = "static-uniform-sync"');
    expect(smoke).not.toContain("'unsafe-eval'");
    expect(sharedPolicy).not.toContain("'unsafe-eval'");
    expect(sharedPolicy).toContain('Object.freeze(["trusted-types", Object.freeze(["slots-game-static-html"])])');
    expect(sharedPolicy).toContain('Object.freeze(["require-trusted-types-for", Object.freeze(["\'script\'"])])');
    expect(smoke).toContain("await waitForProcessExit(browser, 2_000)");
    expect(smoke).toContain("await cleanupBrowserResources({");
    expect(smoke).toContain("browser.stderr?.destroy()");
    expect(smoke).toContain("serverValue.closeAllConnections?.()");
    expect(smoke.indexOf("await cleanupBrowserResources({"))
      .toBeLessThan(smoke.indexOf("生产浏览器事务门禁通过"));
    expect(smoke).toContain("maxRetries: 10");
    expect(smoke).toContain("retryDelay: 100");
  });
});
