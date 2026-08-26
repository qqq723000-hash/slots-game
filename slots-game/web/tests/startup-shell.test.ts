import { describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import bootstrapSource from "../src/bootstrap.ts?raw";
import mainSource from "../src/main.ts?raw";
import controllerSource from "../src/app/AppController.ts?raw";
import overlaySource from "../src/ui/DomOverlay.ts?raw";
import { DomOverlay } from "../src/ui/DomOverlay";
import type { PreloadProgress } from "../src/startup/PreloadGate";

describe("startup shell contract", () => {
  it("ships a visible loader in server HTML before the application module runs", () => {
    expect(indexHtml).toContain('data-startup-shell="paint-pending"');
    expect(indexHtml).toContain('data-role="launch-loading"');
    expect(indexHtml).toContain('data-visible="true"');
    expect(indexHtml.indexOf('data-role="launch-loading"'))
      .toBeLessThan(indexHtml.indexOf('src="/src/bootstrap.ts"'));
    expect(bootstrapSource).toContain('import("./main")');
  });

  it("waits for the painted-frame gate before constructing Pixi", () => {
    expect(mainSource).toContain("waitForPaintedFrame().then");
    expect(mainSource).toContain('await import("./app/AppController")');
    expect(mainSource.indexOf("waitForPaintedFrame().then"))
      .toBeLessThan(mainSource.indexOf('await import("./app/AppController")'));
    expect(mainSource.indexOf('await import("./app/AppController")'))
      .toBeLessThan(mainSource.indexOf("await ApplicationController.create"));
  });

  it("wires browser availability and unload cleanup without destroying a BFCache session", () => {
    expect(mainSource).toContain('window.addEventListener("online", syncRuntimeAvailability)');
    expect(mainSource).toContain('window.addEventListener("offline", syncRuntimeAvailability)');
    expect(mainSource).toContain('document.addEventListener("visibilitychange", syncRuntimeAvailability)');
    expect(mainSource).toContain('window.addEventListener("pageshow", handlePageShow)');
    expect(mainSource).toContain('window.addEventListener("pagehide", handlePageHide)');
    expect(mainSource).toContain("if (event.persisted)");
    expect(mainSource).toContain("runtimeAvailability(false)");
    expect(mainSource).toContain('disposeApplication("Application page was unloaded")');
    expect(mainSource).toContain("ownedGateway?.close()");
    expect(mainSource).toContain('disposeApplication("Application launch failed")');
    expect(mainSource).toContain("configuredGateway = null");
  });

  it("不会把渲染装配故障误报为运营方会话失效", () => {
    expect(mainSource).toContain(
      "presentStartupFailure(\n      error,\n      false,\n      operatorHostOrigin,",
    );
    expect(mainSource).not.toContain(
      'launchGateway.initialSessionRecoveryMode === "operator-session"',
    );
  });

  it("在创建渲染器前启用严格 CSP 兼容的 Pixi 同步器", () => {
    const configure = mainSource.indexOf("configurePixiContentSecurityPolicy()");
    const create = mainSource.indexOf("await ApplicationController.create");
    expect(configure).toBeGreaterThanOrEqual(0);
    expect(configure).toBeLessThan(create);
  });

  it("mounts shell and overlay before constructing final renderer owners across frames", () => {
    const shell = controllerSource.indexOf('"shell-mounted",\n        () => mountApplicationShell');
    const overlay = controllerSource.indexOf('"overlay-mounted",\n        () =>');
    const renderer = controllerSource.indexOf("await PixiRenderer.createStaged");
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(shell).toBeLessThan(overlay);
    expect(overlay).toBeLessThan(renderer);
    expect(controllerSource.match(/await buildPaintedStartupStage/g)).toHaveLength(2);
    expect(controllerSource).toContain("onStage: (event) =>");
    expect(controllerSource).toContain('markStartupAssembly(root, "renderer-mounted", 0.05)');
    expect(controllerSource.indexOf("await PixiRenderer.createStaged"))
      .toBeLessThan(controllerSource.indexOf('markStartupAssembly(root, "renderer-mounted", 0.05)'));
    expect(controllerSource).toContain('name: "critical-dom-readiness"');
    expect(controllerSource).toContain('stage: "assets"');
    expect(controllerSource).toContain('stage: "gpu-warmup"');
  });

  it("keeps the live loading surface in viewport space before responsive frame layout", () => {
    expect(controllerSource).toContain('const launchHost = document.createElement("div")');
    expect(controllerSource).toContain('launchHost.className = "launch-loading-host"');
    expect(controllerSource).toContain('launchHost.dataset.role = "launch-host"');
    expect(controllerSource).toContain("shell.launchHost.appendChild(serverLoader)");
    expect(controllerSource).toContain("overlay.mountLaunchLoading(shell.launchHost)");
    expect(controllerSource).not.toContain("shell.overlayHost.appendChild(serverLoader)");
  });

  it("measures a safe-area outer shell and keeps the authored frame as its only scaled child", () => {
    expect(controllerSource).toContain('const safeArea = document.createElement("div")');
    expect(controllerSource).toContain('safeArea.className = "game-safe-area"');
    expect(controllerSource).toContain('safeArea.dataset.role = "safe-area"');
    expect(controllerSource).toContain("root.replaceChildren(viewport)");
    expect(controllerSource).toContain("new ResponsiveLayout(shell.safeArea ?? shell.viewport");
    expect(controllerSource).not.toContain("|| window.innerWidth");
    expect(controllerSource).not.toContain("|| window.innerHeight");
  });

  it("freezes asset selection without freezing the live responsive layout channel", () => {
    expect(controllerSource).toContain("setPrimalRuntimeAssetChannel(assetChannel)");
    expect(controllerSource).toContain("channel: responsiveLayoutChannel(viewportWidth, viewportHeight");
    expect(controllerSource).toContain(
      "this.layout = new ResponsiveLayout(shell.safeArea ?? shell.viewport, frame",
    );
    expect(controllerSource).toContain("this.ui.setResponsiveLayout(snapshot)");
    expect(controllerSource).toContain(
      "this.ui.onHandModeChange((handMode) => this.layout.setHandMode(handMode))",
    );
    expect(controllerSource).not.toContain("}, { channel: assetChannel });");
  });

  it("keeps true 100% visible through a painted frame before launch", () => {
    const preload = controllerSource.indexOf("await this.preload.run");
    const complete = controllerSource.indexOf(
      'this.root.dataset.startupReadiness = "complete"',
      preload,
    );
    const paint = controllerSource.indexOf("await waitForPaintedFrame", complete);
    const transition = controllerSource.indexOf(
      'this.launch.transition({ type: "PRELOAD_COMPLETE" })',
      paint,
    );
    expect(preload).toBeGreaterThanOrEqual(0);
    expect(preload).toBeLessThan(complete);
    expect(complete).toBeLessThan(paint);
    expect(paint).toBeLessThan(transition);
    expect(controllerSource).toContain("startupReadinessCompleteAt");
    expect(controllerSource).toContain("startupReadinessPaintedAt");
    expect(controllerSource).toContain("startupInitialRendererWidth");
    expect(controllerSource).toContain("startupInitialRendererHeight");
  });

  it("publishes the current stage and numeric progress for browser observation", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const host = { dataset: {} as Record<string, string> };
    const loading = { dataset: {} as Record<string, string> };
    const loadingBar = { style: { transform: "" } };
    const loadingTrack = { setAttribute: vi.fn() };
    const loadingStatus = { textContent: "" };
    const loadingValue = { textContent: "" };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      host,
      loading,
      loadingBar,
      loadingTrack,
      loadingStatus,
      loadingValue,
    });
    const progress: PreloadProgress = {
      stage: "assets",
      taskName: "entry-critical-resources",
      status: "running",
      taskFraction: 0.5,
      completedWeight: 45,
      totalWeight: 100,
      progress: 0.45,
    };

    overlay.setStartupProgress(progress);

    expect(host.dataset.launchStage).toBe("assets");
    expect(host.dataset.launchProgress).toBe("0.450000");
    expect(loading.dataset).toMatchObject({
      stage: "assets",
      task: "entry-critical-resources",
    });
    expect(loadingStatus.textContent).toBe("Loading game resources");
    expect(loadingValue.textContent).toBe("45%");
    expect(loadingBar.style.transform).toBe("scaleX(0.45)");
    expect(loadingTrack.setAttribute).toHaveBeenCalledWith("aria-valuenow", "45");
  });

  it("exposes determinate progress semantics in the pre-module and live loading shells", () => {
    for (const source of [indexHtml, overlaySource]) {
      expect(source).toContain('role="progressbar"');
      expect(source).toContain('aria-valuemin="0"');
      expect(source).toContain('aria-valuemax="100"');
      expect(source).toContain('aria-valuenow="0"');
    }
  });

  it("keeps the regular desktop intro skippable internally but hides its invented Skip Intro control", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const host = { dataset: {} as Record<string, string> };
    const loading = {
      dataset: {} as Record<string, string>,
      setAttribute: () => undefined,
    };
    const skip = { hidden: false };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      host,
      loading,
      hudElements: [],
      statusPanel: { inert: false, focus: () => undefined },
      spinDock: { inert: false },
      toolStrip: { inert: false },
      skip,
      setBetPopupOpen: () => undefined,
      setAutoplayModalOpen: () => undefined,
      setGameMenuOpen: () => undefined,
      stopAutoplay: () => undefined,
      setHudReveal: () => undefined,
    });

    vi.stubGlobal("document", { activeElement: null });
    try {
      overlay.setLaunchPhase("intro");

      expect(host.dataset.launch).toBe("intro");
      expect(skip.hidden).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not ask the normal AppController launch flow to expose Skip Intro", () => {
    expect(controllerSource).toContain("this.ui.setLaunchPhase(phase, false)");
    expect(controllerSource).not.toContain(
      'phase === "intro" && !this.reducedMotion && !this.featurePreviewActive',
    );
  });
});
