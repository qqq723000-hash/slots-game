import { describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import bootstrapSource from "../src/bootstrap.ts?raw";
import mainSource from "../src/main.ts?raw";
import controllerSource from "../src/app/AppController.ts?raw";
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
    expect(controllerSource).toContain('class="launch-loading-host" data-role="launch-host"');
    expect(controllerSource).toContain('launchHost: requireRole("launch-host")');
    expect(controllerSource).toContain("shell.launchHost.appendChild(serverLoader)");
    expect(controllerSource).toContain("overlay.mountLaunchLoading(shell.launchHost)");
    expect(controllerSource).not.toContain("shell.overlayHost.appendChild(serverLoader)");
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
    const loadingStatus = { textContent: "" };
    const loadingValue = { textContent: "" };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      host,
      loading,
      loadingBar,
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
